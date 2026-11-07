// Lid-closed mode: the options people choose and the status the Mac helper
// reports. Shared by the header control and the Mac & Power settings panel so
// both read and write the same saved preferences.

export const APPS = [
  ['com.tinyspeck.slackmacgap', 'Slack'], ['com.hnc.Discord', 'Discord'],
  ['net.whatsapp.WhatsApp', 'WhatsApp'], ['com.spotify.client', 'Spotify'],
]
export const DURATIONS = [[900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour'], [7200, '2 hours'], [14400, '4 hours'], [28800, '8 hours']]
export const PREF_KEY = 'ive:mac-power-options:v1'
export const SHARED_KEY = 'mac_power_options' // app setting the menu bar item reads and writes too
export const DEFAULTS = { duration_seconds: 3600, allow_battery: false, lid_low_power: true, pause_apps: [] }
// Refusals that the Login Items pane resolves. helper_outdated gets the button only.
export const LOGIN_ITEMS_REASONS = ['macos_helper_approval_required', 'macos_helper_not_registered', 'helper_connection_failed', 'helper_outdated']
export const STARTABLE_STATES = ['ready', 'stopped', 'not_registered', 'unregistered', 'needs_approval']
// The helper runs from another IVE copy: an in-app restart (with the Mac password) fixes it.
export const RESTART_HELPER_REASONS = ['client_path_mismatch', 'parent_chain_mismatch', 'helper_not_in_app_bundle']
export const needsHelperRestart = (status) => status?.state !== 'active' && RESTART_HELPER_REASONS.includes(status?.reason)

export function loadOptions(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(PREF_KEY))
    if (value && DURATIONS.some(([n]) => n === value.duration_seconds)
      && typeof value.allow_battery === 'boolean' && typeof value.lid_low_power === 'boolean'
      && Array.isArray(value.pause_apps) && value.pause_apps.every(id => APPS.some(([key]) => key === id))) return value
  } catch { /* use defaults */ }
  return DEFAULTS
}

export function saveOptions(value, storage = globalThis.localStorage) {
  try { storage?.setItem(PREF_KEY, JSON.stringify(value)) } catch { /* mode still works without saved preferences */ }
}

export function remaining(expires, now) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expires) - now) / 1000))
  if (!Number.isFinite(seconds)) return '--:--'
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

// Short form for the header: "59 min", "1 h 20 min", "under a minute".
export function remainingShort(expires, now) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expires) - now) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'under a minute'
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60 % 60)
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}

export function canStart(status) {
  return STARTABLE_STATES.includes(status?.state) && status?.lid_saver_supported === true
}

// One sentence for the header tooltip and the popover headline.
export function headline(status, now) {
  switch (status?.state) {
    case 'active':
      if (Date.parse(status.expires_at) <= now) return 'Time limit reached, checking status'
      return `On, ${remainingShort(status.expires_at, now)} left. Close the lid, the agents keep working.`
    case 'loading': return 'Checking the lid-closed mode'
    case 'unavailable': return 'Lid-closed mode needs the installed IVE Mac app'
    case 'not_registered': case 'unregistered': return 'Off. Turning on sets up the Mac helper once.'
    case 'needs_approval': return 'Off. macOS still has to allow the IVE helper.'
    case 'restoring': return 'Restoring the normal sleep settings'
    case 'restore_failed': return 'Sleep settings could not be restored yet'
    case 'unknown': return 'Lid-closed mode: status not confirmed'
    default: return 'Off. Turn on, then close the lid; the agents keep working.'
  }
}

// The conditions live in one app setting so the menu bar item, the header
// eyelid and Settings → Mac & Power agree. localStorage keeps a copy for the
// first paint and for browsers without the setting.
export function normalizeOptions(value) {
  if (value && typeof value === 'string') { try { value = JSON.parse(value) } catch { return null } }
  if (!value || typeof value !== 'object') return null
  if (!DURATIONS.some(([n]) => n === value.duration_seconds)) return null
  return {
    duration_seconds: value.duration_seconds,
    allow_battery: !!value.allow_battery,
    lid_low_power: value.lid_low_power !== false,
    pause_apps: Array.isArray(value.pause_apps) ? value.pause_apps.filter(id => APPS.some(([key]) => key === id)) : [],
  }
}

export async function fetchSharedOptions(api) {
  try {
    const data = await api.getAppSetting(SHARED_KEY)
    return normalizeOptions(data?.value)
  } catch { return null }
}

export function pushSharedOptions(api, value) {
  api.setAppSetting(SHARED_KEY, value).catch(() => { /* the local copy still applies */ })
}
