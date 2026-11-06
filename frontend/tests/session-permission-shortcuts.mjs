// Regression checks for scoped permission shortcuts. All API and PTY traffic is isolated.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
after(() => browser.close())
const dist = process.env.IVE_SHORTCUT_DIST || undefined
const screenFor = (command) => `Bash command\n${command}\nRun the reviewed test command.\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for this command\n  3. No\n\nEsc to cancel · Tab to amend`
const session = id => ({ id, name: id, workspace_id: 'w', cli_type: 'claude', model: 'sonnet', permission_mode: 'default', status: 'waiting', agentState: 'waiting', pty_alive: true, session_type: 'worker', archived: 0, tags: [] })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture({ board = false, phone = false } = {}) {
  const f = await createTourFixture(browser, {
    dist, ...(phone ? { width: 390, height: 844, touch: true } : {}),
    workspaces: [{ id: 'w', name: 'Shortcut test', path: '/isolated/shortcut-test' }],
    sessions: [session('one'), session('two')],
    settings: { product_tour_version: '2', owner_name: 'Shortcut QA' },
    storage: {
      'ive.onboarding.v2.owner': 'complete', 'ive.sidebar-visible': 'true',
      'ive.experience-mode.v1': { mode: 'dev', provider: 'claude' },
      'cc-terminalBoardMode': '0',
      'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 'one', openTabs: ['one', 'two'], showHome: false, sessionFocus: !board },
    },
  })
  const screens = { one: screenFor('npm test -- one'), two: screenFor('npm test -- two') }
  const replies = []
  await f.context.route('**/api/sessions/*/output?**', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({ json: { screen: screens[id], text: screens[id], permission_view_state: 'ready' } })
  })
  await f.context.route('**/api/sessions/*/input', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const body = route.request().postDataJSON()
    replies.push({ id, ...body })
    await route.fulfill({ json: { ok: true, session_id: id } })
  })
  await f.page.goto(`http://ive-guide.test/${board ? '#board' : '#session-one'}`)
  return { ...f, screens, replies }
}

async function cardFor(f, id) {
  const card = f.page.locator(`[data-session-view="${id}"] [data-session-prompt-actions]`)
  await card.getByText('Claude wants to run a command', { exact: true }).waitFor()
  return card
}

async function unfocusedKey(f, card, key) {
  // Use a real focusable control; clicking a heading can leave a restored
  // composer focus in place after closing the command palette.
  await card.getByRole('button', { name: 'Refresh current request', exact: true }).focus()
  assert.equal(await f.page.evaluate(() => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)), false)
  await f.page.keyboard.press(key)
  await wait(180)
}

test('board digit keys never answer any of two mounted pending requests', async () => {
  const f = await fixture({ board: true })
  try {
    const first = await cardFor(f, 'one')
    await cardFor(f, 'two')
    await unfocusedKey(f, first, '1')
    assert.deepEqual(f.replies, [], 'board keys must not fan out or authorize a selected tile')
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})

test('full-view digits use the selected session and its latest screen even when choice numbers stay unchanged', async () => {
  const f = await fixture()
  try {
    const first = await cardFor(f, 'one')
    f.screens.one = screenFor('npm test -- one-revised')
    await first.getByText('npm test -- one-revised', { exact: true }).waitFor()
    await unfocusedKey(f, first, '1')
    assert.deepEqual(f.replies, [{ id: 'one', message: '1', expected_screen: f.screens.one, ready_timeout: 0 }])
    await f.page.goto('http://ive-guide.test/#session-two')
    const second = await cardFor(f, 'two')
    await unfocusedKey(f, second, '3')
    assert.deepEqual(f.replies, [
      { id: 'one', message: '1', expected_screen: f.screens.one, ready_timeout: 0 },
      { id: 'two', message: '3', expected_screen: f.screens.two, ready_timeout: 0 },
    ])
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})

test('real context popover and command palette block digit approvals even after their text input loses focus', async () => {
  const f = await fixture()
  try {
    const card = await cardFor(f, 'one')
    const composer = f.page.locator('[data-session-view="one"] .ive-session-composer textarea')
    await composer.fill('')
    await composer.press('1')
    assert.equal(await composer.inputValue(), '1', 'the first numeric character stays in an empty draft')
    assert.deepEqual(f.replies, [], 'an empty message box must not turn typing into approval')
    await composer.fill('Unsent draft')
    await composer.press('1')
    assert.deepEqual(f.replies, [], 'typing a digit must not approve the pending request')
    await f.page.getByRole('button', { name: 'Add context', exact: true }).first().click()
    const context = f.page.getByRole('dialog', { name: 'Add context', exact: true })
    await context.waitFor()
    await context.getByText('Add context', { exact: true }).click()
    await f.page.keyboard.press('1')
    await wait(180)
    assert.deepEqual(f.replies, [], 'an open context popover owns keyboard interactions')
    await f.page.getByRole('button', { name: 'Add context', exact: true }).first().click()
    await context.waitFor({ state: 'hidden' })
    await f.page.locator('#ive-project-sidebar').getByRole('button', { name: 'Search commands', exact: true }).click()
    const palette = f.page.locator('[data-command-palette]')
    await palette.waitFor()
    await palette.locator('kbd').first().click()
    assert.equal(await f.page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)), false)
    await f.page.keyboard.press('1')
    await wait(180)
    assert.deepEqual(f.replies, [], 'palette marker blocks approval outside the palette input')
    await f.page.keyboard.press('Escape')
    await palette.waitFor({ state: 'hidden' })
    await unfocusedKey(f, card, '1')
    assert.equal(f.replies.length, 1, 'keyboard approval becomes available again after overlays close')
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})

test('phone hidden sidebar dialog and mounted sessions keep keyboard approvals disabled while explicit card choice works', async () => {
  const f = await fixture({ phone: true })
  try {
    const card = await cardFor(f, 'one')
    assert.equal(await f.page.locator('[role="dialog"][aria-label="Sidebar"][aria-hidden="true"]').count(), 1, 'the real phone drawer stays mounted while hidden')
    await unfocusedKey(f, card, '1')
    assert.deepEqual(f.replies, [], 'phone cards do not install desktop digit shortcuts')
    await card.getByRole('button', { name: 'Allow once', exact: true }).click()
    await card.getByText('Reply sent', { exact: true }).waitFor()
    assert.deepEqual(f.replies, [{ id: 'one', message: '1', expected_screen: f.screens.one, ready_timeout: 0 }])
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})
