// Real production UI with isolated API/PTY fixtures. These checks never start
// a provider, touch a real workspace, or infer provider delivery from a click.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { after, test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engineName = process.env.IVE_QA_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const browser = await ({ chromium, webkit }[engineName]).launch()
after(async () => browser.close())

const experienceKey = 'ive.experience-mode.v1'
const shots = process.env.IVE_SHOT_DIR || '/tmp/ive-chat-dev-qa'
await mkdir(shots, { recursive: true })
const workspace = { id: 'project', name: 'Workflow practice', path: '/isolated/workflow-practice' }
const session = (id, extra = {}) => ({
  id, name: `Conversation ${id}`, workspace_id: workspace.id,
  cli_type: 'claude', model: 'sonnet', status: 'idle', agentState: 'idle',
  pty_alive: false, session_type: 'worker', archived: 0, tags: [], ...extra,
})

async function until(read, message) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function fixture(options = {}) {
  const f = await createTourFixture(browser, {
    settings: { product_tour_version: '2', owner_name: 'Experience QA' },
    ...options,
    storage: {
      'ive.onboarding.v2.owner': 'complete',
      'ive.sidebar-visible': 'true',
      'ive.operator-desk': { openTabs: [], showHome: true, activeWorkspaceId: null },
      ...options.storage,
    },
  })
  await modeGroup(f.page).waitFor({ state: 'visible' })
  return f
}

// Desktop and phone can render separate responsive controls. Only the
// visible control is actionable, and it must retain the same accessible name.
function modeGroup(page) {
  return page.getByRole('group', { name: 'Experience mode', exact: true }).filter({ visible: true }).first()
}

async function setMode(page, name) {
  const button = modeGroup(page).getByRole('button', { name, exact: true })
  await button.click()
  await until(() => button.getAttribute('aria-pressed').then((value) => value === 'true'), `${name} is selected`)
}

function processMutations(f) {
  return {
    // resume_pty attaches an existing PTY and is not a process launch.
    pty: f.data.pty.filter((item) => ['start_pty', 'stop', 'restart', 'kill'].includes(item.action)),
    http: f.writes.filter((item) => /(?:^\/sessions(?:\/quick)?$|^\/sessions\/[^/]+\/(?:start|restart|stop|input)$)/.test(item.path)),
  }
}

async function assertNoErrorsOrOverflow(f) {
  assert.deepEqual(f.errors, [], 'no browser exceptions')
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow')
}

async function mockQuickSessions(f) {
  await f.context.route('**/api/sessions/quick', async (route) => {
    const body = route.request().postDataJSON()
    f.writes.push({ method: 'POST', path: '/sessions/quick', body })
    const quick = { id: 'quick', name: 'Without project', path: '/isolated/quick-chats', is_quick: true }
    if (!f.data.workspaces.some((item) => item.id === quick.id)) f.data.workspaces.push(quick)
    const item = session(`created-${f.data.sessions.length + 1}`, {
      ...body, workspace_id: body.workspace_id || quick.id, quick: !body.workspace_id,
    })
    f.data.sessions.push(item)
    f.data.messages[item.id] = []
    await route.fulfill({ json: item })
  })
}

test('new users enter Chat; a mode change preserves the home draft and provider across reload', async () => {
  const f = await fixture()
  try {
    const { page } = f
    assert.equal(await modeGroup(page).getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('[data-new-terminal-button]:visible').count(), 0, 'Chat hides new-terminal controls')
    const composer = page.getByRole('textbox', { name: 'What do you want to work on?', exact: true })
    await composer.fill('Prepare the weekly report, keeping this as an unsent draft.')
    await page.getByRole('group', { name: 'Chat assistant', exact: true }).getByRole('button', { name: 'Codex', exact: true }).click()
    const before = structuredClone(processMutations(f))
    await setMode(page, 'Dev')
    await page.locator('[data-new-terminal-button]:visible').first().waitFor()
    await page.reload()
    await modeGroup(page).waitFor({ state: 'visible' })
    assert.equal(await modeGroup(page).getByRole('button', { name: 'Dev', exact: true }).getAttribute('aria-pressed'), 'true', 'explicit Dev preference survives reload')
    await setMode(page, 'Chat')
    assert.equal(await composer.inputValue(), 'Prepare the weekly report, keeping this as an unsent draft.')
    assert.equal(await page.getByRole('group', { name: 'Chat assistant', exact: true }).getByRole('button', { name: 'Codex', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.waitForTimeout(250)
    assert.deepEqual(processMutations(f), before, 'changing mode neither creates nor starts a session')
    assert.equal(f.data.sessions.length, 0)
    await assertNoErrorsOrOverflow(f)
    await page.screenshot({ path: `${shots}/${engineName}-chat-home.png` })
  } finally { await f.context.close() }
})

for (const provider of ['claude', 'codex']) {
  test(`the ${provider} selection creates that assistant without a project or setup dialog`, async () => {
    const f = await fixture({
      storage: { [experienceKey]: { mode: 'chat', provider, workspaceId: 'deleted-project' } },
    })
    try {
      await mockQuickSessions(f)
      const label = provider === 'claude' ? 'Claude' : 'Codex'
      const project = f.page.getByRole('combobox', { name: 'Chat project (optional)', exact: true })
      await until(() => project.inputValue().then((value) => value === ''), 'a stale optional project selection falls back to No project')
      assert.equal(await project.locator('option:checked').innerText(), 'No project')
      await f.page.getByRole('group', { name: 'Chat assistant', exact: true }).getByRole('button', { name: label, exact: true }).click()
      const text = `Prepare my ${label} weekly report`
      await f.page.getByRole('textbox', { name: 'What do you want to work on?', exact: true }).fill(text)
      await f.page.locator('[data-home-start]').click()
      await until(() => f.data.sessions.length === 1, 'one session is created')
      const created = f.data.sessions[0]
      assert.equal(created.cli_type, provider, 'creation uses the selected assistant')
      assert.equal(created.workspace_id, 'quick', 'a code project is not required')
      assert.equal(f.writes.find((item) => item.path === '/sessions/quick').body.workspace_id, undefined, 'a deleted project is not sent to the backend')
      assert.equal(f.writes.filter((item) => item.path === '/sessions/quick').length, 1, 'one explicit submission creates one session')
      await f.page.locator(`[data-session-view="${created.id}"] .ive-session-composer textarea`).waitFor({ state: 'visible' })
      assert.equal(await f.page.getByRole('dialog', { name: /New session|New tab|Quick chat/ }).count(), 0, 'no configuration dialog interrupts chat creation')
      // Claude and Codex use the managed input endpoint. WebSocket input is
      // reserved for raw terminal keystrokes and must not be required here.
      await until(() => f.writes.some((item) => item.path === `/sessions/${created.id}/input` && item.body?.message === text), 'the first prompt reaches the managed fixture transport')
      assert.equal(f.writes.filter((item) => item.path === `/sessions/${created.id}/input`).length, 1, 'the first prompt is submitted once')
      assert.equal(await f.page.locator('[data-new-terminal-button]:visible').count(), 0)
      await assertNoErrorsOrOverflow(f)
    } finally { await f.context.close() }
  })
}

test('Chat and Dev preserve the selected session and its draft without starting saved workers', async () => {
  const f = await fixture({
    workspaces: [workspace], sessions: [session('first'), session('second')],
    messages: { first: [{ id: 'first-reply', session_id: 'first', role: 'assistant', content: 'The first conversation keeps its own context.', created_at: '2025-01-01T00:00:00Z' }] },
    storage: {
      [experienceKey]: { mode: 'chat', provider: 'claude' },
      'ive.operator-desk': { activeWorkspaceId: workspace.id, activeSessionId: 'first', openTabs: ['first', 'second'], showHome: false, sessionFocus: false },
    },
  })
  try {
    const { page } = f
    const composer = page.locator('[data-session-view="first"] .ive-session-composer textarea')
    await composer.waitFor({ state: 'visible' })
    await page.getByText('The first conversation keeps its own context.', { exact: true }).waitFor()
    await composer.fill('Keep this unsent draft attached to the first conversation.')
    const before = structuredClone(processMutations(f))
    const navigationBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('ive.operator-desk')))
    await setMode(page, 'Dev')
    await page.locator('[data-new-terminal-button]:visible').first().waitFor()
    await setMode(page, 'Chat')
    await composer.waitFor({ state: 'visible' })
    assert.equal(await composer.inputValue(), 'Keep this unsent draft attached to the first conversation.')
    const navigationAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('ive.operator-desk')))
    assert.equal(navigationAfter.activeSessionId, navigationBefore.activeSessionId, 'mode does not change selection')
    assert.deepEqual(navigationAfter.openTabs, navigationBefore.openTabs, 'mode does not replace or archive open tabs')
    await page.waitForTimeout(250)
    assert.deepEqual(processMutations(f), before, 'view switches do not start, stop, or send to saved workers')
    assert.equal(f.data.sessions.every((item) => item.pty_alive === false), true)
    await page.getByRole('button', { name: /^Conversation second/ }).click()
    const secondComposer = page.locator('[data-session-view="second"] .ive-session-composer textarea')
    await secondComposer.waitFor({ state: 'visible' })
    assert.equal(await secondComposer.inputValue(), '', 'the first draft does not leak into another conversation')
    await secondComposer.fill('A different unsent draft for the second conversation.')
    await page.getByRole('button', { name: /^Conversation first/ }).click()
    await composer.waitFor({ state: 'visible' })
    assert.equal(await composer.inputValue(), 'Keep this unsent draft attached to the first conversation.')
    await page.waitForTimeout(250)
    assert.deepEqual(processMutations(f), before, 'reading another saved conversation does not start a worker')
    await page.locator('[data-sidebar-new-chat]').click()
    await page.locator('[data-home-composer]').waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('dialog', { name: /New session|New tab|Quick chat/ }).count(), 0, 'New chat opens the composer directly')
    assert.equal(f.data.sessions.length, 2, 'opening New chat does not create an empty session')
    await assertNoErrorsOrOverflow(f)
  } finally { await f.context.close() }
})

test('the left sidebar fully collapses on Chat home and session, with persistent reopening and no lost work', async () => {
  const f = await fixture({
    workspaces: [workspace], sessions: [session('sidebar', { pty_alive: true })],
    messages: { sidebar: [{ id: 'sidebar-reply', session_id: 'sidebar', role: 'assistant', content: 'This conversation remains available with the sidebar hidden.', created_at: '2025-01-01T00:00:00Z' }] },
  })
  try {
    const { page } = f
    const sidebar = page.locator('#ive-project-sidebar')
    const header = page.locator('header.ive-header')
    const main = page.locator('main.x-app-main')
    const homeComposer = page.locator('[data-home-composer]')
    await sidebar.waitFor({ state: 'visible' })
    const sidebarWidth = (await sidebar.boundingBox()).width
    const initialMain = await main.boundingBox()
    await homeComposer.fill('Keep my home draft while I make more room.')
    const before = structuredClone(processMutations(f))
    assert.equal(await page.getByRole('button', { name: /^(?:Hide|Show) sidebar$/ }).count(), 1, 'one sidebar control while navigation is open, in the sidebar head')
    await sidebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
    await sidebar.waitFor({ state: 'detached' })
    const reopen = header.getByRole('button', { name: 'Show sidebar', exact: true })
    await reopen.waitFor({ state: 'visible' })
    assert.equal(await reopen.getAttribute('aria-expanded'), 'false')
    assert.equal(await reopen.locator('span').isVisible(), true, 'the collapsed header retains a labelled recovery control')
    const hiddenMain = await main.boundingBox()
    assert.ok(hiddenMain.x <= 1, 'no empty sidebar rail remains')
    assert.ok(hiddenMain.width >= initialMain.width + sidebarWidth - 2, 'the conversation area reclaims the sidebar width')
    assert.equal(await homeComposer.inputValue(), 'Keep my home draft while I make more room.')
    await page.screenshot({ path: `${shots}/${engineName}-chat-home-sidebar-hidden.png` })
    await page.reload()
    await reopen.waitFor({ state: 'visible' })
    assert.equal(await sidebar.count(), 0, 'hidden preference survives reload')
    assert.equal(await page.evaluate(() => localStorage.getItem('ive.sidebar-visible')), 'false')
    assert.equal(await homeComposer.inputValue(), 'Keep my home draft while I make more room.')
    await reopen.click()
    await sidebar.waitFor({ state: 'visible' })
    assert.ok(Math.abs((await main.boundingBox()).width - initialMain.width) <= 2, 'reopening restores the normal layout')
    await sidebar.getByRole('button', { name: /^Conversation sidebar/ }).click()
    const composer = page.locator('[data-session-view="sidebar"] .ive-session-composer textarea')
    await composer.waitFor({ state: 'visible' })
    await composer.fill('Keep this session draft when the navigation closes.')
    await sidebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
    await sidebar.waitFor({ state: 'detached' })
    assert.equal(await composer.inputValue(), 'Keep this session draft when the navigation closes.')
    f.controls.reply('sidebar', 'A new reply arrived while the sidebar was hidden.')
    await page.getByText('A new reply arrived while the sidebar was hidden.', { exact: true }).waitFor()
    assert.equal(await composer.inputValue(), 'Keep this session draft when the navigation closes.')
    await page.screenshot({ path: `${shots}/${engineName}-chat-session-sidebar-hidden.png` })
    await reopen.click()
    await sidebar.waitFor({ state: 'visible' })
    assert.equal(await composer.inputValue(), 'Keep this session draft when the navigation closes.')
    // The header carries no second hide control; the keyboard shortcut is the other entry point.
    assert.equal(await header.getByRole('button', { name: /^(?:Hide|Show) sidebar$/ }).count(), 0, 'no duplicate sidebar control in the header while navigation is open')
    await page.keyboard.press('Meta+Backslash')
    await sidebar.waitFor({ state: 'detached' })
    await page.reload()
    await reopen.waitFor({ state: 'visible' })
    await page.locator('[data-session-view="sidebar"]').waitFor({ state: 'visible' })
    await page.getByText('A new reply arrived while the sidebar was hidden.', { exact: true }).waitFor()
    assert.equal(await sidebar.count(), 0, 'the session reload keeps navigation collapsed')
    assert.equal(f.data.sessions[0].pty_alive, true, 'hiding navigation keeps the live worker attached')
    assert.deepEqual(processMutations(f), before, 'collapse/reopen/reload does not create, start, stop, or send to a worker')
    await assertNoErrorsOrOverflow(f)
  } finally { await f.context.close() }
})

test('the Chat/Dev choice remains reachable at 390px without losing the home draft', async () => {
  const f = await fixture({ width: 390, height: 844, touch: true })
  try {
    const { page } = f
    const composer = page.locator('[data-home-composer]')
    await composer.fill('My mobile draft')
    await setMode(page, 'Dev')
    await setMode(page, 'Chat')
    assert.equal(await composer.inputValue(), 'My mobile draft')
    for (const name of ['Chat', 'Dev']) {
      const box = await modeGroup(page).getByRole('button', { name, exact: true }).boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 391, `${name} is within the phone viewport`)
    }
    assert.equal(await page.locator('[data-new-terminal-button]:visible').count(), 0)
    assert.equal(f.data.sessions.length, 0)
    const sidebarDrawer = page.getByRole('dialog', { name: 'Sidebar', exact: true })
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await sidebarDrawer.waitFor({ state: 'visible' })
    await sidebarDrawer.getByRole('button', { name: 'Close sidebar', exact: true }).click()
    await sidebarDrawer.waitFor({ state: 'hidden' })
    assert.equal(await composer.inputValue(), 'My mobile draft')
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await sidebarDrawer.waitFor({ state: 'visible' })
    await sidebarDrawer.getByRole('button', { name: 'Close sidebar', exact: true }).click()
    await sidebarDrawer.waitFor({ state: 'hidden' })
    assert.equal(await composer.inputValue(), 'My mobile draft', 'phone navigation closes and reopens without losing draft text')
    await assertNoErrorsOrOverflow(f)
    await page.screenshot({ path: `${shots}/${engineName}-chat-phone-390.png` })
  } finally { await f.context.close() }
})

test('dark Chat home and a restored conversation remain readable without page overflow', async () => {
  const f = await fixture({
    theme: 'dark', workspaces: [workspace], sessions: [session('dark')],
    messages: { dark: [{ id: 'dark-reply', session_id: 'dark', role: 'assistant', content: 'Your report is ready.\n\n- Checked three rows.\n- No files changed.', created_at: '2025-01-01T00:00:00Z' }] },
  })
  try {
    await f.page.locator('[data-home-composer]').fill('Prepare a weekly report from my selected files.')
    await f.page.getByRole('group', { name: 'Chat assistant', exact: true }).waitFor({ state: 'visible' })
    await assertNoErrorsOrOverflow(f)
    await f.page.screenshot({ path: `${shots}/${engineName}-chat-home-dark.png` })
    await f.page.getByRole('button', { name: /^Conversation dark/ }).first().click()
    await f.page.locator('[data-session-view="dark"] .ive-session-composer textarea').waitFor({ state: 'visible' })
    await f.page.getByText('Your report is ready.', { exact: true }).waitFor()
    await assertNoErrorsOrOverflow(f)
    assert.deepEqual(processMutations(f), { pty: [], http: [] }, 'opening dark-mode history does not start a worker')
    await f.page.screenshot({ path: `${shots}/${engineName}-chat-session-dark.png` })
  } finally { await f.context.close() }
})

test('Dev remains usable with 100 saved sessions and mode switches do not launch them', async () => {
  const sessions = Array.from({ length: 100 }, (_, index) => session(`saved-${index + 1}`))
  const f = await fixture({
    workspaces: [workspace], sessions,
    storage: {
      [experienceKey]: { mode: 'dev', provider: 'claude' },
      'ive.operator-desk': { activeWorkspaceId: workspace.id, activeSessionId: sessions[0].id, openTabs: sessions.map((item) => item.id), showHome: false, sessionFocus: false },
    },
  })
  try {
    const { page } = f
    await page.locator('[data-new-terminal-button]:visible').first().waitFor()
    try {
      await page.locator('[data-terminal-mode="tile"]:visible').first().waitFor()
    } catch (error) {
      error.message += `\nFixture diagnostics: ${JSON.stringify({ errors: f.errors.slice(0, 5), errorCount: f.errors.length, sessions: f.data.sessions.length, pty: f.data.pty.length, reads: f.reads.length })}`
      await page.screenshot({ path: `${shots}/${engineName}-dev-unexpected.png`, timeout: 1500 }).catch(() => {})
      const view = await Promise.race([page.evaluate(() => ({
        board: !!document.querySelector('[data-board-screen]'),
        tileCount: document.querySelectorAll('[data-terminal-mode="tile"]').length,
        sampleTile: (() => { const el = document.querySelector('[data-terminal-mode="tile"]'); return el ? { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height } : null })(),
        terminalToggle: document.querySelector('[aria-label="Terminal grid"]')?.getAttribute('aria-pressed'),
        savedPreference: localStorage.getItem('cc-terminalBoardMode'),
      })).catch(() => 'page unavailable'), new Promise((resolve) => setTimeout(() => resolve('page unresponsive'), 1500))])
      error.message += `\nDev view diagnostics: ${JSON.stringify(view)}`
      throw new Error(error.message, { cause: error })
    }
    await until(() => page.locator('#ive-project-sidebar [data-session-id]').count().then((count) => count === 100), 'all 100 saved sessions remain in the sidebar')
    await until(() => page.locator('[data-terminal-visible="true"] .xterm').count().then((count) => count > 0), 'visible Dev tiles attach their terminals')
    const initialAttached = await page.locator('[data-terminal-mode="tile"] .xterm').count()
    assert.ok(initialAttached > 0 && initialAttached <= 20, `only viewport terminals are attached initially, received ${initialAttached}`)
    const initialRenderers = await page.locator('.xterm').count()
    assert.ok(initialRenderers > 0 && initialRenderers <= 20, `unvisited stopped sessions defer terminal initialization, received ${initialRenderers}`)
    const lastTile = page.locator('[data-terminal-slot="saved-100"]')
    await lastTile.scrollIntoViewIfNeeded()
    await lastTile.locator('.xterm').waitFor({ state: 'visible' })
    assert.equal(await lastTile.getAttribute('data-terminal-visible'), 'true', 'scrolling to the last saved session attaches its terminal')
    await setMode(page, 'Chat')
    await page.locator('[data-session-view="saved-1"] .ive-session-composer textarea').waitFor({ state: 'visible' })
    await setMode(page, 'Dev')
    await page.locator('[data-new-terminal-button]:visible').first().waitFor()
    await page.locator('[data-terminal-mode="tile"]:visible').first().waitFor()
    await page.waitForTimeout(250)
    assert.equal(f.data.sessions.length, 100)
    assert.deepEqual(processMutations(f), { pty: [], http: [] }, 'loading and switching 100 saved sessions does not start them')
    assert.equal(f.data.sessions.every((item) => item.pty_alive === false && item.archived === 0), true)
    await assertNoErrorsOrOverflow(f)
    await page.screenshot({ path: `${shots}/${engineName}-dev-100-sessions.png` })
  } finally { await f.context.close() }
})
