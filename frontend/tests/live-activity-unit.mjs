import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liveActivityOf, observedWorkDuration, scopedActivitySessions, openActivityTabs } from '../src/lib/liveActivity.js'
import { getSessionDisplayStatus } from '../src/lib/sessionStatus.js'

const agent = (id, extra = {}) => ({ id, name: id, workspace_id: 'a', cli_type: 'claude', session_type: 'worker', pty_alive: true, status: 'idle', ...extra })
const shell = (extra = {}) => agent('shell', { cli_type: 'shell', session_type: 'shell', status: 'running', ...extra })

test('only a current working turn belongs in Working now', () => {
  for (const status of ['running', 'working', 'executing']) assert.equal(liveActivityOf(agent(status, { status })), 'working')
  assert.equal(liveActivityOf(agent('hook', { agentState: 'working' })), 'working')
  assert.equal(liveActivityOf(agent('open')), 'idle', 'PTY alive alone is not working')
  assert.equal(liveActivityOf(agent('output', { last_activity: { tool_name: 'Bash', at: Date.now() }, last_event_at: Date.now() })), 'idle', 'a past tool is not current work')
  assert.equal(liveActivityOf(agent('replay', { status: 'replaying' })), 'idle', 'terminal replay is not work')
})

test('attention, stop and failure override a stale working indication', () => {
  for (const extra of [
    { attention: { kind: 'permission' } }, { startup_blocker: { type: 'trust_required' } },
    { status: 'waiting' }, { agentState: 'prompting' }, { status: 'error' }, { status: 'auth_failed' },
  ]) assert.equal(liveActivityOf(agent('wait', { status: 'running', agentState: 'working', ...extra })), 'attention', JSON.stringify(extra))
  assert.equal(liveActivityOf(agent('dead', { status: 'running', agentState: 'working', pty_alive: false })), 'stopped')
  assert.equal(liveActivityOf(agent('quota', { status: 'quota_exceeded', pty_alive: false })), 'attention', 'a blocked usage limit still needs attention')
  assert.equal(liveActivityOf(agent('stopped', { status: 'exited', agentState: 'working' })), 'stopped')
})

test('a shell counts only a confirmed foreground command, never an open prompt', () => {
  assert.equal(liveActivityOf(shell()), 'idle', 'old backends are conservatively excluded')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'unknown' })), 'idle')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'idle' })), 'idle')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'working' })), 'working')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'working', pty_alive: false })), 'stopped')
  assert.equal(getSessionDisplayStatus(shell({ terminal_activity: 'working' })).isWorking, true)
  assert.equal(getSessionDisplayStatus(shell({ terminal_activity: 'idle' })).state, 'done')
})

test('activity lane includes unopened work but excludes archived, helper, readonly and other scope', () => {
  const sessions = Object.fromEntries([
    agent('open'), agent('unopened', { status: 'running' }), agent('other', { workspace_id: 'b' }),
    agent('archived', { archived: 1 }), agent('helper', { session_type: 'commander' }), agent('readonly', { read_only: true }),
  ].map((session) => [session.id, session]))
  assert.deepEqual(scopedActivitySessions(sessions).map((s) => s.id), ['open', 'unopened', 'other'])
  assert.deepEqual(scopedActivitySessions(sessions, { tabScope: 'workspace', activeWorkspaceId: 'a' }).map((s) => s.id), ['open', 'unopened'])
  assert.deepEqual(openActivityTabs(['open', 'unopened', 'other', 'missing', 'helper'], sessions, { tabScope: 'workspace', activeWorkspaceId: 'a' }, 'working'), ['unopened'])
  assert.deepEqual(openActivityTabs(['open'], sessions, {}, 'working'), [])
})

test('filters follow work → question → idle without changing source order or opening sessions', () => {
  const sessions = { first: agent('first', { status: 'running' }), second: agent('second', { status: 'running' }) }
  const tabs = ['second', 'first']
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'working'), ['second', 'first'])
  sessions.first = { ...sessions.first, attention: { kind: 'question' } }
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'working'), ['second'])
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'attention'), ['first'])
  sessions.first = { ...sessions.first, attention: null, status: 'idle' }
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'attention'), [])
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'all'), tabs)
})

test('observed duration has no invented start and handles clock boundaries', () => {
  assert.equal(observedWorkDuration(undefined), '')
  assert.equal(observedWorkDuration(NaN), '')
  assert.equal(observedWorkDuration(2000, 1000), '')
  assert.equal(observedWorkDuration(1000, 1000), '0s')
  assert.equal(observedWorkDuration(1000, 62000), '1m 01s')
  assert.equal(observedWorkDuration(1000, 3661000), '1h 01m')
})
