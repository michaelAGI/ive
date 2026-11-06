// Alerts outside the window through the Tauri shell: a macOS notification, the
// Dock badge and window focus. Every call resolves to a neutral value in a plain
// browser or when the shell refuses, so callers never need a try/catch.
import { isTauri, invokeNative } from './platform.js'

const text = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)

async function native(command, args) {
  if (!isTauri()) return { ok: false }
  try {
    return { ok: true, value: await invokeNative(command, args) }
  } catch {
    return { ok: false }
  }
}

export const isNativeAlertsAvailable = () => isTauri()

// Resolves true only when macOS accepted the notification.
export async function nativeNotify({ title, body, tag } = {}) {
  const result = await native('needs_you_notify', { title: text(title, 120), body: text(body, 240), tag: text(tag, 120) })
  return result.ok && result.value === true
}

// Dock badge with the number of waiting sessions; 0, null or NaN clears it.
export async function setDockBadge(count) {
  const n = Number(count)
  const result = await native('set_badge_count', { count: Number.isFinite(n) && n > 0 ? Math.floor(n) : null })
  return result.ok
}

// Unminimizes, shows and focuses the main window.
export async function focusMainWindow() {
  return (await native('focus_main_window', {})).ok
}

export async function windowIsFocused() {
  const result = await native('window_is_focused', {})
  return result.ok && result.value === true
}
