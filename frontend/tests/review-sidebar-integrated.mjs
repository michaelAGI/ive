import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

test('built review shows scoped changes and explanation without launching work', async () => {
  const browser = await chromium.launch()
  const workspace = { id: 'project', name: 'Customer portal', path: '/isolated/customer-portal' }
  const session = { id: 'review-source', name: 'Fix expired login links', workspace_id: 'project', cli_type: 'claude', model: 'sonnet', status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [], task_id: 'login-task' }
  const diff = 'diff --git a/src/login.js b/src/login.js\nindex 1234567..7654321 100644\n--- a/src/login.js\n+++ b/src/login.js\n@@ -1,3 +1,4 @@\n export function canUseLink(link, now) {\n-  return Boolean(link.token);\n+  if (!link.token) return false;\n+  return now < link.expiresAt;\n }\n'
  const f = await createTourFixture(browser, {
    width: 1440, height: 1000,
    workspaces: [workspace], sessions: [session], diff,
    settings: { product_tour_version: '2', owner_name: 'Review QA' },
    messages: { 'review-source': [{ id: 'answer', role: 'assistant', content: 'The expiry check is implemented. Review the changed condition before continuing.', created_at: '2026-11-05T12:00:00Z' }] },
    storage: { 'ive.onboarding.v2.owner': 'complete', 'cc-sidebarVisible': '1', 'ive.experience-mode.v1': { mode: 'chat', provider: 'claude' }, 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: session.id, openTabs: [session.id], showHome: false, sessionFocus: true } },
  })
  try {
    const explanationCalls = []
    const refreshReads = []
    await f.context.route('**/api/workspaces/project/git/status', route => route.fulfill({ json: { branch: 'fix/login-expiry', staged: [], unstaged: [{ path: 'src/login.js', status: 'M' }], untracked: [] } }))
    await f.context.route('**/api/workspaces/project/git/diff**', route => { refreshReads.push('diff'); return route.fulfill({ json: { diff, truncated: false } }) })
    await f.context.route('**/api/review/explanation/**', async route => {
      const req = route.request(); const body = req.postDataJSON(); explanationCalls.push({ method: req.method(), url: req.url(), body })
      if (req.url().includes('/context?')) { refreshReads.push('context'); return route.fulfill({ json: { session, workspace, scope: 'working', scope_label: 'Not selected for commit', task: { id: 'login-task', title: 'Reject expired login links' }, original_prompt: { text: 'Make sure expired sign-in links cannot be used, without changing valid sign-in links.' }, reason: { text: 'No automatic review trigger is recorded for this conversation.', recorded: false }, files: [{ path: 'src/login.js' }], diff, revision: 'review-v1', scope_warning: 'These are shared project changes. Other sessions or people may have edited these files.' } }) }
      return route.fulfill({ json: { id: body.request_id, status: 'completed', cli_type: body.cli_type, revision: 'review-v1', stale: false, answer: 'The task is to reject expired links while keeping valid links usable. The changed condition now checks the expiry time. Check the boundary at exactly expiresAt and missing timestamps. No automatic review trigger is recorded. A separate reviewer is optional; it can inspect this condition independently.' } })
    })
    await f.page.getByRole('button', { name: 'Review changes', exact: true }).filter({ visible: true }).first().click()
    await f.page.getByText('Reject expired login links', { exact: false }).waitFor()
    await f.page.getByRole('button', { name: /^Start review with Claude/ }).waitFor()
    assert.equal(explanationCalls.filter(c => c.method === 'POST').length, 0)
    const writesBefore = f.writes.length
    await f.page.getByRole('button', { name: 'Explain this', exact: true }).click()
    await f.page.getByText('The task is to reject expired links', { exact: false }).waitFor()
    assert.equal(f.writes.length, writesBefore, 'explanation does not use the normal session write API')
    assert.equal(explanationCalls.filter(c => c.method === 'POST').length, 1)
    assert.ok(await f.page.getByRole('button', { name: /Send feedback to this chat/ }).isDisabled())
    assert.deepEqual(f.errors, [])
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const shots = '/tmp/ive-chat-dev-qa'
    await mkdir(shots, { recursive: true })
    await f.page.screenshot({ path: `${shots}/review-sidebar-integrated.png` })
    const readsBefore = refreshReads.length
    await f.page.getByRole('button', { name: 'Refresh review context' }).click()
    await f.page.waitForFunction(() => !document.querySelector('.ive-review-explain-controls button').disabled)
    assert.deepEqual(refreshReads.slice(readsBefore), ['diff', 'context'], 'refresh loads visible changes before capturing explanation context')
    await f.page.getByRole('button', { name: /^Start review with Claude/ }).click()
    await f.page.getByRole('dialog', { name: 'Start a code review' }).waitFor()
    assert.equal(f.data.sessions.length, 1, 'opening the concrete reviewer configuration does not start a worker')
    await f.page.screenshot({ path: `${shots}/review-start-dialog.png` })
    await f.page.getByRole('dialog', { name: 'Start a code review' }).getByRole('button', { name: 'Cancel', exact: true }).click()
    const contextsBeforeFailure = explanationCalls.filter(c => c.url.includes('/context?')).length
    await f.context.route('**/api/workspaces/project/git/diff**', route => route.fulfill({ status: 503, json: { error: 'Changes unavailable' } }))
    await f.page.getByRole('button', { name: 'Refresh review context' }).click()
    await f.page.locator('[data-review-context] [role="alert"]').filter({ hasText: 'Could not refresh the visible changes.' }).waitFor()
    assert.equal(explanationCalls.filter(c => c.url.includes('/context?')).length, contextsBeforeFailure, 'failed visible diff refresh never captures new explanation context')
    assert.ok(await f.page.getByRole('button', { name: 'Explain this', exact: true }).isDisabled())
  } finally { await f.context.close(); await browser.close() }
})
