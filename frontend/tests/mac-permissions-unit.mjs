import test from 'node:test'
import assert from 'node:assert/strict'
import { MAC_PERMISSIONS, macPermissionNotice, noticeFromApiError, noticeFromBrowserDenial, hasScreenCapture } from '../src/lib/macPermissions.js'

test.afterEach(() => { delete globalThis.window; delete globalThis.navigator })

test('every reason has one sentence, one pane and one button', () => {
  for (const [reason, entry] of Object.entries(MAC_PERMISSIONS)) {
    assert.match(entry.sentence, /^macOS has not allowed IVE to .+\.$/, reason)
    assert.match(entry.buttonLabel, /^Open .+/, reason)
    assert.ok(entry.pane, reason)
    assert.deepEqual(macPermissionNotice(reason), { reason, ...entry })
  }
  assert.equal(macPermissionNotice('something_else'), null)
})

test('a backend refusal keeps the server sentence and pane', () => {
  const body = { error: 'macOS has not allowed IVE to control Terminal.', reason: 'automation_denied', settings_pane: 'privacy_automation' }
  const error = Object.assign(new Error(body.error), { status: 409, body })
  assert.deepEqual(noticeFromApiError(error), {
    reason: 'automation_denied', sentence: body.error, pane: 'privacy_automation', buttonLabel: 'Open System Settings',
  })
  assert.deepEqual(noticeFromApiError({ reason: 'files_folders_denied', settings_pane: 'privacy_files' }), {
    reason: 'files_folders_denied', sentence: 'macOS has not allowed IVE to read this folder.', pane: 'privacy_files',
    buttonLabel: 'Open Files and Folders settings',
  })
  assert.equal(noticeFromApiError({ error: 'cancelled' }), null)
  assert.equal(noticeFromApiError(new Error('HTTP 500')), null)
  assert.equal(noticeFromApiError(null), null)
})

test('browser API refusals blame macOS only inside the desktop shell', () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  assert.equal(noticeFromBrowserDenial(denied, 'screen', { tauri: true }).pane, 'privacy_screen')
  assert.equal(noticeFromBrowserDenial(denied, 'screen', { tauri: true }).buttonLabel, 'Open Screen Recording settings')
  assert.equal(noticeFromBrowserDenial('not-allowed', 'microphone', { tauri: true }).pane, 'privacy_microphone')
  assert.equal(noticeFromBrowserDenial(denied, 'screen', { tauri: false }), null)
  const browserMic = noticeFromBrowserDenial('not-allowed', 'microphone', { tauri: false })
  assert.equal(browserMic.pane, null)
  assert.match(browserMic.sentence, /^Your browser has not allowed IVE/)
  assert.equal(noticeFromBrowserDenial(Object.assign(new Error('x'), { name: 'AbortError' }), 'screen', { tauri: true }), null)
  assert.equal(noticeFromBrowserDenial('no-speech', 'microphone', { tauri: true }), null)
})

test('isTauri decides by default', () => {
  const denied = Object.assign(new Error('x'), { name: 'NotAllowedError' })
  globalThis.window = { __TAURI_INTERNALS__: {} }
  assert.equal(noticeFromBrowserDenial(denied, 'screen').reason, 'screen_recording_denied')
  globalThis.window = {}
  assert.equal(noticeFromBrowserDenial(denied, 'screen'), null)
})

test('screen capture availability follows navigator.mediaDevices', () => {
  assert.equal(hasScreenCapture(), false)
  globalThis.navigator = { mediaDevices: {} }
  assert.equal(hasScreenCapture(), false)
  globalThis.navigator = { mediaDevices: { getDisplayMedia() {} } }
  assert.equal(hasScreenCapture(), true)
})
