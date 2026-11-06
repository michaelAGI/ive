import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
import { ASK_COLOUR, BASH_TWO, EDIT_THREE, menuFor } from './fixtures/prompt-dialogs.mjs'

// The "needs you" pop-up: a waiting session whose terminal is not in front of
// the user gets a card top right with the CLI's own options; a digit sends the
// guarded reply exactly once, Escape sends nothing, an answer elsewhere clears
// the card, dismissed questions never come back, the setting can turn it off,
// and tiles that are on screen never get a card. Light and dark, 1440 and 390 px.
const out = new URL('../../packaging/artifacts/overview-answers-20261025/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const EDIT_MAIN = EDIT_THREE.replace('src/App.jsx', 'src/Main.jsx')
const workspace = { id: 'w', name: 'Orbit', path: '/isolated/orbit' }
const attentionFor = (screen, extra = {}) => ({ kind: 'permission', title: 'Permission needed', message: 'Review the request.', tool_name: 'Edit', tool_input: { file_path: '/isolated/orbit/src/App.jsx' }, menu: menuFor(screen), asked_at: 1760435700, ...extra })
const session = (id, name, attention) => ({ id, workspace_id: 'w', name, cli_type: 'claude', model: 'sonnet', permission_mode: 'auto', status: attention ? 'waiting' : 'idle', agentState: attention ? 'prompting' : 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [], attention: attention || null })
const desk = (extra = {}) => ({ activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s', 't'], showHome: false, sessionFocus: true, activeNavGroup: 'work', ...extra })

async function fixture({ theme = 'light', width = 1440, hash = '#session-s', storage = {}, sessions, screens } = {}) {
  const rows = sessions || [session('s', 'Orbit chat', null), session('t', 'Orbit terminal', attentionFor(EDIT_THREE))]
  const f = await createTourFixture(browser, { width, height: 960, theme, settings: { product_tour_version: '2' }, workspaces: [workspace], sessions: rows,
    storage: { 'ive.operator-desk': desk(), 'ive.grid-session-views': { s: 'chat', t: 'terminal' }, 'cc-gridColumns': '2', ...storage },
    messages: Object.fromEntries(rows.map((row) => [row.id, row.id === 's' ? [{ id: 'user', session_id: 's', role: 'user', content: 'Find the Orbit traffic project.', created_at: '2026-10-25T09:56:00Z' }] : []])) })
  f.screens = screens || Object.fromEntries(rows.map((row) => [row.id, row.id === 's' ? '' : EDIT_THREE]))
  f.inputs = Object.fromEntries(rows.map((row) => [row.id, []]))
  for (const { id } of rows) {
    await f.context.route(`**/api/sessions/${id}/output**`, (route) => route.fulfill({ json: { screen: f.screens[id], text: '', menu: menuFor(f.screens[id]), permission_view_state: null } }))
    await f.context.route(`**/api/sessions/${id}/input`, (route) => {
      const body = route.request().postDataJSON()
      f.inputs[id].push(body)
      if (body.choice) assert.equal(body.expected_identity, menuFor(f.screens[id]).identity, 'the reply names the dialog it answers')
      return route.fulfill({ json: { ok: true } })
    })
  }
  await f.page.goto(`http://ive-guide.test/${hash}`)
  return f
}
const popover = (p) => p.locator('[data-needs-you-popover]')
const card = (p, id) => popover(p).locator(`[data-needs-you-card="${id}"]`)
const list = (p, id) => card(p, id).locator('[role="listbox"]')
const ready = (p, id) => card(p, id).locator('[role="listbox"]:not([aria-disabled="true"])').waitFor()
const sent = (p, id) => card(p, id).getByRole('status').filter({ hasText: 'Sent, continuing' }).first()
const focusedCard = (p) => p.evaluate(() => document.activeElement?.closest?.('[data-needs-you-card]')?.getAttribute('data-needs-you-card') || document.activeElement?.tagName)
const attentionEvent = (id, attention) => ({ type: 'session_attention', session_id: id, attention })
const settle = (p, ms = 700) => p.waitForTimeout(ms)
let count = 0
try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390], ['dark', 390]]) {
    const f = await fixture({ theme, width }); const p = f.page
    // Session s is open, t waits: one card, oldest first, the CLI's own words, nothing paraphrased.
    await card(p, 't').waitFor()
    await ready(p, 't')
    assert.equal(await card(p, 't').locator('strong').innerText(), 'Orbit terminal')
    assert.equal(await card(p, 't').locator('.ive-nyp-project').innerText(), 'Orbit')
    assert.equal(await card(p, 't').locator('.ive-nyp-wants').innerText(), 'Edit: src/App.jsx')
    assert.equal(await card(p, 't').getByRole('option', { name: '1. Yes', exact: true }).count(), 1)
    assert.equal(await card(p, 't').getByRole('option', { name: '2. Yes, allow all edits during this session (shift+tab)', exact: true }).count(), 1)
    assert.equal(await card(p, 't').getByRole('option', { name: '3. No', exact: true }).count(), 1)
    // The long option wraps inside the card; nothing is cut off.
    const longLabel = card(p, 't').getByRole('option', { name: '2. Yes, allow all edits during this session (shift+tab)', exact: true }).locator('.ive-prompt-menu-label')
    assert.equal(await longLabel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'the card option is not clipped')
    assert.equal(await card(p, 't').getByRole('button', { name: /Allow|Reject/ }).count(), 0)
    assert.equal(await card(p, 't').getByRole('button', { name: 'Open session', exact: true }).count(), 1)
    // The request stays behind "Show request".
    assert.equal(await card(p, 't').locator('.ive-nyp-request').count(), 0)
    await card(p, 't').getByRole('button', { name: 'Show request', exact: true }).click()
    await card(p, 't').locator('.ive-nyp-request').filter({ hasText: 'Edit file' }).waitFor()
    await card(p, 't').getByRole('button', { name: 'Hide request', exact: true }).click()
    assert.equal(await card(p, 't').locator('.ive-nyp-request').count(), 0)
    assert.equal(await card(p, 's').count(), 0, 'the open session never gets a card')
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const box = await card(p, 't').boundingBox()
    assert(box.x + box.width <= width + 1 && box.y >= 40, `the card sits top right (${JSON.stringify(box)})`)
    await p.screenshot({ path: `${out}needs-you-${engine}-${theme}-${width}.png`, fullPage: true })
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++
    if (!(theme === 'light' && width === 1440)) { await f.context.close(); continue }

    // ⌘⇧Y lands on the card; Escape only leaves it: nothing is sent, the session screen stays.
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedCard(p), 't')
    await p.keyboard.press('Escape')
    await settle(p, 200)
    assert.notEqual(await focusedCard(p), 't')
    assert.deepEqual(f.inputs.t, [])
    await p.locator('[data-session-view="s"]').waitFor()
    // Arrows move only here; nothing reaches the PTY.
    await p.keyboard.press('Meta+Shift+Y')
    await p.keyboard.press('ArrowDown')
    assert.equal(await card(p, 't').getByRole('option', { selected: true }).locator('.ive-prompt-menu-label').innerText(), '2. Yes, allow all edits during this session (shift+tab)')
    assert.deepEqual(f.inputs.t, [])
    assert.equal(f.data.pty.some((frame) => frame.action === 'input'), false, 'no key reaches the PTY')

    // Dismiss (x): local only, and the same question never comes back.
    await card(p, 't').getByRole('button', { name: 'Dismiss Orbit terminal', exact: true }).click()
    await card(p, 't').waitFor({ state: 'hidden' })
    f.controls.emit(attentionEvent('t', attentionFor(EDIT_THREE)))
    await settle(p)
    assert.equal(await card(p, 't').count(), 0, 'a dismissed question stays dismissed')
    assert.deepEqual(f.inputs.t, [])

    // A new question (Bash): the card returns; the typing user keeps the keyboard.
    const textarea = p.locator('[data-session-view="s"] .ive-session-composer textarea')
    await textarea.click()
    f.screens.t = BASH_TWO
    f.controls.emit(attentionEvent('t', attentionFor(BASH_TWO, { tool_name: 'Bash', tool_input: { command: "ls -d */ Projects/*/ | grep -i 'orbit|traffic'" } })))
    await card(p, 't').waitFor()
    await ready(p, 't')
    assert.equal(await card(p, 't').locator('.ive-nyp-wants').innerText(), "Run: ls -d */ Projects/*/ | grep -i 'orbit|traffic'")
    assert.equal(await p.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'the pop-up never steals focus from a typing user')
    // Digit: selects and sends the guarded reply exactly once.
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedCard(p), 't')
    await p.keyboard.press('2')
    await sent(p, 't').waitFor()
    assert.equal(f.inputs.t.length, 1)
    assert.equal(f.inputs.t[0].choice, '2')
    assert.equal(f.inputs.t[0].expected_identity, menuFor(BASH_TWO).identity)
    await p.keyboard.press('2'); await p.keyboard.press('Enter')
    await settle(p, 300)
    assert.equal(f.inputs.t.length, 1, 'an answered card sends nothing more')
    // The card leaves once the notice fades (and once the attention clears).
    f.controls.emit(attentionEvent('t', null))
    await card(p, 't').waitFor({ state: 'hidden' })

    // Answered elsewhere: the attention clears and the card goes, nothing sent from here.
    await p.evaluate(() => document.activeElement?.blur?.())
    f.screens.t = EDIT_MAIN
    f.controls.emit(attentionEvent('t', attentionFor(EDIT_MAIN, { tool_input: { file_path: '/isolated/orbit/src/Main.jsx' } })))
    await card(p, 't').waitFor()
    assert.equal(await card(p, 't').locator('.ive-nyp-wants').innerText(), 'Edit: src/Main.jsx')
    // Nothing else had the keyboard: the oldest card takes it on its own.
    assert.equal(await focusedCard(p), 't')
    f.controls.emit(attentionEvent('t', null))
    await card(p, 't').waitFor({ state: 'hidden' })
    assert.equal(f.inputs.t.length, 1)
    assert.equal(await popover(p).count(), 0)
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++; await f.context.close()
  }

  // Overview with both tiles on screen: the question is in front of the user, no card.
  {
    const f = await fixture({ hash: '#board' }); const p = f.page
    await p.locator('[data-session-view="t"] [data-prompt-band] [role="listbox"]').waitFor()
    await settle(p)
    assert.equal(await popover(p).count(), 0, 'a tile on screen never gets a card')
    // Leave for Home: the tile is gone, the card appears.
    await p.goto('http://ive-guide.test/#home')
    await card(p, 't').waitFor()
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++; await f.context.close()
  }

  // Setting off: no pop-up, the question stays in the tile and the sidebar only.
  // Choosing "Pop-up and macOS notification" in Settings asks the browser once and never throws;
  // without window.Notification (the Tauri shell today) the help text says the pop-up works now.
  {
    const f = await fixture({ storage: { 'cc-needsYouAlert': 'off' } }); const p = f.page
    await p.locator('[data-session-view="s"]').waitFor()
    await settle(p, 1200)
    assert.equal(await popover(p).count(), 0)
    await p.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await p.locator('[data-settings-nav="general-settings"]').click()
    const select = p.getByLabel('When an agent needs you')
    await select.waitFor()
    assert.equal(await select.inputValue(), 'off')
    await select.selectOption('popup_macos')
    await settle(p, 300)
    assert.equal(await select.inputValue(), 'popup_macos')
    assert.equal(await p.evaluate(() => localStorage.getItem('cc-needsYouAlert')), 'popup_macos')
    const state = await p.evaluate(() => (typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported'))
    const help = p.locator('[data-needs-you-help]')
    if (state === 'unsupported') assert.match(await help.innerText(), /macOS notifications arrive with the next IVE app update/)
    else if (state === 'denied') assert.match(await help.innerText(), /blocked/)
    else assert.equal(await help.count(), 0)
    await select.selectOption('popup')
    await settle(p, 200)
    assert.equal(await help.count(), 0)
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++; await f.context.close()
  }

  // ⌘⇧Y is one list across cards and on-screen menus, oldest question first: the open
  // session's older question (its PromptMenu on screen, no card) comes before the newer card.
  {
    const older = attentionFor(BASH_TWO, { tool_name: 'Bash', tool_input: { command: "ls -d */ Projects/*/ | grep -i 'orbit|traffic'" }, asked_at: 1760435600 })
    const f = await fixture({ sessions: [session('s', 'Orbit chat', older), session('t', 'Orbit terminal', attentionFor(EDIT_THREE))], screens: { s: BASH_TWO, t: EDIT_THREE } }); const p = f.page
    await p.locator('[data-session-view="s"] [data-prompt-menu="s"] [role="listbox"]').waitFor()
    await card(p, 't').waitFor()
    assert.equal(await card(p, 's').count(), 0, 'the open session never gets a card')
    await p.evaluate(() => document.activeElement?.blur?.())
    const focusedMenu = () => p.evaluate(() => document.activeElement?.closest?.('[data-prompt-menu]')?.getAttribute('data-prompt-menu'))
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedMenu(), 's')
    assert.equal(await focusedCard(p), 'DIV', 'the on-screen menu of the older question, not a card')
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedCard(p), 't')
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedMenu(), 's')
    assert.equal(Object.values(f.inputs).flat().length, 0)
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++; await f.context.close()
  }

  // Five waiting sessions on Home: three cards, oldest first, "+2 more"; ⌘⇧Y cycles through the cards.
  {
    const asked = { t: 1760435700, u: 1760435500, v: 1760435600, x: 1760435800, y: 1760435900 }
    const rows = [session('s', 'Orbit chat', null), ...Object.entries(asked).map(([id, at]) => session(id, `Session ${id.toUpperCase()}`, attentionFor(EDIT_THREE, { asked_at: at })))]
    const f = await fixture({ hash: '#home', sessions: rows, storage: { 'ive.operator-desk': desk({ openTabs: ['s', ...Object.keys(asked)], showHome: true, sessionFocus: false }) } }); const p = f.page
    await card(p, 'u').waitFor()
    assert.deepEqual(await popover(p).locator('[data-needs-you-card]').evaluateAll((els) => els.map((el) => el.getAttribute('data-needs-you-card'))), ['u', 'v', 't'])
    assert.equal(await popover(p).locator('[data-needs-you-more]').innerText(), '+2 more')
    await p.evaluate(() => document.activeElement?.blur?.())
    await p.keyboard.press('Meta+Shift+Y'); assert.equal(await focusedCard(p), 'u')
    await p.keyboard.press('Meta+Shift+Y'); assert.equal(await focusedCard(p), 'v')
    await p.keyboard.press('Meta+Shift+Y'); assert.equal(await focusedCard(p), 't')
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: `${out}needs-you-${engine}-stack.png`, fullPage: true })
    // The fourth question (x) has no card ("+2 more") and no menu on Home: ⌘⇧Y opens its session and takes its menu.
    await p.keyboard.press('Meta+Shift+Y')
    await p.locator('[data-session-view="x"] [data-prompt-menu="x"] [role="listbox"]').waitFor()
    await p.waitForFunction(() => document.activeElement?.closest?.('[data-prompt-menu]')?.getAttribute('data-prompt-menu') === 'x')
    assert.equal(await focusedCard(p), 'DIV', 'the session menu, not a card')
    assert.equal(Object.values(f.inputs).flat().length, 0)
    await p.goto('http://ive-guide.test/#home')
    await card(p, 'u').waitFor()
    // Open session: the session screen, the terminal drawer open, nothing sent.
    await card(p, 'u').getByRole('button', { name: 'Open session', exact: true }).click()
    await p.locator('[data-session-view="u"] [data-session-terminal-drawer]').waitFor()
    await card(p, 'u').waitFor({ state: 'hidden' })
    assert.equal(Object.values(f.inputs).flat().length, 0)
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++; await f.context.close()
  }
  // AskUserQuestion: "Type something." and "Chat about this" are listed 1:1 but open the terminal; nothing is POSTed for them.
  {
    const ask = attentionFor(ASK_COLOUR, { tool_name: 'AskUserQuestion', tool_input: { question: 'Which colour should the button use?' } })
    const f = await fixture({ sessions: [session('s', 'Orbit chat', null), session('t', 'Orbit terminal', ask)], screens: { s: '', t: ASK_COLOUR } }); const p = f.page
    await card(p, 't').waitFor()
    await ready(p, 't')
    assert.equal(await card(p, 't').locator('.ive-nyp-wants').innerText(), 'Question: Which colour should the button use?')
    for (const name of ['1. Red', '2. Green', '3. Type something.', '4. Chat about this']) assert.equal(await card(p, 't').getByRole('option', { name, exact: true }).count(), 1, name)
    await p.evaluate(() => document.activeElement?.blur?.())
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedCard(p), 't')
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown')
    assert.match(await card(p, 't').locator('.ive-prompt-menu-foot').innerText(), /Opens the terminal/)
    await p.keyboard.press('3')
    await p.locator('[data-session-view="t"] [data-session-terminal-drawer]').waitFor()
    await card(p, 't').waitFor({ state: 'hidden' })
    assert.deepEqual(f.inputs.t, [], 'a free-text row sends nothing')
    // On the session screen the same rows open the terminal too: by click and from the composer.
    const menu = p.locator('[data-session-view="t"] [data-prompt-menu="t"]')
    await menu.locator('[role="listbox"]:not([aria-disabled="true"])').waitFor()
    await menu.getByRole('option', { name: '4. Chat about this', exact: true }).click()
    await settle(p, 300)
    assert.deepEqual(f.inputs.t, [])
    assert.match(await menu.locator('.ive-prompt-menu-foot').innerText(), /Opens the terminal/)
    assert.equal(await p.locator('[data-session-view="t"] [data-session-terminal-drawer]').count(), 1)
    const textarea = p.locator('[data-session-view="t"] .ive-session-composer textarea')
    await textarea.click(); await textarea.fill('3'); await p.keyboard.press('Enter')
    await settle(p, 300)
    assert.deepEqual(f.inputs.t, [])
    assert.equal(await textarea.inputValue(), '')
    // "1. Red" is a real answer and goes through the guard.
    await menu.getByRole('option', { name: '1. Red', exact: true }).click()
    await menu.getByRole('status').filter({ hasText: 'Sent, continuing' }).first().waitFor()
    assert.equal(f.inputs.t.length, 1); assert.equal(f.inputs.t[0].choice, '1')
    assert.equal(f.inputs.t[0].expected_identity, menuFor(ASK_COLOUR).identity)
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++; await f.context.close()
  }
  console.log(JSON.stringify({ engine, passed: count }))
} finally { await browser.close() }
