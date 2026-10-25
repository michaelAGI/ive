import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acceptPayload, autoTestEnabled, branchLine, changedFiles, changesErrorText, cleanSummary, filesChangedCount, filesChangedLabel,
  hasReviewTab, originChip, relativePath, resultText, reviewSessionId, reviewTabFirst, sendBackPayload, sessionDotState,
  taskOrigin, verificationBadge, verificationState,
} from '../src/lib/taskReview.js'

// Pure helpers behind the review card and the Review tab. The task rows mirror
// the lane contract for GET /api/tasks; older rows lack the review fields.

test('origin chips follow the backend origin and fall back to labels', () => {
  assert.deepEqual(originChip({ origin: 'guided' }), { origin: 'guided', label: 'Guided task' })
  assert.deepEqual(originChip({ origin: 'agent' }), { origin: 'agent', label: 'Reported by agent' })
  // The "2 h" never wraps: non-breaking space.
  assert.deepEqual(originChip({ origin: 'backstop' }), { origin: 'backstop', label: 'Auto-documented, session idle 2\u00a0h' })
  assert.equal(originChip({ origin: 'user' }), null)
  assert.equal(originChip({}), null)
  assert.equal(taskOrigin({ labels: ['ive-guided'] }), 'guided')
  assert.equal(taskOrigin({ labels: '["auto-triage"]' }), 'backstop')
  assert.equal(taskOrigin({ labels: 'auto-triage, docs' }), 'backstop')
  assert.equal(taskOrigin({ latest_run_id: 'run-1' }), 'guided')
  assert.equal(taskOrigin({ origin: 'something-else', labels: [] }), 'user')
})

test('verification badges name the four states and default to not verified', () => {
  assert.deepEqual(verificationBadge({ verification: 'passed' }), { state: 'passed', label: 'Verified', tone: 'good' })
  assert.equal(verificationBadge({ verification: 'failed' }).label, 'Checks failed')
  assert.equal(verificationBadge({ verification: 'running' }).label, 'Tests running')
  assert.equal(verificationBadge({ verification: 'none' }).label, 'Not verified')
  assert.equal(verificationBadge({}).label, 'Not verified')
  assert.equal(verificationState({ status: 'testing' }), 'running')
  assert.equal(verificationState({ verification: 'PASSED' }), 'passed')
})

test('result text prefers the backend summary and skips pipeline boilerplate', () => {
  assert.equal(resultText({ result_text: 'Added the rate limiter.', result_summary: 'ignored' }), 'Added the rate limiter.')
  assert.equal(resultText({ result_summary: '__pipeline_result:pass:Two tests added.' }), 'Two tests added.')
  assert.equal(resultText({ result_summary: 'waiting_for_plan_approval: resume', latest_run_summary: 'Implemented the endpoint.' }), 'Implemented the endpoint.')
  assert.equal(resultText({ result_summary: 'Pick up task: Fix login\nTask ID: 1', task_summary: 'Fixed the login redirect.' }), 'Fixed the login redirect.')
  assert.equal(resultText({ latest_run_summary: '', current_focus: 'Refactoring the auth module' }), 'Refactoring the auth module')
  assert.equal(resultText({}), '')
  assert.equal(cleanSummary(null), '')
  assert.equal(cleanSummary('  plain text  '), 'plain text')
})

test('files are shown relative to the workspace or worktree, deduplicated and capped', () => {
  const roots = ['/Users/me/project', '/Users/me/project/.ive/worktrees/lane-a/']
  assert.equal(relativePath('/Users/me/project/src/app.js', roots), 'src/app.js')
  assert.equal(relativePath('/Users/me/project/.ive/worktrees/lane-a/src/app.js', roots), 'src/app.js')
  assert.equal(relativePath('./src/app.js', roots), 'src/app.js')
  assert.equal(relativePath('src/app.js', []), 'src/app.js')
  assert.equal(relativePath('/Users/me/project', roots), '.')
  assert.equal(relativePath('/elsewhere/file.js', roots), '/elsewhere/file.js')
  const task = { files_changed: ['/Users/me/project/a.js', 'a.js', { path: 'b.js' }, '', null, 'c.js'], files_changed_count: 7 }
  assert.deepEqual(changedFiles(task, ['/Users/me/project']), ['a.js', 'b.js', 'c.js'])
  assert.equal(filesChangedCount(task, ['/Users/me/project']), 7)
  assert.equal(filesChangedCount({ files_changed: ['x.js'], files_changed_count: 0 }), 1)
  assert.deepEqual(changedFiles({ files_changed: '["x.js","y.js"]' }), ['x.js', 'y.js'])
  assert.deepEqual(changedFiles({ files_changed: 'not json' }), [])
  assert.equal(changedFiles({ files_changed: Array.from({ length: 80 }, (_, i) => `f${i}.js`) }).length, 50)
  assert.equal(filesChangedLabel(0), 'No files recorded')
  assert.equal(filesChangedLabel(1), '1 file changed')
  assert.equal(filesChangedLabel(7), '7 files changed')
})

test('accept sends reviewed_run_id only with a passing verification; send back carries the note', () => {
  assert.deepEqual(acceptPayload({ latest_run_id: 'run-9', verification: 'passed' }), { status: 'done', reviewed_run_id: 'run-9' })
  // The backend answers 409 for a run without a passing verify stage.
  for (const verification of ['failed', 'running', 'none', undefined]) {
    assert.deepEqual(acceptPayload({ latest_run_id: 'run-9', verification }), { status: 'done' }, String(verification))
  }
  assert.deepEqual(acceptPayload({ latest_run_id: null, verification: 'passed' }), { status: 'done' })
  assert.deepEqual(acceptPayload({}), { status: 'done' })
  assert.deepEqual(sendBackPayload('  Add the missing test.  '), { note: 'Add the missing test.', revision_notes: 'Add the missing test.' })
  assert.deepEqual(sendBackPayload(undefined), { note: '', revision_notes: '' })
})

test('the agent dot uses the session vocabulary', () => {
  assert.equal(sessionDotState({}), null)
  assert.equal(sessionDotState({ assigned_session_name: 'Worker', assigned_session_status: 'running', assigned_session_alive: true }), 'running')
  assert.equal(sessionDotState({ assigned_session_name: 'Worker', assigned_session_status: 'prompting', assigned_session_alive: true }), 'waiting')
  assert.equal(sessionDotState({ assigned_session_name: 'Worker', assigned_session_status: 'idle', assigned_session_alive: true }), 'done')
  assert.equal(sessionDotState({ assigned_session_name: 'Worker', assigned_session_status: 'idle', assigned_session_alive: false }), 'stopped')
  assert.equal(sessionDotState({ assigned_session_name: 'Worker', assigned_session_status: 'exited' }), 'stopped')
  assert.equal(sessionDotState({ assigned_session_name: 'Worker', assigned_session_status: 'auth_failed', assigned_session_alive: true }), 'failed')
  assert.equal(sessionDotState({ assigned_session_id: 's1' }), 'stopped')
})

test('review tab, session and branch helpers tolerate sparse rows', () => {
  assert.equal(hasReviewTab({ status: 'review' }), true)
  assert.equal(hasReviewTab({ status: 'done', latest_run_id: 'run-1' }), true)
  assert.equal(hasReviewTab({ status: 'todo' }), false)
  assert.equal(hasReviewTab({ status: 'in_progress', latest_run_id: 'run-1' }), true)
  for (const status of ['review', 'testing', 'done']) assert.equal(reviewTabFirst({ status, latest_run_id: 'run-1' }), true, status)
  assert.equal(reviewTabFirst({ status: 'review' }), true)
  for (const status of ['in_progress', 'planning', 'todo', 'blocked']) assert.equal(reviewTabFirst({ status, latest_run_id: 'run-1' }), false, status)
  assert.equal(reviewTabFirst({ status: 'done' }), false)
  assert.equal(changesErrorText('fatal: not a git repository (or any of the parent directories): .git'), 'This folder is not a git repository, so no diff is available.')
  assert.equal(changesErrorText('HTTP 500'), 'HTTP 500')
  assert.equal(changesErrorText(''), 'Changes could not be loaded.')
  assert.equal(reviewSessionId({ assigned_session_id: 'a', last_agent_session_id: 'b' }), 'a')
  assert.equal(reviewSessionId({ last_agent_session_id: 'b' }), 'b')
  assert.equal(reviewSessionId({}), null)
  assert.equal(branchLine({ branch_label: 'lane/lane-c', worktree_path: '/tmp/wt' }), 'lane/lane-c · worktree /tmp/wt')
  assert.equal(branchLine({}), '')
  assert.equal(autoTestEnabled({ auto_test_enabled: 1 }), true)
  assert.equal(autoTestEnabled({ auto_test_enabled: true }), true)
  assert.equal(autoTestEnabled({ auto_test_enabled: 0 }), false)
  assert.equal(autoTestEnabled(undefined), false)
})
