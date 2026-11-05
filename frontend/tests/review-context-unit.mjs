import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explanationProviderFields, reviewContextSummary, reviewTarget } from '../src/lib/reviewContext.js'

test('review targets bind to the viewed session and its linked task only', () => {
  assert.equal(reviewTarget(null), null)
  assert.deepEqual(reviewTarget({ id: 'chat-a', active_ticket_id: 'task-a' }, 'staged', 'src/a.js'), {
    reviewed_session_id: 'chat-a', scope: 'staged', selected_file: 'src/a.js', task_id: 'task-a',
  })
  assert.deepEqual(reviewTarget({ id: 'chat-b' }, 'untrusted-value'), { reviewed_session_id: 'chat-b', scope: 'working' })
})

test('provider changes never reuse the other provider model or account', () => {
  const session = { cli_type: 'claude', model: 'opus', account_id: 'private-claude-account' }
  assert.deepEqual(explanationProviderFields(session, 'claude'), { cli_type: 'claude', model: 'opus', account_id: 'private-claude-account' })
  assert.deepEqual(explanationProviderFields(session, 'codex'), { cli_type: 'codex' })
})

test('unrecorded provenance stays unknown and shared edits are not attributed to one agent', () => {
  const unknown = reviewContextSummary(null, { session: { name: 'Fix login' }, workspace: { name: 'App' }, scope: 'working' })
  assert.match(unknown.reason, /No review trigger is recorded/)
  assert.match(unknown.warning, /more than one session or person/)
  assert.equal(unknown.scope, 'Not selected for commit')
  const recorded = reviewContextSummary({
    workspace: { name: 'Verified project' }, session: { name: 'Verified chat' }, task: { title: 'Repair login' },
    reason: { text: 'Requested by the owner', recorded: true }, original_prompt: { text: 'Fix the expired login link' }, scope: 'staged',
  })
  assert.equal(recorded.reason, 'Requested by the owner')
  assert.equal(recorded.original, 'Fix the expired login link')
  assert.equal(recorded.scope, 'Selected for commit')
})
