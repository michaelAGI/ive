// One sentence and one button for each macOS refusal. The backend reports a
// refusal as {error, reason, settings_pane}; browser APIs raise NotAllowedError.
import { isTauri } from './platform.js'

export const MAC_PERMISSIONS = {
  automation_denied: {
    sentence: 'macOS has not allowed IVE to control the terminal app.',
    pane: 'privacy_automation',
    buttonLabel: 'Open System Settings',
  },
  files_folders_denied: {
    sentence: 'macOS has not allowed IVE to read this folder.',
    pane: 'privacy_files',
    buttonLabel: 'Open Files and Folders settings',
  },
  microphone_denied: {
    sentence: 'macOS has not allowed IVE to use the microphone.',
    pane: 'privacy_microphone',
    buttonLabel: 'Open Microphone settings',
  },
  screen_recording_denied: {
    sentence: 'macOS has not allowed IVE to record the screen.',
    pane: 'privacy_screen',
    buttonLabel: 'Open Screen Recording settings',
  },
  notifications_denied: {
    sentence: 'macOS has not allowed IVE to show notifications.',
    pane: 'notifications',
    buttonLabel: 'Open Notifications settings',
  },
}

const BROWSER_MICROPHONE = {
  reason: 'microphone_blocked',
  sentence: 'Your browser has not allowed IVE to use the microphone. Allow it for this site and try again.',
  pane: null,
  buttonLabel: null,
}

export function macPermissionNotice(reason, { sentence, pane } = {}) {
  const entry = MAC_PERMISSIONS[reason]
  if (!entry) return null
  return { reason, sentence: sentence || entry.sentence, pane: pane || entry.pane, buttonLabel: entry.buttonLabel }
}

// A refusal the backend reported: an ApiError carrying .body, or the body itself.
export function noticeFromApiError(error) {
  const body = error && typeof error === 'object' && 'body' in error ? error.body : error
  if (!body || typeof body !== 'object' || !MAC_PERMISSIONS[body.reason]) return null
  const sentence = typeof body.error === 'string' && body.error.trim() ? body.error : undefined
  return macPermissionNotice(body.reason, { sentence, pane: body.settings_pane })
}

const isDenied = (error) => error === 'not-allowed' || error?.name === 'NotAllowedError' || error?.error === 'not-allowed'

// A browser API refusal (getDisplayMedia, speech recognition). Only the desktop
// shell can blame macOS; a browser decides about its own sites, and a cancelled
// screen picker looks the same as a refusal there.
export function noticeFromBrowserDenial(error, kind, { tauri = isTauri() } = {}) {
  if (!isDenied(error)) return null
  if (tauri) return macPermissionNotice(kind === 'screen' ? 'screen_recording_denied' : 'microphone_denied')
  return kind === 'microphone' ? { ...BROWSER_MICROPHONE } : null
}

// The desktop webview has no getDisplayMedia; buttons that need it stay hidden there.
export const hasScreenCapture = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
