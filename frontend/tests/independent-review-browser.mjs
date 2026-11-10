import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium
const shots = process.env.IVE_SHOT_DIR || '/tmp/ive-independent-review-qa'
const workspace = { id: 'project', name: 'Customer portal', path: '/isolated/customer-portal', default_worktree: true }
const worker = { id: 'worker', name: 'Fix expired login links', workspace_id: 'project', cli_type: 'claude', model: 'sonnet', status: 'idle', agentState: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }
const diff = 'diff --git a/src/login.js b/src/login.js\n--- a/src/login.js\n+++ b/src/login.js\n@@ -1 +1,2 @@\n-export const valid = token => !!token;\n+export const valid = token => !!token && Date.now() <= token.expiresAt;\n+// Literal syntax examples: @ralph @research check @ticket:worker\n'

test('independent review requires source context, creates a fresh isolated session, and distinguishes follow-up', async () => {
  const browser = await engine.launch()
  const f = await createTourFixture(browser, {
    width: 1440, height: 1000, workspaces: [workspace], sessions: [worker], diff,
    settings: { product_tour_version: '2', owner_name: 'Review QA' },
    messages: { worker: [{ id: 'result', role: 'assistant', content: 'WORKER_SUCCESS: everything implemented, tests green.', created_at: '2026-11-10T10:00:00Z' }] },
    storage: { 'ive.onboarding.v2.owner': 'complete', 'cc-sidebarVisible': '1', 'ive.experience-mode.v1': { mode: 'chat', provider: 'claude' }, 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: 'worker', openTabs: ['worker'], showHome: false, sessionFocus: true } },
  })
  try {
    let failContext = true
    const briefs = []
    await f.context.route('**/api/workspaces/project/git/status', route => route.fulfill({ json: { branch: 'fix/expiry', staged: [], unstaged: [{ path: 'src/login.js', status: 'M' }], untracked: [] } }))
    await f.context.route('**/api/workspaces/project/git/diff**', route => route.fulfill({ json: { diff, truncated: false } }))
    await f.context.route('**/api/review/brief', route => {
      const body = route.request().postDataJSON(); briefs.push(body)
      return failContext
        ? route.fulfill({ status: 503, json: { error: 'Source temporarily unavailable' } })
        : route.fulfill({ json: { brief: `Original task: reject tokens at and after their expiry time.\n\n${body.instructions}` } })
    })
    await f.page.getByRole('button', { name: 'Review changes', exact: true }).filter({ visible: true }).first().click()
    await f.page.getByRole('button', { name: /^Start review with Claude/ }).click()
    const dialog = f.page.getByRole('dialog', { name: 'Start a code review' })
    await dialog.waitFor()
    await f.page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.getByRole('button', { name: /^Start review with Claude/ }).evaluate(element => element === document.activeElement), true, 'keyboard focus stays in the dialog')
    await f.page.keyboard.press('Tab')
    assert.equal(await dialog.getByRole('button', { name: 'Close review setup' }).evaluate(element => element === document.activeElement), true)
    assert.equal(await dialog.getByRole('button', { name: /Independent review/ }).getAttribute('aria-pressed'), 'true')
    assert.match(await dialog.getByRole('status').innerText(), /without the working agent/)
    await dialog.getByRole('button', { name: /Existing conversation/ }).click()
    assert.match(await dialog.getByRole('status').innerText(), /keeps its earlier context/)
    await dialog.getByRole('button', { name: /Independent review/ }).click()
    await f.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await f.page.getByRole('button', { name: /^Start review with Claude/ }).click()
    await dialog.waitFor()
    await dialog.getByRole('button', { name: /^Start review with Claude/ }).click()
    await dialog.getByRole('alert').filter({ hasText: 'Could not prepare the original task' }).waitFor()
    assert.equal(f.data.sessions.length, 1, 'missing source does not spawn a context-free reviewer')
    assert.equal(f.data.pty.filter(item => item.action === 'input').length, 0)
    failContext = false
    await mkdir(shots, { recursive: true })
    await f.page.screenshot({ path: `${shots}/review-context-retry-${engine.name()}.png` })
    await dialog.getByRole('button', { name: /^Start review with Claude/ }).click()
    await dialog.waitFor({ state: 'hidden' })
    await assertEventually(() => Object.values(f.data.messages).flat().some(item => item.role === 'user' && item.content.includes('Original task: reject tokens')))
    const reviewer = f.data.sessions.find(item => item.id !== 'worker')
    assert.ok(reviewer)
    assert.deepEqual(reviewer.tags, ['independent_review'])
    assert.equal(reviewer.worktree, false, 'reviewer inspects the same workspace as the diff even when new worktrees are the default')
    const request = f.data.messages[reviewer.id].find(item => item.role === 'user')
    assert.match(request.content, /Date.now\(\) <= token.expiresAt/)
    assert.match(request.content, /record the commands and observed results/)
    assert.doesNotMatch(request.content, /WORKER_SUCCESS/)
    assert.match(request.content, /Literal syntax examples: @ralph @research check @ticket:worker/)
    assert.equal(f.data.runs.length, 0, 'tokens quoted in reviewed code never launch a pipeline')
    assert.equal(f.writes.some(call => call.path.includes('/research')), false, 'quoted tokens never launch research')
    assert.equal(f.data.messages.worker.length, 1, 'original worker receives no review input')
    assert.equal(briefs.length, 2, 'retry composes context again')
    assert.deepEqual(f.errors, [])
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  } finally { await f.context.close(); await browser.close() }
})

async function assertEventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(check(), 'expected review request to reach its new session')
}

test('optional review instructions stay in the same dialog and fit a narrow window', async () => {
  const browser = await engine.launch()
  const f = await createTourFixture(browser, {
    width: 1024, height: 768, workspaces: [workspace], sessions: [worker], diff,
    settings: { product_tour_version: '2', owner_name: 'Review QA' },
    storage: { 'ive.onboarding.v2.owner': 'complete', 'ive.experience-mode.v1': { mode: 'chat', provider: 'claude' }, 'ive.operator-desk': { activeWorkspaceId: 'project', activeSessionId: 'worker', openTabs: ['worker'], showHome: false, sessionFocus: true } },
  })
  try {
    await f.context.route('**/api/workspaces/project/git/status', route => route.fulfill({ json: { branch: 'fix/expiry', staged: [], unstaged: [{ path: 'src/login.js', status: 'M' }], untracked: [] } }))
    await f.context.route('**/api/workspaces/project/git/diff**', route => route.fulfill({ json: { diff, truncated: false } }))
    await f.page.getByRole('button', { name: 'Review changes', exact: true }).filter({ visible: true }).first().click()
    await f.page.getByRole('button', { name: /^Start review with Claude/ }).click()
    const setup = f.page.getByRole('dialog', { name: 'Start a code review' })
    await setup.getByRole('button', { name: 'Edit instructions', exact: true }).click()
    const advanced = setup
    assert.equal(await setup.getByRole('textbox', { name: 'Review instructions' }).evaluate(element => element === document.activeElement), true)
    assert.match(await setup.getByRole('textbox', { name: 'Review instructions' }).inputValue(), /Review the selected changes independently/)
    // Below 768px IVE switches to its separate phone UI (no review sidebar).
    await f.page.setViewportSize({ width: 768, height: 700 })
    await mkdir(shots, { recursive: true })
    await f.page.screenshot({ path: `${shots}/review-instructions-${engine.name()}.png` })
    const bounds = await advanced.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 768, 'dialog fits the window')
    assert.equal(f.data.sessions.length, 1, 'setup never starts work')
    await f.page.keyboard.press('Escape')
    await advanced.waitFor({ state: 'hidden' })
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close(); await browser.close() }
})
