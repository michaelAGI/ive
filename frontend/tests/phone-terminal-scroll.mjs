// Built UI with isolated API/PTY fixtures. WebKit covers iOS TouchEvents;
// Chromium also drives trusted touch input through the browser protocol.
// IVE_TEST_DIST can point at the previous build for a before/after check.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const sessionId = 'scroll'
const selector = `[data-phone-terminal="${sessionId}"]`

async function openTerminal(t) {
  const browser = await ({ chromium, webkit }[engine]).launch()
  t.after(() => browser.close())
  const f = await createTourFixture(browser, {
    dist: process.env.IVE_TEST_DIST, width: 390, height: 844, touch: true,
    settings: { product_tour_version: '99' },
    workspaces: [{ id: 'w', name: 'Scroll test', path: '/isolated/scroll' }],
    sessions: [{ id: sessionId, name: 'Scroll test', workspace_id: 'w', cli_type: 'codex', status: 'idle', agentState: 'idle', pty_alive: true, session_type: 'worker', tags: [] }],
    storage: { 'ive.onboarding.v2.owner': 'complete', 'ive.experience-mode.v1': { mode: 'dev' } },
  })
  t.after(() => f.context.close())
  await f.page.locator(`[data-phone-session="${sessionId}"]`).tap()
  await f.page.getByRole('button', { name: 'Terminal view', exact: true }).tap()
  await f.page.locator(`${selector} .xterm-screen`).waitFor()
  await f.page.waitForTimeout(900)
  f.output = async (data) => {
    f.controls.emit({ type: 'output', session_id: sessionId, data })
    await f.page.waitForTimeout(120)
  }
  await f.output(Array.from({ length: 200 }, (_, i) => `History row ${i}\r\n`).join(''))
  await f.page.waitForTimeout(500)
  f.behind = () => f.page.locator(selector).evaluate(el => Number(el.dataset.linesBehind || 0))
  f.inputs = () => f.data.pty.filter(x => x.action === 'input').map(x => x.data).join('')
  return f
}

// Touch lists use the real terminal child as their target, not the wrapper.
// Mixed mode models WebKit cancelling its pointer stream while TouchEvents
// continue; it also proves that the two event streams cannot scroll twice.
async function swipe(f, { dy = 280, mixed = false, pointerOnly = false, cancel = false } = {}) {
  await f.page.locator(`${selector} .xterm-screen`).evaluate(async (target, args) => {
    const box = target.getBoundingClientRect(), x = box.left + box.width / 2
    const startY = box.top + (args.dy > 0 ? 60 : 60 - args.dy)
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const pointer = (type, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 9, clientX: x, clientY: y,
    }))
    const touch = (type, y) => {
      const point = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y }
      const active = /end|cancel/.test(type) ? [] : [point]
      // Desktop WebKit exposes Touch but rejects its constructor. Supply the
      // same event lists directly; trusted input is covered in Chromium below.
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { touches: { value: active }, targetTouches: { value: active }, changedTouches: { value: [point] } })
      target.dispatchEvent(event)
    }
    if (args.mixed || args.pointerOnly) pointer('pointerdown', startY)
    if (!args.pointerOnly) touch('touchstart', startY)
    for (let i = 1; i <= 10; i++) {
      await pause(20)
      const y = startY + args.dy * i / 10
      if (args.pointerOnly || args.mixed && i < 3) pointer('pointermove', y)
      if (args.mixed && i === 3) pointer('pointercancel', y)
      if (!args.pointerOnly) touch('touchmove', y)
    }
    await pause(120) // release without momentum to measure exactly one swipe
    if (args.pointerOnly) pointer(args.cancel ? 'pointercancel' : 'pointerup', startY + args.dy)
    else touch(args.cancel ? 'touchcancel' : 'touchend', startY + args.dy)
  }, { dy, mixed, pointerOnly, cancel })
  await f.page.waitForTimeout(150)
}

for (const mixed of [false, true]) test(`phone: ${mixed ? 'cancelled pointer stream with continuing touch' : 'touch stream'} scrolls both ways and preserves history`, async t => {
  const f = await openTerminal(t)
  await swipe(f, { mixed })
  const older = await f.behind()
  assert.ok(older >= 14 && older <= 22, `one swipe should move about 18 rows, got ${older}`)
  assert.equal(f.inputs(), '', 'reading history never types into the CLI')
  await f.output('New live output\r\n')
  assert.ok(await f.behind() >= older, 'new output must not drag the reader back down')
  await swipe(f, { dy: -140, mixed })
  assert.ok(await f.behind() < older - 4, 'swipe up moves towards newer output')
  await f.page.getByRole('button', { name: 'Back to the live output' }).tap()
  await f.page.waitForTimeout(100)
  assert.equal(await f.behind(), 0)
  assert.deepEqual(f.errors, [])
})

test('phone: full-screen mouse-aware CLI receives scroll events instead of arrow keys', async t => {
  const f = await openTerminal(t)
  await f.output('\x1b[?1049h\x1b[?1000h\x1b[?1006hFull-screen agent')
  await swipe(f, { pointerOnly: true })
  assert.match(f.inputs(), /\x1b\[<64;\d+;\d+M/, 'swiping down must send wheel-up to the CLI')
  assert.doesNotMatch(f.inputs(), /\x1b(?:\[|O)[AB]/, 'scrolling must not recall or edit a prompt')
  await swipe(f, { dy: -140 })
  assert.match(f.inputs(), /\x1b\[<65;\d+;\d+M/, 'swiping up must send wheel-down to the CLI')
  assert.deepEqual(f.errors, [])
})

test('phone: legacy full-screen programs keep their arrow-key scrolling', async t => {
  const f = await openTerminal(t)
  await f.output('\x1b[?1049h\x1b[?1hLegacy pager')
  await swipe(f, { pointerOnly: true })
  assert.match(f.inputs(), /\x1bOA/, 'application cursor mode is respected')
  assert.deepEqual(f.errors, [])
})

test('phone: a cancelled touch leaves the next swipe usable', async t => {
  const f = await openTerminal(t)
  await swipe(f, { cancel: true })
  const before = await f.behind()
  await swipe(f)
  assert.ok(await f.behind() > before + 12)
  assert.equal(f.inputs(), '')
  assert.deepEqual(f.errors, [])
})

test('phone: scrolling can leave the live bottom during terminal output', async t => {
  const f = await openTerminal(t)
  const timer = setInterval(() => f.controls.emit({ type: 'output', session_id: sessionId, data: 'Streaming output\r\n' }), 25)
  try { await swipe(f, { mixed: true }) } finally { clearInterval(timer) }
  assert.ok(await f.behind() >= 14, 'streaming output must not pull a swipe back to live')
  assert.equal(f.inputs(), '')
  assert.deepEqual(f.errors, [])
})

test('phone: trusted browser swipe scrolls once without opening the keyboard', { skip: engine !== 'chromium' }, async t => {
  const f = await openTerminal(t)
  const cdp = await f.context.newCDPSession(f.page)
  const box = await f.page.locator(`${selector} .xterm-screen`).boundingBox()
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + 60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 10; i++) {
    await f.page.waitForTimeout(20)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 28 }] })
  }
  await f.page.waitForTimeout(120)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await f.page.waitForTimeout(150)
  const older = await f.behind()
  assert.ok(older >= 14 && older <= 22, `one real swipe moved ${older} rows`)
  assert.equal(await f.page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), false)
  assert.equal(f.inputs(), '')
  assert.deepEqual(f.errors, [])
})

test('phone: pinch, long press and tap still work with the touch stream', async t => {
  const f = await openTerminal(t)
  await f.page.locator(`${selector} .xterm-screen`).evaluate(async target => {
    const box = target.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + 120
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const point = (id, dx) => ({ identifier: id, target, clientX: x + dx, clientY: y })
    const emit = (type, active, changed) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { touches: { value: active }, targetTouches: { value: active }, changedTouches: { value: changed } })
      target.dispatchEvent(event)
    }
    let a = point(1, -40), b = point(2, 40)
    emit('touchstart', [a], [a])
    emit('touchstart', [a, b], [b])
    for (let i = 1; i <= 6; i++) {
      await pause(20)
      a = point(1, -40 - i * 5); b = point(2, 40 + i * 5)
      emit('touchmove', [a, b], [a, b])
    }
    emit('touchend', [a], [b])
    emit('touchend', [], [a])
    await pause(250)
    const finger = point(1, 0)
    emit('touchstart', [finger], [finger])
    await pause(800)
    emit('touchend', [], [finger])
  })
  assert.ok(await f.page.evaluate(() => Number(localStorage.getItem('ive-phone-terminal-font'))) > 12)
  await f.page.locator('.ive-phone-paste').waitFor()
  assert.equal(await f.page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), false, 'pinch and long press do not open the keyboard')
  await f.page.locator(`${selector} .xterm-screen`).tap()
  assert.equal(await f.page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), true, 'a deliberate tap focuses the terminal')
  assert.equal(f.inputs(), '')
  assert.deepEqual(f.errors, [])
})
