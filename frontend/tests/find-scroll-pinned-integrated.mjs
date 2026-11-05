// Run after building the frontend: node --test tests/find-scroll-pinned-integrated.mjs
// Built app + isolated API/WebSocket fixture: no server, real session, or PTY.
// IVE_TEST_DIST can point to another built frontend for before/after checks.
// IVE_QA_BROWSER=webkit exercises the same behavior in WebKit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browserType = process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium
const sessionId = 'find-scroll'
const message = (n, role, content) => ({
  id: `find-scroll-${n}`, session_id: sessionId, role, content,
  created_at: new Date(Date.parse('2026-10-12T09:00:00Z') + n * 60000).toISOString(),
})
const messages = [
  message(1, 'user', 'Please prepare the deploy script for staging.'),
  message(2, 'assistant', 'I looked at the repository. The Deploy step currently runs after the tests.'),
  message(3, 'user', 'Good. Keep the database migration separate.'),
  message(4, 'assistant', 'Done. The migration now runs first, then deploy, then a smoke test.'),
  ...Array.from({ length: 8 }, (_, i) => message(5 + i, i % 2 ? 'assistant' : 'user', `Filler message ${i + 1} about logging and retries.`)),
  message(13, 'assistant', 'Summary: staging deploy is ready for review.'),
]

async function geometry(page) {
  return page.evaluate((id) => {
    const box = document.querySelector(`[data-session-scroll="${id}"]`)
    const range = [...(CSS.highlights.get('ive-find-current') || [])][0]
    const composer = document.querySelector(`[data-session-view="${id}"] .ive-session-composer`)
    const rect = (item) => {
      const r = item?.getBoundingClientRect()
      return r ? { top: r.top, bottom: r.bottom } : null
    }
    return {
      status: document.querySelector('[data-find-status]')?.textContent.trim(),
      selectedText: range?.toString(), match: rect(range), viewport: rect(box), composer: rect(composer),
      scrollTop: box?.scrollTop, scrollHeight: box?.scrollHeight, clientHeight: box?.clientHeight,
      distanceToBottom: box ? box.scrollHeight - box.scrollTop - box.clientHeight : null,
    }
  }, sessionId)
}
function assertVisible(state, expectedStatus) {
  const detail = JSON.stringify(state)
  assert.equal(state.status, expectedStatus, detail)
  assert.match(state.selectedText || '', /^deploy$/i, detail)
  assert.ok(state.match && state.viewport && state.composer, detail)
  assert.ok(state.match.top >= state.viewport.top - 1, `Current match is above the transcript: ${detail}`)
  assert.ok(state.match.bottom <= Math.min(state.viewport.bottom, state.composer.top) + 1, `Current match is obscured or below the transcript: ${detail}`)
}
async function status(page, expected) {
  await page.waitForFunction((value) => document.querySelector('[data-find-status]')?.textContent.trim() === value, expected)
}

for (const mode of ['chat', 'dev']) {
  test(`${mode}: find navigation leaves pinned follow and keeps the selected result visible after reflow`, async (t) => {
    const browser = await browserType.launch()
    t.after(() => browser.close())
    const session = { id: sessionId, name: 'Find scroll QA', workspace_id: 'find-project', cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }
    const f = await createTourFixture(browser, {
      dist: process.env.IVE_TEST_DIST, width: 1440, height: 900,
      settings: { product_tour_version: '99', owner_name: 'Find QA' },
      workspaces: [{ id: 'find-project', name: 'Find practice', path: '/isolated/find' }],
      sessions: [session], messages: { [sessionId]: messages },
      storage: {
        'ive.onboarding.v2.owner': 'complete', 'cc-sidebarVisible': '1',
        'ive.experience-mode.v1': { mode, provider: 'claude' },
        'ive.operator-desk': { activeWorkspaceId: 'find-project', activeSessionId: sessionId, openTabs: [sessionId], showHome: false, sessionFocus: true },
      },
    })
    t.after(() => f.context.close())
    const page = f.page
    await page.getByText('Summary: staging deploy is ready for review.', { exact: true }).first().waitFor()
    // Begin at the actual pinned bottom of a scrollable transcript.
    await page.waitForFunction((id) => {
      const box = document.querySelector(`[data-session-scroll="${id}"]`)
      return box && box.scrollHeight > box.clientHeight && Math.abs(box.scrollHeight - box.scrollTop - box.clientHeight) <= 1
    }, sessionId)
    await page.waitForTimeout(200)
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform)) ? 'Meta' : 'Control'
    await page.locator(`[data-session-view="${sessionId}"] .ive-session-composer textarea`).click()
    await page.keyboard.press(`${modifier}+f`)
    await page.getByRole('textbox', { name: 'Find in this chat' }).fill('deploy')
    await status(page, '4 of 4')
    assertVisible(await geometry(page), '4 of 4')

    await page.keyboard.press('Enter')
    await status(page, '1 of 4')
    await page.waitForTimeout(200)
    const first = await geometry(page)
    assertVisible(first, '1 of 4')
    assert.ok(first.distanceToBottom > 100, JSON.stringify(first))

    await page.keyboard.press('Shift+Enter')
    await status(page, '4 of 4')
    // Returning to the last result repins and removes Jump to Latest. Wait
    // for that real composer reflow, then navigate again while follow's
    // reflow grace is still active. This used to snap the match off screen.
    await page.waitForFunction(({ id, previousHeight }) => {
      const box = document.querySelector(`[data-session-scroll="${id}"]`)
      return box && box.scrollHeight < previousHeight && Math.abs(box.scrollHeight - box.scrollTop - box.clientHeight) <= 1
    }, { id: sessionId, previousHeight: first.scrollHeight }, { polling: 'raf' })
    await page.keyboard.press('Shift+Enter')
    await status(page, '3 of 4')
    await page.waitForTimeout(200)
    const third = await geometry(page)
    assertVisible(third, '3 of 4')
    assert.ok(third.distanceToBottom > 100, `Navigation must leave the pinned bottom: ${JSON.stringify(third)}`)
    await page.waitForTimeout(500)
    assertVisible(await geometry(page), '3 of 4')

    // The alternate next/previous shortcuts must use the same navigation.
    await page.keyboard.press(`${modifier}+g`)
    await status(page, '4 of 4')
    await page.waitForTimeout(200)
    assertVisible(await geometry(page), '4 of 4')
    await page.keyboard.press(`${modifier}+Shift+g`)
    await status(page, '3 of 4')
    await page.waitForTimeout(200)
    assertVisible(await geometry(page), '3 of 4')
    assert.deepEqual(f.errors, [])
    assert.equal(f.writes.some(({ path }) => /\/sessions\/[^/]+\/input$/.test(path)), false, 'find never submits text to a session')
    t.diagnostic(`selected third result after pinned reflow: ${JSON.stringify(third)}`)
  })
}
