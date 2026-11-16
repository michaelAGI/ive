// Mobile chat scroll/reflow checks with isolated messages and transport.
// Chromium drives trusted touch gestures; desktop WebKit's automation only
// exposes taps, so there we exercise the native scroll container directly.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const id = 'chat-scroll'
const selector = `[data-session-scroll="${id}"]`

async function setup(t) {
  const browser = await ({ chromium, webkit }[engine]).launch()
  t.after(() => browser.close())
  const messages = Array.from({ length: 36 }, (_, i) => ({
    id: `message-${i}`, session_id: id, role: i % 2 ? 'assistant' : 'user',
    content: `Message ${i + 1}: This is a longer conversation for checking phone scrolling.\n\nThe history must remain readable while a new reply arrives.`,
    created_at: new Date(Date.parse('2026-11-16T09:00:00Z') + i * 60000).toISOString(),
  }))
  const f = await createTourFixture(browser, {
    dist: process.env.IVE_TEST_DIST, width: 390, height: 844, touch: true,
    settings: { product_tour_version: '99' },
    workspaces: [{ id: 'w', name: 'Chat scroll test', path: '/isolated/chat-scroll' }],
    sessions: [{ id, name: 'Chat scroll test', workspace_id: 'w', cli_type: 'claude', status: 'idle', agentState: 'idle', pty_alive: true, session_type: 'worker', tags: [] }],
    messages: { [id]: messages },
    storage: {
      'ive.onboarding.v2.owner': 'complete', 'ive.experience-mode.v1': { mode: 'chat' },
      'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: id, openTabs: [id], showHome: false, sessionFocus: true },
    },
  })
  t.after(() => f.context.close())
  f.scroll = f.page.locator(selector)
  await f.page.getByText(/Message 36:/).first().waitFor()
  await f.page.waitForTimeout(400)
  f.snapshot = () => f.scroll.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, visible: el.clientHeight, behind: el.scrollHeight - el.scrollTop - el.clientHeight }))
  return f
}

async function swipe(f, dy) {
  if (engine === 'webkit') {
    await f.scroll.evaluate(async (el, dy) => {
      const box = el.getBoundingClientRect(), x = box.left + box.width / 2
      const y = box.top + (dy > 0 ? 60 : 60 - dy)
      const emit = (type, offset) => {
        const point = { identifier: 1, clientX: x, clientY: y + offset }
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperties(event, {
          touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] },
        })
        el.dispatchEvent(event)
      }
      emit('touchstart', 0)
      for (let i = 1; i <= 12; i++) {
        await new Promise(r => setTimeout(r, 25))
        emit('touchmove', dy * i / 12)
        el.scrollBy(0, -dy / 12)
      }
      emit('touchend', dy)
    }, dy)
  } else {
    const cdp = await f.context.newCDPSession(f.page)
    try {
      const box = await f.scroll.boundingBox()
      const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + (dy > 0 ? 60 : 60 - dy))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let i = 1; i <= 12; i++) {
        await f.page.waitForTimeout(25)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + Math.round(dy * i / 12) }] })
      }
      await f.page.waitForTimeout(120)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally { await cdp.detach() }
  }
  await f.page.waitForTimeout(200)
}

test('phone chat: scrolls both ways, keeps history through new replies and keyboard resize', async t => {
  const f = await setup(t)
  const bottom = await f.snapshot()
  assert.ok(bottom.height > bottom.visible + 1000, JSON.stringify(bottom))
  assert.ok(bottom.behind < 50, JSON.stringify(bottom))
  await swipe(f, 280)
  const older = await f.snapshot()
  assert.ok(older.behind > 180, `swipe must reach earlier messages: ${JSON.stringify(older)}`)
  f.controls.reply(id, 'A new reply arrived while the reader was looking at earlier messages.')
  await f.page.getByText('A new reply arrived while the reader was looking at earlier messages.').first().waitFor()
  await f.page.waitForTimeout(250)
  const after = await f.snapshot()
  assert.ok(Math.abs(after.top - older.top) < 50, `new replies must preserve reading position: ${JSON.stringify({older, after})}`)
  await swipe(f, -140)
  const newer = await f.snapshot()
  assert.ok(newer.top > after.top + 60, `swipe up must move down: ${JSON.stringify({after,newer})}`)
  await f.page.setViewportSize({ width: 390, height: 520 })
  await f.page.waitForTimeout(250)
  assert.ok((await f.snapshot()).behind > 100, 'opening the keyboard must not jump to latest')
  await f.page.getByRole('button', { name: /Jump to Latest/i }).click()
  await f.page.waitForTimeout(700)
  assert.ok((await f.snapshot()).behind < 2, 'Jump to Latest returns to the end')
  f.controls.reply(id, 'Following live replies again after returning to the latest message.')
  await f.page.getByText('Following live replies again after returning to the latest message.').first().waitFor()
  await f.page.waitForTimeout(300)
  assert.ok((await f.snapshot()).behind < 2, 'returning to latest resumes following replies')
  await f.page.setViewportSize({ width: 390, height: 844 })
  await f.page.waitForTimeout(250)
  assert.equal(f.writes.some(x => x.path.endsWith('/input')), false, 'scrolling sends no message')
  assert.deepEqual(f.errors, [])
  if (process.env.IVE_SHOT_DIR) {
    await mkdir(process.env.IVE_SHOT_DIR, { recursive: true })
    await f.page.screenshot({ path: join(process.env.IVE_SHOT_DIR, `phone-chat-${engine}.png`) })
  }
})

test('phone chat: can leave the live bottom while replies are arriving', async t => {
  const f = await setup(t)
  let count = 0
  const timer = setInterval(() => f.controls.reply(id, `Live reply ${++count}: more output while swiping through the conversation.`), 80)
  try {
    await f.page.waitForTimeout(120)
    await swipe(f, 280)
  } finally { clearInterval(timer) }
  await f.page.waitForTimeout(300)
  const state = await f.snapshot()
  assert.ok(state.behind > 180, `live output must let the reader scroll away: ${JSON.stringify(state)}`)
  assert.deepEqual(f.errors, [])
})
