import test from 'node:test'
import assert from 'node:assert/strict'
import { broadcastFailedMessage, broadcastSkippedMessage, getBroadcastRecipients } from '../src/lib/broadcastScope.js'

test('a broadcast names how many sessions it left out because a question was open', () => {
  assert.equal(broadcastSkippedMessage(1), 'Skipped 1 session with an open question. Answer it there first.')
  assert.equal(broadcastSkippedMessage(3), 'Skipped 3 sessions with an open question. Answer it there first.')
  assert.equal(broadcastFailedMessage(1), 'Broadcast not delivered to 1 session. Check each session before retrying.')
  assert.equal(broadcastFailedMessage(2), 'Broadcast not delivered to 2 sessions. Check each session before retrying.')
})

const sessions = { a: { workspace_id: 'first' }, b: { workspace_id: 'second' }, c: { workspace_id: 'first' } }
test('narrowing from global to one project excludes hidden selected sessions immediately', () => {
  const selected = { a: true, b: true }
  assert.deepEqual(getBroadcastRecipients(selected, ['a', 'b'], ['a', 'b'], sessions), ['a', 'b'])
  assert.deepEqual(getBroadcastRecipients(selected, ['a'], ['a', 'b'], sessions), ['a'])
})
test('saved global group is constrained by current visible and open sessions', () => {
  assert.deepEqual(getBroadcastRecipients({ a: true, b: true, c: true }, ['a', 'c'], ['a', 'b'], sessions), ['a'])
})
test('missing, deselected, duplicate, and closed tabs are never recipients', () => {
  assert.deepEqual(getBroadcastRecipients({ a: true, b: false, c: true, missing: true }, ['a', 'a', 'b', 'c', 'missing'], ['a', 'b', 'missing'], sessions), ['a'])
})
test('empty selection and scope produce no recipients', () => {
  assert.deepEqual(getBroadcastRecipients({}, ['a'], ['a'], sessions), [])
  assert.deepEqual(getBroadcastRecipients({ a: true }, [], ['a'], sessions), [])
})
