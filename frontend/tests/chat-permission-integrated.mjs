import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const screen = `Bash command
npm test -- login
Run the focused login tests.

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for npm test commands in /isolated/login
  3. No

Esc to cancel · Tab to amend`

for (const [label, choice] of [['Allow once', '1'], ['Don’t allow', '3']]) {
  test(`Chat permission card sends ${label} once against the exact request without a terminal`, async () => {
    const browser = await chromium.launch()
    const session = { id: 'permission', name: 'Check login behavior', workspace_id: 'w', cli_type: 'claude', model: 'sonnet', permission_mode: 'default', status: 'waiting', agentState: 'waiting', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }
    const f = await createTourFixture(browser, {
      workspaces: [{ id: 'w', name: 'Login project', path: '/isolated/login' }], sessions: [session],
      settings: { product_tour_version: '2', owner_name: 'Approval QA' },
      messages: { permission: [{ id: 'ready', session_id: 'permission', role: 'assistant', content: 'I am ready to run the focused login tests.', created_at: '2026-11-05T12:00:00Z' }] },
      storage: { 'ive.onboarding.v2.owner': 'complete', 'ive.experience-mode.v1': { mode: 'chat', provider: 'claude' }, 'cc-sidebarVisible': '1', 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: session.id, openTabs: [session.id], showHome: false, sessionFocus: true } },
    })
    try {
      const inputs = []
      await f.context.route('**/api/sessions/permission/output?**', route => route.fulfill({ json: { screen, text: screen, permission_view_state: 'ready' } }))
      await f.context.route('**/api/sessions/permission/input', async route => {
        inputs.push(route.request().postDataJSON())
        await route.fulfill({ json: { ok: true, session_id: 'permission' } })
      })
      const card = f.page.locator('[data-session-prompt-actions]:visible')
      await card.getByText('Claude wants to run a command').waitFor()
      assert.ok(await card.getByText('npm test -- login', { exact: true }).isVisible())
      assert.equal(await f.page.locator('.xterm:visible').count(), 0)
      assert.equal(await f.page.locator('[data-session-terminal-drawer]').count(), 0)
      if (choice === '1') {
        await mkdir('/tmp/ive-chat-dev-qa', { recursive: true })
        await f.page.screenshot({ path: '/tmp/ive-chat-dev-qa/chat-permission-card.png' })
      }
      await card.getByRole('button', { name: label, exact: true }).click()
      await card.getByText('Reply sent', { exact: true }).waitFor()
      await f.page.waitForTimeout(200)
      assert.deepEqual(inputs, [{ message: choice, expected_screen: screen, ready_timeout: 0 }])
      assert.equal(await f.page.locator('.xterm:visible').count(), 0)
      assert.equal(f.writes.filter(item => /permission-mode/.test(item.path)).length, 0, 'answering a request does not relax permission policy')
      assert.deepEqual(f.errors, [])
    } finally { await f.context.close(); await browser.close() }
  })
}
