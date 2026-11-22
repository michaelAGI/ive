// The actual production build, with isolated HTTP and PTY transports.
// Exercises both desktop shortcut semantics and the Mac browser fallback.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium
const browser = await engine.launch()
const shots = process.env.IVE_SHOT_DIR || '/tmp/ive-terminal-tabs-qa'
await mkdir(shots, { recursive: true })
const until = async (read, message) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
let checks = 0
const check = (ok, label) => { assert.ok(ok, label); checks++; console.log(`PASS ${label}`) }

try {
  for (const desktop of [false, true]) {
    const mode = desktop ? 'desktop' : 'browser'
    const mod = desktop ? 'Meta' : 'Control'
    const wrappedBrowser = { newContext: async (options) => {
      const context = await browser.newContext(options)
      await context.addInitScript((desktop) => {
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
        if (desktop) { window.__TAURI__ = {}; window.__IVE_BACKEND__ = location.origin }
      }, desktop)
      return context
    } }
    const project = { id: 'project', name: 'Project', path: '/isolated/terminal-project', default_worktree: 0 }
    const f = await createTourFixture(wrappedBrowser, {
      workspaces: [project], settings: { product_tour_version: '2', owner_name: 'Terminal QA' },
      storage: { 'ive.experience-mode.v1': { mode: 'dev', provider: 'claude' }, 'ive.onboarding.v2.owner': 'complete', 'ive.operator-desk': { openTabs: [], showHome: true, activeWorkspaceId: null } },
    })
    try {
      const { page } = f
      await page.locator('[data-sidebar-new-chat]').waitFor()
      await page.route('**/api/sessions/quick', async (route) => {
        const body = route.request().postDataJSON()
        f.writes.push({ method: 'POST', path: '/sessions/quick', body })
        const quick = { id: 'quick', name: 'Without project', path: '/isolated/ive-tour', is_quick: true }
        if (!f.data.workspaces.some((w) => w.id === quick.id)) f.data.workspaces.push(quick)
        const session = { ...body, id: `shell-${f.data.sessions.length}`, workspace_id: quick.id, quick: true, session_type: 'shell', status: 'idle', pty_alive: false, archived: 0 }
        f.data.sessions.push(session)
        await route.fulfill({ json: session })
      })
      await page.keyboard.press(`${mod}+t`)
      await until(() => f.data.sessions.length === 1, `${mode}: shortcut creates a shell`)
      const first = f.data.sessions[0].id
      await page.locator(`[data-session-view="${first}"] .xterm`).waitFor({ state: 'visible' })
      await until(() => page.evaluate(() => !!document.activeElement?.closest('.xterm')), 'New shell receives keyboard focus')
      check(f.data.sessions[0].cli_type === 'shell', `${mode}: new terminal uses the login shell, with no agent setup`)
      check(await page.getByRole('tab', { selected: true }).count() === 1, `${mode}: terminal is an active tab`)
      await page.keyboard.type('echo terminal-tabs-check')
      await page.keyboard.press('Enter')
      await until(() => f.data.pty.filter((p) => p.action === 'input').map((p) => p.data).join('').includes('echo terminal-tabs-check'), 'Input reaches the PTY')
      check(true, `${mode}: focused terminal forwards typed commands to the PTY`)
      const starts = () => f.data.pty.filter((p) => p.action === 'start_pty' && p.session_id === first).length
      const before = starts()
      await page.keyboard.press(`${mod}+t`)
      await until(() => f.data.sessions.length === 2, 'Second shortcut creates a second tab')
      const second = f.data.sessions[1].id
      await page.locator(`[data-session-view="${second}"] .xterm`).waitFor({ state: 'visible' })
      await page.locator(`[role="tab"][data-tab-id="${first}"]`).click()
      await page.locator(`[data-session-view="${first}"] .xterm`).waitFor({ state: 'visible' })
      check(starts() === before, `${mode}: switching tabs preserves the first PTY`)
      check(await page.getByRole('tab').count() === 2, `${mode}: both terminal tabs remain open`)

      // Project selection still opens a direct shell, and agent setup stays available.
      await page.locator('[data-sidebar-new-chat]').click()
      const chooser = page.getByRole('dialog', { name: 'New tab' })
      await chooser.waitFor()
      check(await chooser.getByText('Quick chat', { exact: true }).count() === 0, `${mode}: Terminal replaces Quick chat`)
      await page.screenshot({ path: `${shots}/${mode}-chooser.png` })
      await chooser.locator('#session-entry-project').selectOption('project')
      await chooser.getByRole('button', { name: /^Terminal Your shell/ }).click()
      await until(() => f.data.sessions.length === 3, 'Chosen project creates terminal')
      const third = f.data.sessions[2].id
      check(f.data.sessions[2].workspace_id === 'project' && f.data.sessions[2].cli_type === 'shell', `${mode}: project choice is honored`)
      await page.locator(`[data-session-view="${third}"] .xterm`).waitFor({ state: 'visible' })
      await page.keyboard.press(`${mod}+t`)
      await until(() => f.data.sessions.length === 4, 'Shortcut inherits active project')
      check(f.data.sessions[3].workspace_id === 'project', `${mode}: next tab inherits the active terminal's project`)
      await page.locator(`[data-session-view="${f.data.sessions[3].id}"] .xterm`).waitFor({ state: 'visible' })
      await until(() => page.getByRole('tab').count().then((count) => count === 4), 'Four tabs are rendered')
      await until(() => f.data.sessions[3].pty_alive, 'The new terminal has a running PTY')
      await page.waitForTimeout(150) // let the fixture's prompt reach xterm and paint
      await page.screenshot({ path: `${shots}/${mode}-tabs.png` })

      const fourth = f.data.sessions[3].id
      const tabOrder = () => page.locator('[data-terminal-tabs] [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId))
      const expectOrder = async (expected, label) => {
        await until(async () => JSON.stringify(await tabOrder()) === JSON.stringify(expected), label)
        const keys = await page.locator('[data-terminal-tabs] .ive-terminal-tab-shortcut').allTextContents()
        assert.deepEqual(keys, expected.slice(0, 9).map((_, i) => `${desktop ? '⌘' : '⌃'}${i + 1}`), `${mode}: displayed positions follow ${label}`)
        check(true, `${mode}: ${label}`)
      }
      const switchTo = async (position, id) => {
        await page.keyboard.press(`${mod}+${position}`, { delay: 80 })
        await page.locator(`[data-session-view="${id}"] .xterm`).waitFor({ state: 'visible' })
        check(await page.locator(`[data-terminal-tabs] [data-tab-id="${id}"]`).getAttribute('aria-selected') === 'true', `${mode}: ${mod}+${position} activates visible tab ${position}`)
      }
      await page.evaluate(() => {
        window.__tabOrderTerminalNodes = Object.fromEntries([...document.querySelectorAll('.ive-terminal-portal .xterm')]
          .map((node) => [node.closest('.ive-terminal-portal').dataset.terminalSession, node]))
      })
      const startsBeforeReorder = f.data.pty.filter((p) => p.action === 'start_pty').length
      await page.locator(`[data-terminal-tabs] [data-tab-id="${first}"]`).dragTo(page.locator(`[data-session-view="${fourth}"] .xterm`))
      await expectOrder([first, second, third, fourth], 'dropping outside the tab bar cancels the move')
      check(await page.locator(`[data-terminal-tabs] [data-tab-id="${fourth}"]`).getAttribute('aria-selected') === 'true', `${mode}: cancelled dragging does not select a different terminal`)
      await page.locator(`[data-terminal-tabs] [data-tab-id="${fourth}"]`).dragTo(
        page.locator(`[data-terminal-tabs] [data-tab-id="${first}"]`), { targetPosition: { x: 3, y: 15 } })
      await expectOrder([fourth, first, second, third], 'drag last tab before the first')
      await switchTo(1, fourth)
      const thirdTab = page.locator(`[data-terminal-tabs] [data-tab-id="${third}"]`)
      const thirdBox = await thirdTab.boundingBox()
      await page.locator(`[data-terminal-tabs] [data-tab-id="${first}"]`).dragTo(thirdTab,
        { targetPosition: { x: thirdBox.width - 3, y: 15 } })
      await expectOrder([fourth, second, third, first], 'drag a tab after the last')
      check(await page.locator(`[data-terminal-tabs] [data-tab-id="${fourth}"]`).getAttribute('aria-selected') === 'true', `${mode}: dragging changes order without changing the active terminal`)
      for (const [index, id] of [fourth, second, third, first].entries()) await switchTo(index + 1, id)
      check(f.data.pty.filter((p) => p.action === 'start_pty').length === startsBeforeReorder,
        `${mode}: reordering and shortcuts never restart a terminal`)
      check(await page.evaluate(() => Object.entries(window.__tabOrderTerminalNodes).every(([id, node]) =>
        document.querySelector(`.ive-terminal-portal[data-terminal-session="${id}"] .xterm`) === node)), `${mode}: reordering preserves the xterm instances`)

      // A keyboard alternative to dragging uses the same identity-based ordering.
      await page.locator(`[data-terminal-tabs] [data-tab-id="${first}"]`).focus()
      await page.keyboard.press('Alt+Shift+ArrowLeft')
      await expectOrder([fourth, second, first, third], 'keyboard reorder moves the same session')
      await switchTo(3, first)
      // Close a tab before the active one, then the active first tab: labels and
      // shortcuts must compact immediately, with no gaps or stale indices.
      await page.locator(`[data-terminal-tabs] .ive-terminal-tab`).filter({ has: page.locator(`[data-tab-id="${second}"]`) })
        .getByRole('button', { name: /^Close Terminal/ }).click()
      await expectOrder([fourth, first, third], 'closing a preceding tab renumbers remaining tabs')
      await switchTo(2, first)
      await switchTo(1, fourth)
      await page.keyboard.press(`${mod}+w`, { delay: 80 })
      await expectOrder([first, third], 'closing the first tab makes its right neighbor number one')
      await switchTo(1, first)
      // Returning to the app keeps the reordered sequence, not creation order.
      await until(async () => page.evaluate((expected) => JSON.parse(localStorage.getItem('ive.operator-desk') || '{}').openTabs?.join(',') === expected, [first, third].join(',')), 'Reordered tabs persisted')
      await page.reload()
      await expectOrder([first, third], 'tab order survives reload')
      await switchTo(1, first)
      await page.keyboard.press(`${mod}+t`, { delay: 80 })
      await until(() => f.data.sessions.length === 5, 'New tab opens after reordered tabs')
      const fifth = f.data.sessions[4].id
      await expectOrder([first, third, fifth], 'new tab gets the next available shortcut')
      await switchTo(3, fifth)
      await page.screenshot({ path: `${shots}/${mode}-reordered.png` })
      await page.locator('[data-sidebar-new-chat]').click()
      await chooser.getByRole('button', { name: /^Session Choose an agent/ }).click()
      await page.getByRole('button', { name: 'Create Session', exact: true }).waitFor()
      check(true, `${mode}: Session still opens the full agent setup`)
      await page.keyboard.press('Escape')

      // A failed request keeps current tabs, reports the error and permits retry.
      const count = f.data.sessions.length
      await page.route('**/api/sessions', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        await route.fulfill({ status: 503, json: { error: 'Terminal test: unavailable' } })
      })
      await page.locator('[data-new-terminal-button]').first().click()
      await page.getByText('Terminal test: unavailable', { exact: true }).first().waitFor()
      check(f.data.sessions.length === count, `${mode}: failed creation preserves existing tabs and shows an error`)
      await page.unroute('**/api/sessions')
      await page.locator('[data-new-terminal-button]').first().click()
      await until(() => f.data.sessions.length === count + 1, 'Retry after failed creation works')
      check(true, `${mode}: retry creates a terminal after an API error`)
      const retryId = f.data.sessions.at(-1).id
      await page.locator(`[data-tab-id="${retryId}"]`).waitFor()
      await page.locator('[data-terminal-tabs] .ive-terminal-tab').last().getByRole('button', { name: /^Close Terminal/ }).click()
      await page.locator(`[data-tab-id="${retryId}"]`).waitFor({ state: 'detached' })
      check(f.data.sessions.find((s) => s.id === retryId)?.archived === 1 && await page.getByRole('tab').count() === count - 2, `${mode}: closing a tab preserves other tabs and archives its history`)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.locator('[data-terminal-tabs]').waitFor({ state: 'detached' })
      await page.screenshot({ path: `${shots}/${mode}-mobile.png` })
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}: narrow layout has no horizontal overflow`)
      check(f.errors.length === 0, `${mode}: no browser exceptions: ${f.errors.join('; ')}`)
    } finally { await f.context.close() }

    const empty = await createTourFixture(wrappedBrowser, {
      workspaces: [], settings: { product_tour_version: '2', owner_name: 'Terminal QA' },
      storage: { 'ive.experience-mode.v1': { mode: 'dev', provider: 'claude' }, 'ive.operator-desk': { openTabs: [], showHome: true } },
    })
    try {
      await empty.page.locator('[data-sidebar-new-chat]').waitFor()
      await empty.page.route('**/api/sessions/quick', async (route) => {
        const body = route.request().postDataJSON()
        const session = { ...body, id: 'unattached-shell', workspace_id: 'quick', quick: true, session_type: 'shell', status: 'idle', pty_alive: false, archived: 0 }
        empty.writes.push({ path: '/sessions/quick', body })
        empty.data.sessions.push(session)
        await route.fulfill({ json: session })
      })
      await empty.page.keyboard.press(`${mod}+t`)
      await empty.page.locator('[data-session-view="unattached-shell"] .xterm').waitFor({ state: 'visible' })
      check(empty.writes.some((w) => w.path === '/sessions/quick' && w.body.cli_type === 'shell'), `${mode}: no project is needed to open a terminal`)
      check(empty.errors.length === 0, `${mode}: empty-workspace start has no browser exceptions`)
    } finally { await empty.context.close() }
  }
  console.log(`${checks} terminal-tab checks passed`)
} finally { await browser.close() }
