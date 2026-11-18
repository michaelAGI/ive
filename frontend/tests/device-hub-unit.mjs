import test from 'node:test'
import assert from 'node:assert/strict'
import { startDeviceAgent, setupPrompt } from '../src/lib/deviceHub.js'
import { deviceUseCases } from '../src/lib/deviceUseCases.js'

function fixture(overrides = {}) {
  const calls = []
  const api = {
    quickSession: async args => { calls.push(['create', args]); return { id: 'agent-1' } },
    deviceHubAction: async (...args) => calls.push(['grant', ...args]),
    sendSessionInput: async (...args) => calls.push(['send', ...args]),
    ...overrides,
  }
  return { api, calls }
}
test('setup creates one session, grants its chosen scope, then sends the task', async () => {
  const { api, calls } = fixture()
  await startDeviceAgent({ api, provider: 'codex', fullAccess: true, deviceId: 'phone-1', task: 'Review my screenshots.' })
  assert.deepEqual(calls.map(c => c[0]), ['create', 'grant', 'send'])
  assert.equal(calls[0][1].permission_mode, 'bypassPermissions')
  assert.deepEqual(calls[1].slice(1), ['grant-setup', { session_id: 'agent-1', device_id: 'phone-1', control_after_setup: true }])
  assert.match(calls[2][2], /Only after setup and a fresh observation succeed/)
  assert.match(calls[2][2], /Review my screenshots\./)
})
test('default permissions remain default when full access is off', async () => {
  const { api, calls } = fixture()
  await startDeviceAgent({ api, provider: 'claude', fullAccess: false, setup: false, deviceId: 'phone-1', task: 'Read my calendar' })
  assert.equal(calls[0][1].permission_mode, 'default')
  assert.equal(calls[1][1], 'assign')
  assert.match(calls[2][2], /Read my calendar/)
})
test('failed grant cannot send instructions to an unassigned agent', async () => {
  const { api, calls } = fixture({ deviceHubAction: async () => { throw new Error('Device busy') } })
  await assert.rejects(startDeviceAgent({ api, provider: 'codex' }), error => error.deviceSessionId === 'agent-1')
  assert.equal(calls.filter(c => c[0] === 'send').length, 0)
})
test('failed autostart offers the existing session, without grants or duplicate sessions', async () => {
  const { api, calls } = fixture({ quickSession: async () => ({ id: 'existing', autostart: { ok: false } }) })
  await assert.rejects(startDeviceAgent({ api }), error => error.deviceSessionId === 'existing')
  assert.equal(calls.length, 0)
})
test('uncertain delivery is not automatically repeated', async () => {
  let sends = 0
  const { api } = fixture({ sendSessionInput: async () => { sends++; throw new Error('Timed out') } })
  await assert.rejects(startDeviceAgent({ api }), error => error.deviceSessionId === 'agent-1')
  assert.equal(sends, 1)
})
test('empty setup waits for a task and ten distinct recipes are usable', () => {
  assert.match(setupPrompt(), /Wait for my task before changing anything/)
  assert.equal(deviceUseCases.length, 10)
  assert.equal(new Set(deviceUseCases.map(r => r.id)).size, 10)
  for (const recipe of deviceUseCases) {
    assert.ok(recipe.title && recipe.benefit && recipe.prompt.length > 100)
  }
})
