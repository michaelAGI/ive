// Plain terminal sessions (cli_type "shell"): "Running" is a claim about work
// (`terminal_activity: "working"`), never about the shell merely being open.
// An agent the user started in it can also wait for an answer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSessionDisplayStatus, isShellSession, isShellCli } from '../src/lib/sessionStatus.js'

const shell = (extra = {}) => ({ id: 't', name: 'Terminal', cli_type: 'shell', session_type: 'shell', ...extra })

test('a live shell is Running only while the backend confirms work', () => {
  // Whatever the DB status says: no confirmed work, no "Running".
  for (const status of ['running', 'idle', 'working']) {
    for (const terminal_activity of [undefined, 'unknown', 'idle']) {
      const meta = getSessionDisplayStatus(shell({ status, agentState: 'working', pty_alive: true, terminal_activity }))
      assert.equal(meta.label, 'Done', `${status}/${terminal_activity}`)
      assert.equal(meta.isWorking, false)
    }
    const working = getSessionDisplayStatus(shell({ status, pty_alive: true, terminal_activity: 'working' }))
    assert.equal(working.label, 'Running')
    assert.equal(working.isWorking, true)
  }
})

test('an agent started by hand in the terminal can wait for the user', () => {
  const meta = getSessionDisplayStatus(shell({ status: 'idle', pty_alive: true, terminal_activity: 'waiting' }))
  assert.equal(meta.state, 'waiting')
  assert.equal(meta.label, 'Waiting')
  assert.equal(meta.tone, 'waiting')
  assert.equal(meta.isWorking, false)
})

test('a started shell without pty_alive yet is Done; after exit it is Stopped', () => {
  assert.equal(getSessionDisplayStatus(shell({ status: 'idle' }), { t: true }).label, 'Done')
  assert.equal(getSessionDisplayStatus(shell({ status: 'exited', pty_alive: false }), { t: true }).label, 'Stopped')
  assert.equal(getSessionDisplayStatus(shell({ status: 'stopped', pty_alive: false }), { t: true }).state, 'stopped')
  assert.equal(getSessionDisplayStatus(shell({ status: 'idle', pty_alive: false })).label, 'Stopped')
  assert.equal(getSessionDisplayStatus(shell({ status: 'running', pty_alive: false, terminal_activity: 'working' })).label, 'Stopped', 'a dead PTY is never working')
})

test('shells take their state from terminal_activity, not from agent fields', () => {
  // Attention objects and agent statuses belong to agent sessions.
  const meta = getSessionDisplayStatus(shell({ status: 'waiting', agentState: 'prompting', pty_alive: true, terminal_activity: 'idle', attention: { kind: 'question' } }))
  assert.equal(meta.state, 'done')
  for (const status of ['running', 'idle', 'exited', 'waiting']) {
    const word = getSessionDisplayStatus(shell({ status, pty_alive: status === 'running' })).label
    assert.ok(['Done', 'Stopped'].includes(word), `${status} → ${word}`)
  }
})

test('agents use the same five words', () => {
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'running', pty_alive: true }).label, 'Running')
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'exited' }).label, 'Stopped')
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'idle', pty_alive: true }).label, 'Done')
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'idle', pty_alive: true, attention: { kind: 'question' } }).label, 'Waiting')
})

test('shell detection', () => {
  assert.equal(isShellSession(shell()), true)
  assert.equal(isShellSession({ cli_type: 'claude' }), false)
  assert.equal(isShellSession(null), false)
  assert.equal(isShellCli('shell'), true)
  assert.equal(isShellCli('codex'), false)
})
