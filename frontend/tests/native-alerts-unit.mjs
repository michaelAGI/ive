import test from 'node:test'
import assert from 'node:assert/strict'
import { isNativeAlertsAvailable, nativeNotify, setDockBadge, focusMainWindow, windowIsFocused } from '../src/lib/nativeAlerts.js'

function shell(invoke) {
  globalThis.window = { __TAURI_INTERNALS__: { invoke }, location: new URL('http://127.0.0.1:5112/') }
}
test.afterEach(() => { delete globalThis.window })

test('a plain browser gets neutral answers and nothing throws', async () => {
  globalThis.window = { location: new URL('https://ive.example/') }
  assert.equal(isNativeAlertsAvailable(), false)
  assert.equal(await nativeNotify({ title: 'Build', body: 'Run npm test', tag: 's1' }), false)
  assert.equal(await setDockBadge(3), false)
  assert.equal(await focusMainWindow(), false)
  assert.equal(await windowIsFocused(), false)
})

test('the shell receives the command names and arguments', async () => {
  const calls = []
  shell(async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'needs_you_notify') return true
    if (cmd === 'window_is_focused') return true
    return null
  })
  assert.equal(isNativeAlertsAvailable(), true)
  assert.equal(await nativeNotify({ title: 'Build', body: 'Run npm test', tag: 's1' }), true)
  assert.equal(await setDockBadge(2), true)
  assert.equal(await setDockBadge(0), true)
  assert.equal(await setDockBadge(undefined), true)
  assert.equal(await focusMainWindow(), true)
  assert.equal(await windowIsFocused(), true)
  assert.deepEqual(calls, [
    ['needs_you_notify', { title: 'Build', body: 'Run npm test', tag: 's1' }],
    ['set_badge_count', { count: 2 }],
    ['set_badge_count', { count: null }],
    ['set_badge_count', { count: null }],
    ['focus_main_window', {}],
    ['window_is_focused', {}],
  ])
})

test('text is trimmed, bounded and free of control characters', async () => {
  const calls = []
  shell(async (cmd, args) => { calls.push(args); return true })
  await nativeNotify({ title: ' Build\u0007 ', body: 'x'.repeat(300), tag: undefined })
  assert.equal(calls[0].title, 'Build')
  assert.equal(calls[0].body.length, 240)
  assert.equal(calls[0].tag, '')
  await setDockBadge(2.7)
  assert.deepEqual(calls[1], { count: 2 })
})

test('a refusing shell answers false instead of throwing', async () => {
  shell(async () => { throw new Error('notification:default not allowed') })
  assert.equal(await nativeNotify({ title: 'Build' }), false)
  assert.equal(await setDockBadge(1), false)
  assert.equal(await focusMainWindow(), false)
  assert.equal(await windowIsFocused(), false)
  shell(async () => false)
  assert.equal(await nativeNotify({ title: 'Build' }), false)
  assert.equal(await windowIsFocused(), false)
})
