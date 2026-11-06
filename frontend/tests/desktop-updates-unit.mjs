import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateController } from '../src/lib/desktopUpdates.js'

function fixture({ automatic = false, failure = null } = {}) {
  const calls = []
  let status = { currentVersion: '1.0.21', version: null, automatic, downloaded: false, restartRequired: false, error: null }
  const controller = createUpdateController({ supported: true, channel: onmessage => onmessage,
    async invoke(command, args) {
      calls.push({ command, args })
      if (command === failure) throw new Error('Failed operation')
      if (command === 'desktop_update_check') status = { ...status, version: '1.0.22' }
      if (command === 'desktop_update_automatic') status = { ...status, automatic: args.enabled }
      if (command === 'desktop_update_download') { args.progress({ downloaded: 100, total: 100 }); status = { ...status, downloaded: true } }
      return { ...status }
    },
  })
  return { controller, calls }
}

test('checking offers an update without downloading or interrupting the app', async () => {
  const { controller: c, calls } = fixture()
  await c.initialize(); await c.check()
  assert.equal(c.getSnapshot().version, '1.0.22')
  assert.deepEqual(calls.map(c => c.command), ['desktop_update_status', 'desktop_update_check'])
})
test('automatic updates download but never install into a running session', async () => {
  const { controller: c, calls } = fixture({ automatic: true })
  await c.initialize(); await c.check()
  assert.equal(c.getSnapshot().downloaded, true)
  assert(!calls.some(c => c.command === 'desktop_update_install'))
  c.close(); assert.equal(c.getSnapshot().dismissed, '1.0.22')
})
test('explicit install waits for verified download and passes the selected version', async () => {
  const { controller: c, calls } = fixture()
  await c.initialize(); await c.check(); await c.install()
  assert.deepEqual(calls.slice(-2).map(c => c.command), ['desktop_update_download', 'desktop_update_install'])
  assert.equal(calls.at(-1).args.version, '1.0.22')
})
test('failed download cannot invoke installation', async () => {
  const { controller: c, calls } = fixture({ failure: 'desktop_update_download' })
  await c.initialize(); await c.check()
  assert.equal(await c.install(), false)
  assert(!calls.some(c => c.command === 'desktop_update_install'))
  assert.match(c.getSnapshot().error, /Failed operation/)
  assert.equal(c.getSnapshot().phase, 'idle')
})
test('enabling automatic updates persists the choice and downloads the pending version', async () => {
  const { controller: c, calls } = fixture()
  await c.initialize(); await c.check(); await c.setAutomatic(true)
  assert.equal(c.getSnapshot().automatic, true)
  assert.equal(c.getSnapshot().downloaded, true)
  assert(!calls.some(c => c.command === 'desktop_update_install'))
})
test('repeated install clicks cannot install twice', async () => {
  const { controller: c, calls } = fixture()
  await c.initialize(); await c.check()
  await Promise.all([c.install(), c.install()])
  assert.equal(calls.filter(c => c.command === 'desktop_update_install').length, 1)
})
test('web mode and older native shells do not expose unsupported update controls', async () => {
  const c = createUpdateController({ supported: false, invoke() { throw new Error('Must not invoke') } })
  await c.initialize(); assert.equal(c.getSnapshot().supported, false)
  const old = fixture({ failure: 'desktop_update_status' }); await old.controller.initialize()
  assert.equal(old.controller.getSnapshot().supported, false)
})
