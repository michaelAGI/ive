import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
import { BASH_TWO, menuFor } from './fixtures/prompt-dialogs.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/session-chat-interactions/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const question = 'Hey, nicht viel – ich bin startklar. Woran arbeiten wir?'
const latest = 'Alles klar, teste ruhig. Sag einfach Bescheid, wenn ich etwas ausprobieren soll.'
const origin = 'http://ive-guide.test'
const tile = (p, id) => p.locator(`[data-grid-cell-session="${id}"]`)
let passed = 0

async function fixture({ custom = false, historical = false, permission = false, empty = false, width = 1440, theme = 'dark', view = 'board' } = {}) {
  const ids = custom ? ['s', 't'] : ['s']
  const f = await createTourFixture(browser, {
    width, height: 960, theme,
    settings: { product_tour_version: '2' },
    workspaces: [{ id: 'w', name: 'Example', path: '/isolated/example' }],
    sessions: ids.map(id => ({ id, workspace_id: 'w', name: `Session ${id}`, cli_type: 'claude', model: 'sonnet',
      status: 'waiting', agentState: 'waiting', pty_alive: true, session_type: 'worker', tags: [],
      attention: { kind: 'question', title: 'Your answer is needed', asked_at: 1762435800 } })),
    messages: Object.fromEntries(ids.map(id => [id, [
      { id: `user-${id}`, session_id: id, role: 'user', content: 'Hey!', created_at: '2026-11-06T11:31:00Z' },
      { id: `question-${id}`, session_id: id, role: 'assistant', content: question, created_at: '2026-11-06T11:31:01Z' },
      ...(historical ? [
        { id: `test-${id}`, session_id: id, role: 'user', content: 'Ich teste jetzt weiter.', created_at: '2026-11-06T11:31:02Z' },
        { id: `latest-${id}`, session_id: id, role: 'assistant', content: latest, created_at: '2026-11-06T11:31:03Z' },
      ] : []),
    ]])),
    gridTemplates: custom ? [{ id: 'custom', workspace_id: 'w', name: 'Two chats', cols: 2,
      cells: ids.map((id, i) => ({ id, row: 1, col: i + 1, rowSpan: 1, colSpan: 1 })),
      cell_assignments: { s: 's', t: 't' } }] : [],
    storage: {
      'ive.experience-mode.v1': { mode: 'dev', provider: 'claude' },
      'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ids, showHome: false, activeNavGroup: 'work' },
      'ive.grid-session-views': Object.fromEntries(ids.map(id => [id, 'chat'])),
      'cc-gridColumns': String(ids.length),
      ...(custom ? { 'cc-activeGridTemplateIds': { w: 'custom' } } : {}),
    },
  })
  f.screen = empty ? '' : permission ? BASH_TWO : `${question}\n${historical ? latest + '\n' : ''}>`
  f.outputReads = 0
  await f.context.route('**/api/sessions/*/output**', route => {
    f.outputReads++
    return route.fulfill({ json: { screen: f.screen, text: f.screen, menu: menuFor(f.screen), permission_view_state: null } })
  })
  if (permission) await f.context.route('**/api/sessions/s/input', route => route.fulfill({ json: { ok: true } }))
  await f.page.goto(`${origin}/#${view}`)
  await f.page.locator('.ive-session-composer textarea').first().waitFor()
  await f.page.getByText(historical ? latest : question, { exact: true }).first().waitFor()
  assert(f.outputReads > 0, 'The waiting session has read its current terminal screen')
  return f
}

try {
  // The screenshot case and ordinary follow-up questions both have one composer,
  // in tiles and in the full session. Old questions in the screen stay history.
  for (const [view, historical, width] of [['board', false, 1440], ['session-s', false, 1440], ['board', true, 390], ['session-s', true, 1440]]) {
    const f = await fixture({ view, historical, width })
    const p = f.page
    await p.waitForTimeout(1700) // Include the next normal screen poll.
    assert.equal(await p.locator('[data-session-prompt-actions]').count(), 0, 'Plain conversation has no request card')
    assert.equal(await p.locator('.ive-session-composer textarea').count(), 1)
    assert.equal(await p.getByLabel('Your reply', { exact: true }).count(), 0)
    if (view === 'board' && width >= 1024) assert.equal(await tile(p, 's').evaluate(el => el.classList.contains('ive-cell-needs-you')), true, 'Attention colour remains')
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: `${out}${engine}-${view}-${historical ? 'history' : 'question'}.png`, fullPage: true })
    const composer = p.locator('.ive-session-composer textarea')
    const answer = p.locator('[data-session-brief]').getByRole('button', { name: 'Answer', exact: true })
    if (await answer.count()) {
      await answer.click()
      assert.equal(await composer.evaluate(el => el === document.activeElement), true, 'Answer focuses the ordinary composer')
    }
    await composer.fill('Wir arbeiten an Orbit.')
    const response = p.waitForResponse(r => r.url().endsWith('/api/sessions/s/input') && r.request().method() === 'POST')
    await composer.press('Enter')
    const sent = await response
    assert.equal(sent.status(), 200)
    const body = sent.request().postDataJSON()
    assert.equal(body.message, 'Wir arbeiten an Orbit.')
    assert.equal(body.prompt_reply, undefined, 'Free text uses ordinary chat delivery')
    assert.equal(body.expected_screen, undefined)
    assert.equal(body.expected_identity, undefined)
    assert.equal(body.choice, undefined)
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    await f.context.close(); passed++
  }

  // Waiting alone is not a request, even before there is any screen output.
  const empty = await fixture({ empty: true })
  assert.equal(await empty.page.locator('[data-request-loading]').count(), 0)
  empty.screen = `${question}\n>`
  await empty.page.waitForTimeout(1700)
  assert.equal(await empty.page.locator('[data-session-prompt-actions]').count(), 0)
  await empty.context.close(); passed++

  // Built-in and saved layouts: open the correct chat from its content, retain
  // its unsent draft, and leave text selection in the composer untouched.
  for (const custom of [false, true]) {
    const f = await fixture({ custom, theme: custom ? 'light' : 'dark' })
    const p = f.page, id = custom ? 't' : 's'
    const cell = tile(p, id)
    const input = cell.locator('.ive-session-composer textarea')
    const text = cell.locator('[data-chat-message-row]').getByText(question, { exact: true })
    await text.click()
    assert.equal(await p.locator('[data-board-screen]').count(), 1, 'Single click keeps the board')
    await input.fill('Keep this unsent draft')
    await input.dblclick()
    assert.equal(await p.locator('[data-board-screen]').count(), 1, 'Double click in composer stays editing')
    assert.equal(await input.inputValue(), 'Keep this unsent draft')
    await cell.locator('[data-session-brief]').getByRole('button', { name: 'Answer', exact: true }).click()
    assert.equal(await input.evaluate(el => el === document.activeElement), true, 'Answer selects this tile’s composer')
    await text.dblclick()
    await p.locator(`.ive-session-screen[data-session-view="${id}"]`).waitFor()
    const fullInput = p.locator('.ive-session-composer textarea')
    assert.equal(await fullInput.inputValue(), 'Keep this unsent draft', 'Opening preserves the draft')
    assert.equal(f.writes.filter(r => /\/input$/.test(r.path)).length, 0, 'Opening sends no message')
    await p.getByText(question, { exact: true }).dblclick()
    assert.equal(await p.locator(`.ive-session-screen[data-session-view="${id}"]`).count(), 1, 'Full view stays open')
    await p.screenshot({ path: `${out}${engine}-opened-${custom ? 'custom' : 'built-in'}.png`, fullPage: true })
    await p.evaluate(() => document.activeElement?.blur?.())
    await p.keyboard.press('Escape')
    await p.locator('[data-board-screen]').waitFor()
    assert.equal(await input.inputValue(), 'Keep this unsent draft', 'Returning preserves the draft')
    await cell.locator('.ive-session-title').dblclick()
    await p.locator(`.ive-session-screen[data-session-view="${id}"]`).waitFor()
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    await f.context.close(); passed++
  }

  // Actual choices still appear even when attention was classified as question.
  // Double-clicking their text or options must not navigate away from the tile.
  const permission = await fixture({ permission: true })
  const p = permission.page
  await p.locator('[data-prompt-menu="s"] [role="listbox"]').waitFor()
  await p.getByRole('heading', { name: 'Your answer is needed', exact: true }).dblclick()
  assert.equal(await p.locator('[data-board-screen]').count(), 1)
  const sent = p.waitForResponse(r => r.url().endsWith('/api/sessions/s/input') && r.request().method() === 'POST')
  await p.getByRole('option', { name: '2. No', exact: true }).dblclick()
  const body = (await sent).request().postDataJSON()
  assert.equal(body.choice, '2')
  assert.equal(body.expected_identity, menuFor(BASH_TWO).identity)
  assert.equal(await p.locator('[data-board-screen]').count(), 1, 'Choice controls do not open the session')
  assert.equal(permission.errors.length, 0, permission.errors.join('\n'))
  await permission.context.close(); passed++
  console.log(JSON.stringify({ engine, passed }))
} finally { await browser.close() }
