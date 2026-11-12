import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTIVITY_FILTERS, activityCounts, activityFilterOf, liveActivityOf, scopedActivitySessions, openActivityTabs } from '../src/lib/liveActivity.js'
import { getSessionDisplayStatus } from '../src/lib/sessionStatus.js'

const agent = (id, extra = {}) => ({ id, name: id, workspace_id: 'a', cli_type: 'claude', session_type: 'worker', pty_alive: true, status: 'idle', ...extra })
const shell = (extra = {}) => agent('shell', { cli_type: 'shell', session_type: 'shell', status: 'running', ...extra })

test('only a current working turn counts as Working', () => {
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

test('a shell counts only confirmed work, never an open prompt or an agent waiting at its prompt', () => {
  assert.equal(liveActivityOf(shell()), 'idle', 'old backends are conservatively excluded')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'unknown' })), 'idle')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'idle' })), 'idle')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'working' })), 'working')
  assert.equal(liveActivityOf(shell({ terminal_activity: 'working', pty_alive: false })), 'stopped')
  assert.equal(getSessionDisplayStatus(shell({ terminal_activity: 'working' })).isWorking, true)
  assert.equal(getSessionDisplayStatus(shell({ terminal_activity: 'idle' })).state, 'done')
  // The owner's screenshot: an agent started by hand, finished, tile said Running.
  assert.equal(getSessionDisplayStatus(shell({ status: 'running', agentState: 'working', terminal_activity: 'idle' })).label, 'Done')
  assert.equal(getSessionDisplayStatus(shell({ terminal_activity: 'unknown' })).label, 'Done')
})

test('an agent in a terminal that asks for permission needs you', () => {
  const asking = shell({ status: 'idle', agentState: 'idle', terminal_activity: 'waiting' })
  assert.equal(liveActivityOf(asking), 'attention')
  assert.equal(getSessionDisplayStatus(asking).state, 'waiting')
  assert.equal(liveActivityOf({ ...asking, pty_alive: false }), 'stopped')
})

test('scope keeps unopened work available but excludes archived, helper, readonly and other projects', () => {
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

test('the status row: every open session is in exactly one of Working / Needs you / Done', () => {
  assert.deepEqual(ACTIVITY_FILTERS.map((f) => [f.value, f.label]), [['all', 'All'], ['working', 'Working'], ['attention', 'Needs you'], ['done', 'Done']])
  const list = [
    agent('turn', { status: 'running' }),
    agent('ready'),
    agent('asks', { attention: { kind: 'permission' } }),
    agent('failed', { status: 'error', pty_alive: false }),
    agent('stopped', { status: 'exited', pty_alive: false }),
    agent('never-started', { pty_alive: false }),
    shell({ id: 'build', terminal_activity: 'working' }),
    shell({ id: 'prompt', terminal_activity: 'idle' }),
    shell({ id: 'agent-done', status: 'running', terminal_activity: 'idle' }),
    shell({ id: 'agent-asks', terminal_activity: 'waiting' }),
    agent('unopened', { status: 'running' }),
    agent('elsewhere', { status: 'running', workspace_id: 'b' }),
  ]
  const sessions = Object.fromEntries(list.map((session) => [session.id, session]))
  const tabs = list.map((session) => session.id).filter((id) => id !== 'unopened')
  assert.deepEqual(Object.fromEntries(list.map((s) => [s.id, activityFilterOf(s)])), {
    turn: 'working', ready: 'done', asks: 'attention', failed: 'attention', stopped: 'done', 'never-started': 'done',
    build: 'working', prompt: 'done', 'agent-done': 'done', 'agent-asks': 'attention', unopened: 'working', elsewhere: 'working',
  })
  const all = activityCounts(tabs, sessions, {})
  assert.deepEqual(all, { all: 11, working: 3, attention: 3, done: 5 })
  assert.equal(all.working + all.attention + all.done, all.all)
  const scoped = activityCounts(tabs, sessions, { tabScope: 'workspace', activeWorkspaceId: 'a' })
  assert.deepEqual(scoped, { all: 10, working: 2, attention: 3, done: 5 })
  // The count is what a click on the state shows.
  for (const filter of ['all', 'working', 'attention', 'done']) {
    assert.equal(openActivityTabs(tabs, sessions, { tabScope: 'workspace', activeWorkspaceId: 'a' }, filter).length, scoped[filter], filter)
  }
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'done'), ['ready', 'stopped', 'never-started', 'prompt', 'agent-done'])
  assert.deepEqual(activityCounts([], sessions, {}), { all: 0, working: 0, attention: 0, done: 0 })
  assert.deepEqual(openActivityTabs(tabs, sessions, {}, 'no-such-filter').length, 11, 'an unknown filter hides nothing')
})
