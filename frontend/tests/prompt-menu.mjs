import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
import { BASH_LONG, BASH_TWO, EDIT_THREE, menuFor } from './fixtures/prompt-dialogs.mjs'

// Answering agents from the Overview: the chat tile's PromptMenu above its
// composer, the band above a terminal tile's xterm, the composer Enter rule
// and ⌘⇧Y ("Answer next question"), in light and dark at 1440 and 390 px.
// At 390 px the chat tile shows a long option: it wraps, nothing is cut off.
const out = new URL('../../packaging/artifacts/overview-answers-20261025/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const HINT = 'Answer the question above first'
const session = (id, name, asked_at) => ({ id, workspace_id: 'w', name, cli_type: 'claude', model: 'sonnet', permission_mode: 'auto', status: 'waiting', agentState: 'prompting', pty_alive: true, session_type: 'worker', archived: 0, tags: [], attention: { kind: 'permission', title: 'Permission needed', asked_at } })

async function fixture(theme = 'light', width = 1440) {
  const f = await createTourFixture(browser, { width, height: 960, theme, settings: { product_tour_version: '2' },
    workspaces: [{ id: 'w', name: 'Orbit', path: '/isolated/orbit' }],
    // 't' asked first: ⌘⇧Y starts there.
    sessions: [session('s', 'Orbit chat', 1760435800), session('t', 'Orbit terminal', 1760435700)],
    storage: { 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s', 't'], showHome: false, activeNavGroup: 'work' }, 'ive.grid-session-views': { s: 'chat', t: 'terminal' }, 'cc-gridColumns': '2' },
    messages: { s: [{ id: 'user', session_id: 's', role: 'user', content: 'Find the Orbit traffic project.', created_at: '2026-10-25T09:56:00Z' }], t: [] } })
  f.screens = { s: width < 1024 ? BASH_LONG : BASH_TWO, t: EDIT_THREE }
  f.viewState = { s: null, t: null }
  f.inputs = { s: [], t: [] }
  for (const id of ['s', 't']) {
    await f.context.route(`**/api/sessions/${id}/output**`, (route) => route.fulfill({ json: { screen: f.screens[id], text: '', menu: menuFor(f.screens[id]), permission_view_state: f.viewState[id] } }))
    await f.context.route(`**/api/sessions/${id}/input`, (route) => {
      const body = route.request().postDataJSON()
      f.inputs[id].push(body)
      if (body.choice) assert.equal(body.expected_identity, menuFor(f.screens[id]).identity)
      return route.fulfill({ json: { ok: true } })
    })
  }
  await f.page.goto('http://ive-guide.test/#board')
  await f.page.locator('[data-session-view="s"] [data-prompt-menu="s"] [role="listbox"]').waitFor()
  return f
}
const tile = (p, id) => p.locator(`[data-session-view="${id}"]`)
const list = (p, id) => tile(p, id).locator(`[data-prompt-menu="${id}"] [role="listbox"]`)
const option = (p, id, name) => tile(p, id).getByRole('option', { name, exact: true })
const sent = (p, id) => tile(p, id).getByRole('status').filter({ hasText: 'Sent, continuing' }).first()
const focusedListFor = (p) => p.evaluate(() => document.activeElement?.closest?.('[data-prompt-menu]')?.getAttribute('data-prompt-menu') || document.activeElement?.tagName)
let count = 0
try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390], ['dark', 390]]) {
    const f = await fixture(theme, width); const p = f.page
    assert.equal(await option(p, 's', '1. Yes').count(), 1)
    if (width < 1024) {
      // The long option wraps onto further lines and shows its whole text; the short one stays on one line.
      const long = option(p, 's', menuFor(BASH_LONG).options[1].label.replace(/^/, '2. '))
      assert.equal(await long.count(), 1)
      const label = long.locator('.ive-prompt-menu-label')
      const [longBox, shortBox] = [await long.boundingBox(), await option(p, 's', '1. Yes').boundingBox()]
      assert(longBox.height >= shortBox.height * 1.8, `the long option wraps (${longBox.height}px vs ${shortBox.height}px)`)
      assert.equal(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'nothing is clipped horizontally')
      assert.equal(await option(p, 's', '3. No').count(), 1)
    } else {
      assert.equal(await option(p, 's', '2. No').count(), 1)
    }
    if (width >= 1024) {
      // Terminal tile: compact band above the xterm, the CLI's own labels, nothing paraphrased.
      await tile(p, 't').locator('.xterm').waitFor()
      await tile(p, 't').locator('[data-prompt-band] [role="listbox"]').waitFor()
      assert.equal(await option(p, 't', '2. Yes, allow all edits during this session (shift+tab)').count(), 1)
      assert.equal(await tile(p, 't').getByRole('button', { name: /Allow|Reject/ }).count(), 0)
      const band = await tile(p, 't').locator('[data-prompt-band]').boundingBox(), xterm = await tile(p, 't').locator('.xterm').boundingBox()
      assert(band.y + band.height <= xterm.y + 1, 'the band sits above the terminal')
      assert(band.height < 260, `the band stays compact (${band.height}px)`)
    }
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: `${out}prompt-menu-${engine}-${theme}-${width}.png`, fullPage: true })
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    count++
    if (!(theme === 'light' && width === 1440)) { await f.context.close(); continue }

    // ⌘⇧Y: the oldest question first (t), pressing again cycles (s), also from inside the xterm.
    await p.evaluate(() => document.activeElement?.blur?.())
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedListFor(p), 't')
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedListFor(p), 's')
    await tile(p, 't').locator('.xterm-helper-textarea').focus()
    await p.keyboard.press('Meta+Shift+Y')
    assert.equal(await focusedListFor(p), 't')
    assert.deepEqual(f.inputs.t, []); assert.deepEqual(f.inputs.s, [])
    assert.equal(f.data.pty.some((frame) => frame.action === 'input' && /y/i.test(String(frame.data || ''))), false, 'the combo never reaches the PTY')

    // Terminal tile band: while the dialog is cut off, one line that opens the terminal.
    f.viewState.t = 'terminal_in_use'; f.screens.t = EDIT_THREE.slice(EDIT_THREE.indexOf('Do you want'))
    await tile(p, 't').getByRole('button', { name: 'Open terminal to review', exact: true }).waitFor()
    assert.equal(await tile(p, 't').locator('[data-prompt-band] [role="listbox"]').count(), 0)
    f.viewState.t = null; f.screens.t = EDIT_THREE
    await tile(p, 't').locator('[data-prompt-band] [role="listbox"]').waitFor()
    await option(p, 't', '3. No').click()
    await sent(p, 't').waitFor()
    assert.equal(f.inputs.t.length, 1); assert.equal(f.inputs.t[0].choice, '3')

    // Composer rule: Enter on the empty composer focuses the menu, the second Enter confirms.
    const textarea = tile(p, 's').locator('.ive-session-composer textarea')
    await textarea.click()
    await p.keyboard.press('Enter')
    assert.equal(await focusedListFor(p), 's')
    assert.deepEqual(f.inputs.s, [])
    await p.keyboard.press('Enter')
    await sent(p, 's').waitFor()
    assert.equal(f.inputs.s.length, 1); assert.equal(f.inputs.s[0].choice, '1')
    // A new question arrives; typed text is held back with a hint, y/n/1-9 route through the menu.
    f.screens.s = BASH_TWO.replace('Find Orbit and traffic projects', 'List the traffic fixtures')
    await tile(p, 's').getByText('List the traffic fixtures', { exact: false }).waitFor()
    await textarea.click(); await textarea.fill('hello there')
    await p.keyboard.press('Enter')
    await tile(p, 's').getByRole('alert').filter({ hasText: HINT }).waitFor()
    assert.equal(f.inputs.s.length, 1, 'free text is not sent while a question is open')
    assert.equal(await textarea.inputValue(), 'hello there')
    assert.equal(f.data.pty.some((frame) => frame.action === 'input' && /hello/.test(String(frame.data || ''))), false, 'nothing typed reaches the PTY')
    await textarea.fill('n')
    await p.keyboard.press('Enter')
    await sent(p, 's').waitFor()
    assert.equal(f.inputs.s.length, 2); assert.equal(f.inputs.s[1].choice, '2')
    assert.equal(await textarea.inputValue(), '')
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    await p.screenshot({ path: `${out}prompt-menu-${engine}-answered.png`, fullPage: true })
    count++; await f.context.close()
  }
  console.log(JSON.stringify({ engine, passed: count }))
} finally { await browser.close() }
