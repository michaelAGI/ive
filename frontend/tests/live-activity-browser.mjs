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
const tileIds = (page) => page.locator('[data-grid-cell-session]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-grid-cell-session')))
const button = (page, filter) => page.locator(`[data-activity-filter="${filter}"]`)
const row = (page) => page.locator('[data-overview-activity]')
const counts = (page) => page.locator('[data-activity-filter]').evaluateAll((elements) => Object.fromEntries(elements.map((el) => [el.getAttribute('data-activity-filter'), Number(el.getAttribute('data-count'))])))
const countsAre = (page, expected) => eventually(async () => JSON.stringify(await counts(page)) === JSON.stringify(expected), `counts ${JSON.stringify(expected)}`)
const pressed = (page) => page.locator('[data-activity-filter][aria-pressed="true"]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-activity-filter')))
const tileWord = (page, id) => page.locator(`[data-grid-cell-session="${id}"] .ive-cell-status`).innerText().then((text) => text.trim())
// Where the row ends and the tiles begin: what the terminals re-fit on.
const geometry = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-overview-activity]').getBoundingClientRect()
  const grid = document.querySelector('[data-terminal-grid]').getBoundingClientRect()
  return { rowHeight: box.height, rowTop: box.top, gridTop: grid.top, gridHeight: grid.height }
})

test('one slim row counts the open sessions by state, follows real events and filters without sending input', async () => {
  const browser = await engine.launch()
  const f = await fixture(browser)
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await countsAre(f.page, { all: 4, working: 1, attention: 1, done: 2 })
    assert.match((await row(f.page).getByRole('group', { name: 'Filter open sessions' }).innerText()).replace(/\s+/g, ' '), /^All 4 Working 1 Needs you 1 Done 2$/)
    assert.equal(await f.page.locator('[data-activity-scope]').innerText(), 'All projects')
    // The expandable lane, its cards and its collapse arrow are gone.
    assert.equal(await f.page.locator('[data-working-section], [data-working-session], .ive-live-work').count(), 0)
    assert.equal(await f.page.getByText('Working now').count(), 0)
    assert.equal(await f.page.getByRole('button', { name: /(Collapse|Expand) working sessions/ }).count(), 0)
    assert.deepEqual(await pressed(f.page), ['all'])

    const inputBefore = f.data.pty.filter((event) => event.action === 'input').length
    await button(f.page, 'working').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout']))
    assert.deepEqual(await pressed(f.page), ['working'])
    await button(f.page, 'attention').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['approval']))
    await button(f.page, 'done').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['idle', 'shell']))
    assert.deepEqual(await counts(f.page), { all: 4, working: 1, attention: 1, done: 2 }, 'a filter never changes the counts')
    await button(f.page, 'done').click() // a second click on the pressed state shows everything again
    await eventually(async () => (await tileIds(f.page)).length === tabs.length)
    assert.deepEqual(await pressed(f.page), ['all'])

    f.controls.setSessionStatus('checkout', 'waiting', { attention: { kind: 'question', title: 'Which currency?', message: 'Which currency?', source: 'hook' } })
    await countsAre(f.page, { all: 4, working: 0, attention: 2, done: 2 })
    f.controls.setSessionStatus('checkout', 'running', { attention: null })
    await countsAre(f.page, { all: 4, working: 1, attention: 1, done: 2 })
    f.controls.setSessionStatus('checkout', 'idle')
    await countsAre(f.page, { all: 4, working: 0, attention: 1, done: 3 })
    assert.equal(f.data.pty.filter((event) => event.action === 'input').length, inputBefore)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('a terminal whose agent is done says Done, not Running; work and questions follow terminal_activity', async () => {
  const browser = await engine.launch()
  // What the owner saw: the agent in the terminal had finished, the row said "Working".
  const sessions = seed().map((s) => (s.id === 'shell' ? { ...s, name: 'Claude by hand', status: 'running', agentState: 'working', terminal_activity: 'idle' } : s))
  const f = await fixture(browser, { sessions })
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await countsAre(f.page, { all: 4, working: 1, attention: 1, done: 2 })
    assert.equal(await tileWord(f.page, 'shell'), 'Done')
    const shell = f.data.sessions.find((s) => s.id === 'shell')
    const say = (terminal_activity) => {
      Object.assign(shell, { status: terminal_activity === 'working' ? 'running' : 'idle', agentState: terminal_activity === 'working' ? 'working' : 'idle', terminal_activity })
      f.controls.emit({ type: 'status', session_id: shell.id, status: shell.status, agentState: shell.agentState, terminal_activity, pty_alive: true })
    }
    say('working') // a prompt was sent
    await countsAre(f.page, { all: 4, working: 2, attention: 1, done: 1 })
    assert.equal(await tileWord(f.page, 'shell'), 'Running')
    await button(f.page, 'working').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout', 'shell']))
    say('waiting') // the agent shows a permission dialog
    await countsAre(f.page, { all: 4, working: 1, attention: 2, done: 1 })
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout']))
    await button(f.page, 'attention').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['approval', 'shell']))
    assert.equal(await tileWord(f.page, 'shell'), 'Waiting')
    assert.equal(await f.page.locator('[data-grid-cell-session="shell"] .ive-cell-status').getAttribute('data-session-state'), 'waiting')
    say('idle') // the turn ended
    await countsAre(f.page, { all: 4, working: 1, attention: 1, done: 2 })
    await button(f.page, 'done').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['idle', 'shell']))
    assert.equal(await tileWord(f.page, 'shell'), 'Done')
    say('unknown') // the backend could not read the terminal: still not "Running"
    await f.page.waitForTimeout(150)
    assert.equal(await tileWord(f.page, 'shell'), 'Done')
    assert.equal(f.data.pty.filter((event) => ['input', 'stop'].includes(event.action)).length, 0)
    assert.equal(f.writes.filter((call) => call.path.endsWith('/restart')).length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('the row keeps one fixed height whatever it counts, filters or reports', async () => {
  const browser = await engine.launch()
  try {
    // 768px is the narrowest window with a board; below it the phone layout takes over.
    for (const [width, expected] of [[1440, 36], [1024, 36], [768, 36]]) {
      const f = await fixture(browser, { width, height: 900 })
      try {
        await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
        await countsAre(f.page, { all: 4, working: 1, attention: 1, done: 2 })
        const start = await geometry(f.page)
        assert.equal(start.rowHeight, expected, `${width}px wide`)
        assert.equal(start.gridTop, start.rowTop + start.rowHeight, 'the tiles start right under the row')
        const same = async (label, { tiles = true } = {}) => {
          const now = await geometry(f.page)
          assert.deepEqual([now.rowHeight, now.rowTop, now.gridTop], [start.rowHeight, start.rowTop, start.gridTop], `${label} at ${width}px`)
          if (tiles) assert.equal(now.gridHeight, start.gridHeight, `${label}: the tiles keep their height at ${width}px`)
          assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no sideways page scroll at ${width}px`)
        }
        f.controls.setSessionStatus('idle', 'running')
        f.controls.setSessionStatus('approval', 'running', { attention: null })
        await countsAre(f.page, { all: 4, working: 3, attention: 0, done: 1 })
        await same('counts changed')
        f.controls.setSessionStatus('checkout', 'idle')
        f.controls.setSessionStatus('idle', 'idle')
        f.controls.setSessionStatus('approval', 'idle')
        await countsAre(f.page, { all: 4, working: 0, attention: 0, done: 4 })
        await same('nothing works')
        for (const filter of ['working', 'attention', 'done', 'all']) {
          await button(f.page, filter).click()
          await eventually(async () => (await pressed(f.page))[0] === filter)
          await same(`filter ${filter}`)
        }
        f.controls.disconnect()
        await f.page.locator('[data-overview-activity][data-live="false"]').waitFor()
        await row(f.page).getByRole('status').getByText(/Connection lost|Refreshing session state/).waitFor()
        // The app shows its own notice under the main area while disconnected
        // (App.jsx); the row itself must not grow or move.
        await same('connection lost', { tiles: false })
        assert.deepEqual(f.errors, [])
      } finally { await f.context.close() }
    }
    // Two-digit counts and a long project name change nothing either.
    const many = Array.from({ length: 24 }, (_, index) => session(`s${index}`, { name: `Session ${index}`, status: index % 2 ? 'running' : 'idle', agentState: index % 2 ? 'working' : 'idle' }))
    const longName = { ...project, name: 'A customer portal with a very long project name that would not fit next to the counts on a small window' }
    const f = await fixture(browser, { width: 900, height: 900, workspaces: [longName, otherProject], sessions: many,
      storage: { 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: 's0', openTabs: many.map((s) => s.id), showHome: false, sessionFocus: false } } })
    try {
      await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
      await countsAre(f.page, { all: 24, working: 12, attention: 0, done: 12 })
      await f.page.getByRole('button', { name: 'Workspace Dashboard (Active workspace only)', exact: true }).click()
      await eventually(async () => (await f.page.locator('[data-activity-scope]').innerText()).startsWith('A customer portal'))
      const box = await geometry(f.page)
      assert.equal(box.rowHeight, 36)
      assert.equal(box.gridTop, box.rowTop + 36)
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      const filters = await row(f.page).getByRole('group', { name: 'Filter open sessions' }).boundingBox()
      const scope = await f.page.locator('[data-activity-scope]').boundingBox()
      assert.ok(scope.x >= filters.x + filters.width, 'the project name is cut off, never laid over the counts')
      assert.deepEqual(f.errors, [])
    } finally { await f.context.close() }
  } finally { await browser.close() }
})

test('scope, custom layout restoration, keyboard and screen-reader access stay usable', async () => {
  const browser = await engine.launch()
  const template = { id: 'pair', workspace_id: 'project', name: 'Pair view', cols: 2, cells: [{ id: 'left', col: 1, row: 1, colSpan: 1, rowSpan: 1 }, { id: 'right', col: 2, row: 1, colSpan: 1, rowSpan: 1 }], cell_assignments: { left: 'checkout', right: 'idle' } }
  const f = await fixture(browser, { gridTemplates: [template],
    storage: { 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: tabs[0], openTabs: [...tabs, 'site'], showHome: false, sessionFocus: false } } })
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    // Screen reader: a named region, a named group, and each state with its count.
    const region = f.page.getByRole('region', { name: 'Open sessions by state' })
    const group = region.getByRole('group', { name: 'Filter open sessions' })
    await countsAre(f.page, { all: 5, working: 2, attention: 1, done: 2 })
    for (const name of ['All: 5 sessions', 'Working: 2 sessions', 'Needs you: 1 session', 'Done: 2 sessions']) {
      assert.equal(await group.getByRole('button', { name, exact: true }).count(), 1, name)
    }
    assert.equal(await group.getByRole('button').count(), 4)
    assert.equal(await group.getByRole('button', { pressed: true }).count(), 1)

    // Scope: only the active project counts, and the row names it.
    await f.page.getByRole('button', { name: 'Workspace Dashboard (Active workspace only)', exact: true }).click()
    await countsAre(f.page, { all: 4, working: 1, attention: 1, done: 2 })
    assert.equal(await f.page.locator('[data-activity-scope]').innerText(), 'Customer portal')

    // No decorative animation, with or without the reduced-motion preference.
    for (const reducedMotion of ['reduce', 'no-preference']) {
      await f.page.emulateMedia({ reducedMotion })
      const animated = await row(f.page).evaluate((el) => [el, ...el.querySelectorAll('*')].filter((node) => getComputedStyle(node).animationName !== 'none').length)
      assert.equal(animated, 0, reducedMotion)
    }

    // A custom layout survives a filter and comes back unchanged.
    await f.page.locator('[data-layout-trigger]').click()
    await f.page.getByRole('menuitem', { name: 'Pair view' }).click()
    await eventually(async () => (await tileIds(f.page)).length === 2)
    // Keyboard only: Tab walks the states in reading order, Enter and Space press them.
    await button(f.page, 'all').focus()
    for (const filter of ['working', 'attention', 'done']) {
      await f.page.keyboard.press('Tab')
      assert.equal(await button(f.page, filter).evaluate((el) => el === document.activeElement), true, `Tab reaches ${filter}`)
    }
    assert.notEqual(await button(f.page, 'done').evaluate((el) => getComputedStyle(el).outlineStyle), 'none', 'keyboard focus is visible')
    await button(f.page, 'working').focus()
    await f.page.keyboard.press('Enter')
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout']))
    assert.equal(await button(f.page, 'working').getAttribute('aria-pressed'), 'true')
    await f.page.keyboard.press('Space')
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout', 'idle']))
    assert.deepEqual(await pressed(f.page), ['all'])
    assert.deepEqual(f.data.gridTemplates[0].cell_assignments, template.cell_assignments)
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

test('a failed open session is counted under Needs you, a stopped one under Done, and looking at them restarts nothing', async () => {
  const browser = await engine.launch()
  const f = await fixture(browser, {
    sessions: [seed()[0], session('auth', { name: 'Login expired', status: 'auth_failed', agentState: 'auth_failed', pty_alive: false }),
      session('closed', { name: 'Stopped yesterday', status: 'exited', agentState: 'exited', pty_alive: false })],
    storage: { 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: 'checkout', openTabs: ['checkout', 'auth', 'closed'], showHome: false, sessionFocus: false } },
  })
  try {
    await f.page.locator('[data-overview-activity][data-live="true"]').waitFor()
    await countsAre(f.page, { all: 3, working: 1, attention: 1, done: 1 })
    await button(f.page, 'attention').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['auth']))
    await button(f.page, 'done').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['closed']))
    await f.page.waitForTimeout(250)
    assert.equal(f.data.pty.filter((event) => ['auth', 'closed'].includes(event.session_id) && ['start_pty', 'input'].includes(event.action)).length, 0)
    assert.equal(f.data.sessions.find((s) => s.id === 'auth').pty_alive, false)
    await button(f.page, 'working').click()
    await eventually(async () => JSON.stringify(await tileIds(f.page)) === JSON.stringify(['checkout']))
    f.controls.setSessionStatus('checkout', 'idle')
    await f.page.getByText('None of your open sessions are working right now.', { exact: true }).waitFor()
    await f.page.getByRole('button', { name: 'Show all open sessions', exact: true }).click()
    await eventually(async () => (await tileIds(f.page)).length === 3)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})

test('light and dark layouts fit desktop widths and the row reports a disconnected snapshot honestly', async () => {
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
      await row(f.page).screenshot({ path: `${shots}/row-${width}-${theme}-${engine.name()}.png` })
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await f.page.locator('[data-terminal-grid]').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), width >= 1440 ? 2 : 1, 'chat tiles keep readable widths')
      if (width === 1440) {
        await button(f.page, 'attention').click()
        await f.page.locator('[data-prompt-menu="approval"] [role="listbox"]').first().waitFor()
        await f.page.screenshot({ path: `${shots}/overview-needs-you-${theme}-${engine.name()}.png` })
        await row(f.page).screenshot({ path: `${shots}/row-needs-you-${theme}-${engine.name()}.png` })
        await button(f.page, 'all').click()
      }
      const { gridHeight: _tiles, ...before } = await geometry(f.page)
      f.controls.disconnect()
      await f.page.locator('[data-overview-activity][data-live="false"]').waitFor()
      const hint = row(f.page).getByRole('status')
      assert.match(await hint.innerText(), /Connection lost\. Counts may have changed\.|Refreshing session state…/)
      assert.deepEqual(await counts(f.page), { all: 4, working: 1, attention: 1, done: 2 }, 'the last known counts stay readable')
      const { gridHeight: _offlineTiles, ...after } = await geometry(f.page)
      assert.deepEqual(after, before, 'the hint takes no extra line')
      await row(f.page).screenshot({ path: `${shots}/row-offline-${width}-${theme}-${engine.name()}.png` })
      assert.deepEqual(f.errors, [])
    } catch (error) {
      await mkdir(shots, { recursive: true })
      await f.page.screenshot({ path: `${shots}/failed-${width}-${theme}-${engine.name()}.png` })
      throw error
    } finally { await f.context.close() }
  }
  } finally { await browser.close() }
})
