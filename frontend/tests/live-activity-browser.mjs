import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
import { menuFor } from './fixtures/prompt-dialogs.mjs'

const engine = process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium
const shots = process.env.IVE_SHOT_DIR || '/tmp/ive-live-activity-qa'
const project = { id: 'project', name: 'Customer portal', path: '/isolated/customer-portal' }
const otherProject = { id: 'other', name: 'Marketing site', path: '/isolated/marketing-site' }
const names = { checkout: 'Building checkout', idle: 'Ready for next task', approval: 'Approve migration', shell: 'Terminal at prompt', background: 'Background agent', site: 'Site rebuild' }
const session = (id, extra = {}) => ({ id, name: names[id] || id, workspace_id: 'project', cli_type: 'claude', model: 'sonnet', status: 'idle', agentState: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [], ...extra })
const seed = () => [
  session('checkout', { status: 'running', agentState: 'working', last_activity: { tool_name: 'Edit', summary: 'src/checkout.ts', at: Date.now() / 1000 } }),
  session('idle'),
  session('approval', { status: 'waiting', agentState: 'prompting', attention: { kind: 'permission', title: 'Run migration?', message: 'npm run migrate', source: 'hook' } }),
  session('shell', { cli_type: 'shell', session_type: 'shell', terminal_activity: 'idle' }),
  session('background', { status: 'running', agentState: 'working' }),
  session('site', { workspace_id: 'other', status: 'running', agentState: 'working' }),
]
const tabs = ['checkout', 'idle', 'approval', 'shell']
const approvalScreen = `Bash command
Run the delivery preferences migration
──────────────────────────────
npm run migrate
Do you want to proceed?
 ❯ 1. Yes
   2. No

Esc to cancel · Tab to amend`

async function fixture(browser, extra = {}) {
  const { storage: extraStorage, ...overrides } = extra
  const f = await createTourFixture(browser, {
    width: 1440, height: 1000, workspaces: [project, otherProject], sessions: seed(), preserveRuntimeOnResume: true,
    settings: { product_tour_version: '2', owner_name: 'Overview QA' },
    messages: {
      'checkout': [
        { id: 'checkout-request', role: 'user', content: 'Make checkout recover when a payment request times out.', created_at: '2026-11-10T09:58:00Z' },
        { id: 'checkout-progress', role: 'assistant', content: 'I am adding a safe retry path and checking that it cannot create a duplicate payment.', created_at: '2026-11-10T09:59:00Z' },
      ],
      'idle': [
        { id: 'validation-request', role: 'user', content: 'Explain how the address form validates a postcode.', created_at: '2026-11-10T09:58:00Z' },
        { id: 'validation-result', role: 'assistant', content: 'The address form validates the postcode after a country is selected. Empty values stay editable until the form is submitted.', created_at: '2026-11-10T09:59:00Z' },
      ],
      'approval': [
        { id: 'migration-request', role: 'user', content: 'Add the delivery preferences table.', created_at: '2026-11-10T09:58:00Z' },
        { id: 'migration-progress', role: 'assistant', content: 'The migration is ready. I need your approval before running it against the local database.', created_at: '2026-11-10T09:59:00Z' },
      ],
    },
    storage: {
      'ive.onboarding.v2.owner': 'complete', 'cc-sidebarVisible': '1', 'cc-terminalBoardMode': '0',
      'ive.experience-mode.v1': { mode: 'dev', provider: 'claude' },
      'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: tabs[0], openTabs: tabs, showHome: false, sessionFocus: false },
      ...(extraStorage || {}),
    }, ...overrides,
  })
  await f.context.route('**/api/sessions/approval/output**', (route) => route.fulfill({ json: { screen: approvalScreen, text: approvalScreen, output: approvalScreen, menu: menuFor(approvalScreen), pty_alive: true, startup_blocker: null } }))
  return f
}

async function eventually(check, label = 'Expected state') {
  for (let index = 0; index < 100; index++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(await check(), label)
}
const workingIds = (page) => page.locator('[data-working-session]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-working-session')))
const tileIds = (page) => page.locator('[data-grid-cell-session]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-grid-cell-session')))
const button = (page, filter) => page.locator(`[data-activity-filter="${filter}"]`)

test('Overview separates live work from idle processes, follows real events, and filters without sending input', async () => {
  const browser = await engine.launch()
  const f = await fixture(browser)
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await eventually(async () => (await workingIds(f.page)).length === 3)
    assert.deepEqual(new Set(await workingIds(f.page)), new Set(['checkout', 'background', 'site']))
    assert.equal(await f.page.locator('[data-working-session="checkout"]').innerText().then((text) => text.includes('src/checkout.ts')), true)
    const inputBefore = f.data.pty.filter((event) => event.action === 'input').length
    await button(f.page, 'working').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout']))
    await button(f.page, 'attention').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['approval']))
    await button(f.page, 'all').click()
    await eventually(async () => (await tileIds(f.page)).length === tabs.length)

    f.controls.setSessionStatus('checkout', 'waiting', { attention: { kind: 'question', title: 'Which currency?', message: 'Which currency?', source: 'hook' } })
    await eventually(async () => !(await workingIds(f.page)).includes('checkout'))
    f.controls.setSessionStatus('checkout', 'running', { attention: null })
    await eventually(async () => (await workingIds(f.page)).includes('checkout'))
    await f.page.locator('[data-working-session="checkout"]').focus()
    f.controls.setSessionStatus('checkout', 'idle')
    await eventually(async () => !(await workingIds(f.page)).includes('checkout'))
    assert.equal(await f.page.getByRole('button', { name: 'Collapse working sessions' }).evaluate((el) => el === document.activeElement), true, 'a completed focused card returns focus to its section control')
    assert.equal(f.data.pty.filter((event) => event.action === 'input').length, inputBefore)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('foreground shell status enters and leaves the lane; inspecting unopened work sends no input or restart', async () => {
  const browser = await engine.launch()
  const f = await fixture(browser)
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    const shell = f.data.sessions.find((s) => s.id === 'shell')
    Object.assign(shell, { status: 'running', agentState: 'working', terminal_activity: 'working' })
    f.controls.emit({ type: 'status', session_id: shell.id, status: shell.status, agentState: shell.agentState, terminal_activity: shell.terminal_activity, pty_alive: true })
    await f.page.locator('[data-working-session="shell"]').waitFor()
    assert.match(await f.page.locator('[data-working-session="shell"]').innerText(), /Command running/)
    Object.assign(shell, { status: 'idle', agentState: 'idle', terminal_activity: 'idle' })
    f.controls.emit({ type: 'status', session_id: shell.id, status: shell.status, agentState: shell.agentState, terminal_activity: shell.terminal_activity, pty_alive: true })
    await f.page.locator('[data-working-session="shell"]').waitFor({ state: 'detached' })
    const before = f.data.pty.length
    await f.page.locator('[data-working-session="background"]').click()
    await eventually(() => f.page.url().includes('#session-'))
    assert.equal(f.data.pty.slice(before).filter((event) => ['input', 'stop'].includes(event.action)).length, 0)
    assert.equal(f.writes.filter((call) => call.path.endsWith('/restart')).length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('scope, custom layout restoration, reduced motion and keyboard controls remain usable', async () => {
  const browser = await engine.launch()
  const template = { id: 'pair', workspace_id: 'project', name: 'Pair view', cols: 2, cells: [{ id: 'left', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'right', col: 2, row: 1, colSpan: 1, rowSpan: 1 }], cell_assignments: { left: 'checkout', right: 'idle' } }
  const f = await fixture(browser, { gridTemplates: [template] })
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await f.page.getByRole('button', { name: 'Workspace Dashboard (Active workspace only)', exact: true }).click()
    await eventually(async () => !(await workingIds(f.page)).includes('site'))
    assert.ok((await workingIds(f.page)).includes('background'))
    const animation = await f.page.locator('.ive-work-signal i').first().evaluate((el) => getComputedStyle(el).animationName)
    assert.equal(animation, 'none')
    await f.page.locator('[data-layout-trigger]').click()
    await f.page.getByRole('menuitem', { name: 'Pair view' }).click()
    await eventually(async () => (await tileIds(f.page)).length === 2)
    await button(f.page, 'working').focus()
    await f.page.keyboard.press('Enter')
    await eventually(async () => (await tileIds(f.page)).length === 1)
    await button(f.page, 'all').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout', 'idle']))
    assert.deepEqual(f.data.gridTemplates[0].cell_assignments, template.cell_assignments)
    const dismiss = f.page.getByRole('button', { name: 'Dismiss Approve migration', exact: true })
    if (await dismiss.isVisible()) await dismiss.click()
    await f.page.getByRole('button', { name: 'Collapse working sessions' }).click()
    assert.equal(await f.page.locator('[data-working-session]').count(), 0)
    await f.page.getByRole('button', { name: 'Expand working sessions' }).click()
    assert.equal(await f.page.locator('[data-working-session]').count(), 2)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('terminal filters preserve keyboard focus and retain all running sessions', async () => {
  const browser = await engine.launch()
  const f = await fixture(browser, { storage: { 'cc-terminalBoardMode': '1' } })
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await button(f.page, 'attention').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['approval']))
    await button(f.page, 'all').focus()
    await f.page.keyboard.press('Enter')
    await eventually(async () => (await tileIds(f.page)).length === tabs.length)
    await f.page.waitForTimeout(250) // allow the terminal portal's observer/commit to run
    assert.equal(await button(f.page, 'all').evaluate((el) => el === document.activeElement), true, await f.page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 500)))
    assert.equal(f.data.pty.filter((event) => ['stop', 'input'].includes(event.action)).length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('finishing a focused filtered tile keeps the draft and returns keyboard focus to the filter', async () => {
  const browser = await engine.launch()
  const f = await fixture(browser)
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await button(f.page, 'working').click()
    const composer = f.page.locator('[data-grid-cell-session="checkout"] .ive-session-composer textarea')
    await composer.fill('Please also check the retry limit.')
    f.controls.setSessionStatus('checkout', 'idle')
    await f.page.getByText('None of your open sessions are working right now.', { exact: true }).waitFor()
    assert.equal(await button(f.page, 'working').evaluate((el) => el === document.activeElement), true)
    await button(f.page, 'all').click()
    await composer.waitFor()
    assert.equal(await composer.inputValue(), 'Please also check the retry limit.')
    assert.equal(f.data.pty.filter((event) => event.action === 'input').length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('Needs you opens an unopened failed session through a full template without restarting it', async () => {
  const browser = await engine.launch()
  const template = { id: 'single', workspace_id: 'project', name: 'Single', cols: 1, cells: [{ id: 'only', col: 1, row: 1, colSpan: 1, rowSpan: 1 }], cell_assignments: { only: 'checkout' } }
  const f = await fixture(browser, {
    sessions: [seed()[0], session('auth', { name: 'Login expired', status: 'auth_failed', agentState: 'auth_failed', pty_alive: false })],
    gridTemplates: [template],
    storage: { 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: 'checkout', openTabs: ['checkout'], showHome: false, sessionFocus: false } },
  })
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await f.page.locator('[data-layout-trigger]').click()
    await f.page.getByRole('menuitem', { name: 'Single', exact: true }).click()
    await f.page.getByRole('button', { name: '1 needs you', exact: true }).click()
    await eventually(() => f.page.url().includes('#session-auth'))
    await f.page.waitForTimeout(250)
    assert.equal(f.data.pty.filter((event) => event.session_id === 'auth' && ['start_pty', 'input'].includes(event.action)).length, 0)
    assert.equal(f.data.sessions.find((s) => s.id === 'auth').pty_alive, false)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('light and dark layouts fit desktop widths and activity reports a disconnected snapshot honestly', async () => {
  const browser = await engine.launch()
  try { for (const [width, height, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [1024, 768, 'light'], [768, 800, 'dark']]) {
    const f = await fixture(browser, { width, height, theme })
    try {
      await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
      await f.page.locator('#msg-validation-result').getByText('The address form validates the postcode after a country is selected. Empty values stay editable until the form is submitted.', { exact: true }).waitFor()
      await f.page.locator('[data-prompt-menu="approval"] [role="listbox"]').first().waitFor()
      await f.page.waitForTimeout(600) // transcript's initial scroll pin and font layout must settle
      const dismiss = f.page.getByRole('button', { name: 'Dismiss Approve migration', exact: true })
      if (await dismiss.isVisible()) await dismiss.click()
      await mkdir(shots, { recursive: true })
      await f.page.screenshot({ path: `${shots}/overview-${width}-${theme}-${engine.name()}.png` })
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await f.page.locator('[data-terminal-grid]').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), width >= 1440 ? 2 : 1, 'chat tiles keep readable widths')
      if (width === 1440 && theme === 'light') {
        await button(f.page, 'attention').click()
        await f.page.locator('[data-prompt-menu="approval"] [role="listbox"]').first().waitFor()
        await f.page.screenshot({ path: `${shots}/overview-needs-you-${engine.name()}.png` })
        await button(f.page, 'all').click()
      }
      await f.page.emulateMedia({ reducedMotion: 'no-preference' })
      assert.equal(await f.page.locator('.ive-work-signal i').first().evaluate((el) => getComputedStyle(el).animationName), 'ive-work-signal')
      f.controls.disconnect()
      await f.page.getByText('Last known activity', { exact: true }).waitFor()
      assert.equal(await f.page.locator('.ive-work-signal[data-active="true"]').count(), 0)
      assert.match(await f.page.locator('.ive-live-offline').innerText(), /Connection lost|Refreshing session state/)
      assert.deepEqual(f.errors, [])
    } catch (error) {
      await mkdir(shots, { recursive: true })
      await f.page.screenshot({ path: `${shots}/failed-${width}-${theme}-${engine.name()}.png` })
      throw error
    } finally { await f.context.close() }
  }
  } finally { await browser.close() }
})
