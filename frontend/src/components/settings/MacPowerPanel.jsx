import HelpDetails from '../ui/HelpDetails'
import CopyCommand from './CopyCommand'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Battery, ExternalLink, Laptop, Leaf, Pause, Play, RotateCw, Settings2, Square, Timer } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { Button } from '../ui'

const APPS = [
  ['com.tinyspeck.slackmacgap', 'Slack'], ['com.hnc.Discord', 'Discord'],
  ['net.whatsapp.WhatsApp', 'WhatsApp'], ['com.spotify.client', 'Spotify'],
]
const DURATIONS = [[900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour'], [7200, '2 hours'], [14400, '4 hours'], [28800, '8 hours']]
const PREF_KEY = 'ive:mac-power-options:v1'
const DEFAULTS = { duration_seconds: 3600, allow_battery: false, lid_low_power: true, pause_apps: [] }
const LABELS = {
  loading: 'Checking status', unknown: 'Status not confirmed', unavailable: 'IVE Mac app required',
  not_found: 'Mac helper missing', not_registered: 'One-time setup required', unregistered: 'One-time setup required',
  needs_approval: 'macOS approval required', ready: 'Off', stopped: 'Off',
  restoring: 'Restoring settings', restore_failed: 'Restore still pending', blocked: 'Mode not available',
}
const LOGIN_ITEMS_PATH = 'System Settings → General → Login Items & Extensions → Allow in the Background → IVE (administrator)'
// Refusals that the Login Items pane resolves. helper_outdated gets the button only.
const LOGIN_ITEMS_REASONS = ['macos_helper_approval_required', 'macos_helper_not_registered', 'helper_connection_failed', 'helper_outdated']
const RESTORE_COMMAND = 'sudo pmset -a disablesleep 0'
const BATTERY_SENTENCE = 'Keeps the Mac awake with the lid closed until the battery reaches 20 %.'
const OUTDATED_SENTENCE = 'Update the IVE Mac app. If it is already current, turn the IVE item off and on in Login Items & Extensions, or restart the Mac.'
const APPROVAL_NOTICE = 'macOS has not approved IVE yet. Allow it under Login Items & Extensions, then try again.'
const PANE_LABELS = {
  battery: 'Open Battery settings', battery_options: 'Open Battery settings', login_items: 'Open Login Items & Extensions',
  lock_screen: 'Open Lock Screen settings', notifications: 'Open Notifications settings',
}
const paneLabel = pane => PANE_LABELS[pane] || (pane?.startsWith('privacy_') ? 'Open Privacy & Security settings' : 'Open System Settings')

function loadOptions() {
  try {
    const value = JSON.parse(localStorage.getItem(PREF_KEY))
    if (value && DURATIONS.some(([n]) => n === value.duration_seconds)
      && typeof value.allow_battery === 'boolean' && typeof value.lid_low_power === 'boolean'
      && Array.isArray(value.pause_apps) && value.pause_apps.every(id => APPS.some(([key]) => key === id))) return value
  } catch { /* use defaults */ }
  return DEFAULTS
}
function remaining(expires, now) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expires) - now) / 1000))
  if (!Number.isFinite(seconds)) return '--:--'
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
// The subtitle always states power facts; unknown facts are named, never faked.
function powerLine(status, noBattery) {
  if (status.state === 'loading') return 'Reading power status…'
  const battery = noBattery ? 'No battery' : status.battery_percent == null ? 'Battery level unknown' : `Battery ${Math.round(status.battery_percent)} %`
  const source = status.on_battery === true ? 'on battery' : status.on_battery === false ? 'on power adapter' : 'power source unknown'
  const low = typeof status.low_power_active === 'boolean' ? ` · Low Power Mode ${status.low_power_active ? 'on' : 'off'}` : ''
  return `${battery} · ${source}${low}`
}
// Keeps the server sentence plus the machine-readable reason, so the panel can
// offer the one action that resolves it. A 4xx with a reason is a refusal that
// never reached macOS.
function describe(e, fallback, source) {
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body : {}
  return { message: e?.message || fallback, source, reason: body.reason ? String(body.reason) : null,
    pane: body.settings_pane ? String(body.settings_pane) : null,
    refused: e instanceof ApiError && e.status >= 400 && e.status < 500 && !!body.reason }
}
// A shown error disappears once the status proves it resolved.
function resolved(failure, status) {
  return failure.source === 'status' || status.state === 'active'
    || (failure.reason === 'battery_not_allowed' && status.on_battery === false)
    || (LOGIN_ITEMS_REASONS.includes(failure.reason) && ['ready', 'stopped'].includes(status.state) && status.lid_saver_supported === true)
}

export default function MacPowerPanel() {
  const [options, setOptions] = useState(loadOptions)
  const [status, setStatus] = useState({ state: 'loading' })
  const [failure, setFailure] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState('')
  const [opening, setOpening] = useState(false)
  const [now, setNow] = useState(Date.now)
  const revision = useRef(0)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async (clearError = false) => {
    if (busyRef.current) return
    const current = ++revision.current
    try {
      const value = await api.macPower.status()
      if (!mounted.current || revision.current !== current) return
      setStatus(value)
      setFailure(f => !f || clearError || resolved(f, value) ? null : f)
      if (value.state !== 'needs_approval') setNotice(null)
    } catch (e) {
      if (mounted.current && revision.current === current) {
        setStatus({ state: 'unknown' }); setFailure(describe(e, 'The Mac status could not be checked.', 'status'))
      }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    refresh()
    const interval = setInterval(() => { if (!document.hidden) refresh() }, 5000)
    const visible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { mounted.current = false; ++revision.current; clearInterval(interval); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  useEffect(() => {
    if (status.state !== 'active') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status.state])
  const update = (change) => {
    const value = { ...options, ...change }
    setOptions(value)
    try { localStorage.setItem(PREF_KEY, JSON.stringify(value)) } catch { /* mode still works without saved preferences */ }
  }
  const act = async (action, overrides) => {
    if (busyRef.current) return
    // Overrides travel with this request only; they are kept once macOS confirmed the start.
    const payload = { ...options, ...overrides }
    busyRef.current = true; ++revision.current; setBusy(action); setNotice(null)
    if (action !== 'approval') setFailure(null)
    let fail = null
    try {
      const value = action === 'start' ? await api.macPower.start(payload) : await api.macPower[action]()
      if (mounted.current) {
        if (overrides && value.state === 'active') update(overrides)
        if (action === 'start' && value.state === 'needs_approval') setNotice(APPROVAL_NOTICE)
        setStatus(value); setNow(Date.now()); setFailure(f => f && resolved(f, value) ? null : f)
      }
    } catch (e) {
      fail = describe(e, 'The mode could not be changed.', 'action')
      // A refusal with a reason never reached macOS, so the last status stands.
      // A timeout or server error may have, so require fresh status before
      // offering another activation.
      if (mounted.current && !fail.refused) setStatus({ state: 'unknown' })
    } finally {
      busyRef.current = false
      if (mounted.current) { setBusy(''); if (fail) setFailure(fail) }
    }
  }
  const openSettings = async (pane) => {
    setOpening(true)
    try { await api.openMacSettings(pane); if (mounted.current) setFailure(f => f?.source === 'settings' ? null : f) }
    catch (e) { if (mounted.current) setFailure(describe(e, 'System Settings could not be opened.', 'settings')) }
    finally { if (mounted.current) setOpening(false) }
  }
  const active = status.state === 'active'
  const restoring = ['restoring', 'restore_failed'].includes(status.state)
  const expired = active && Date.parse(status.expires_at) <= now
  const noBattery = failure?.reason === 'battery_unavailable'
  const outdated = status.lid_saver_supported === false
  const canStart = ['ready', 'stopped', 'not_registered', 'unregistered', 'needs_approval'].includes(status.state)
    && status.lid_saver_supported === true && !noBattery
  const locked = active || restoring || !!busy
  const dim = locked ? 'opacity-70' : ''
  const liveOptions = active ? {
    allow_battery: status.allow_battery, lid_low_power: status.lid_low_power,
    pause_apps: status.pause_apps || [],
  } : options
  const batteryRefused = failure?.reason === 'battery_not_allowed' && !liveOptions.allow_battery
  const batteryFirst = canStart && !liveOptions.allow_battery && status.on_battery === true && !batteryRefused
  const loginItemsRefused = LOGIN_ITEMS_REASONS.includes(failure?.reason)
  const paneFallback = failure?.pane && !loginItemsRefused && !['battery_not_allowed', 'sleep_already_disabled_elsewhere', 'already_running'].includes(failure.reason)
  // The status card offers the Login Items pane itself whenever that is the fix; before
  // registration the IVE item is not listed there yet, so turning on comes first.
  const needsApproval = !loginItemsRefused && (status.state === 'needs_approval' || outdated
    || (LOGIN_ITEMS_REASONS.includes(status.reason) && !['not_registered', 'unregistered'].includes(status.state)))
  const startLabel = batteryFirst ? 'Allow battery use and turn on' : status.state === 'needs_approval' ? 'Check approval and turn on' : 'Turn on'
  const title = active ? (expired ? 'Time limit reached · checking status' : status.lid_saver_active ? 'Lid closed · lid actions active' : status.mode_source === 'phone' ? 'iPhone availability active' : 'On · ready to close the lid') : LABELS[status.state] || 'Check status'

  return <div className="h-full overflow-y-auto" data-mac-power-panel>
    <div className="mx-auto max-w-[760px] space-y-6 p-5 sm:p-7">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-x-ink">Close the lid. Agents keep working.</h3>
        <HelpDetails label="How it works"><p className="mt-2 max-w-[62ch] text-xs leading-relaxed text-x-muted">Turn it on for your work run. Only when the lid closes does IVE save power and pause the selected apps. Opening the lid brings everything back; the timer keeps running.</p></HelpDetails>
      </div>

      <div className={`rounded-xl border p-4 ${active ? 'border-x-accent/40 bg-x-tint' : 'border-x-line bg-x-surface-2'}`} data-mac-power-state={status.state}>
        <div className="flex flex-wrap items-center gap-3">
          <Laptop size={22} className={active ? 'text-x-accent-ink' : 'text-x-muted'} />
          <div className="min-w-0 flex-1"><p role="status" className="text-sm font-medium text-x-ink">{title}</p>
            <p className="mt-1 text-xs text-x-muted" data-mac-power-line>{powerLine(status, noBattery)}</p></div>
          {active && <span className="font-mono text-xl tabular-nums text-x-ink" aria-label="Time remaining">{remaining(status.expires_at, now)}</span>}
        </div>
        {active && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-x-line pt-3 text-[11px] text-x-ink-secondary">
          <span>{status.lid_closed ? 'Lid closed' : 'Lid open'}</span>
          <span>{status.paused_processes > 0 ? 'Selected apps paused' : 'No apps paused'}</span>
          <span>Works without an iPhone connection</span>
        </div>}
        {status.message && <p className="mt-3 text-xs leading-relaxed text-x-ink-secondary">{status.message}</p>}
        {status.state === 'unavailable' && <div className="mt-3 space-y-2 text-xs text-x-muted">
          {!status.message && <p>This feature needs the installed IVE Mac app with its macOS helper.</p>}
          <a href="https://ive.dev" target="_blank" rel="noreferrer" className="inline-flex min-h-[26px] items-center gap-1.5 rounded-md border border-x-line-strong bg-x-surface px-2.5 py-1 text-[11px] font-medium text-x-ink hover:bg-x-hover">Get the IVE Mac app<ExternalLink size={11} /></a>
        </div>}
        {needsApproval && <div className="mt-3 space-y-2 text-xs text-x-ink-secondary">
          {!status.message && <p>{outdated ? OUTDATED_SENTENCE : `Allow the IVE background item under ${LOGIN_ITEMS_PATH}. Then turn it on here.`}</p>}
          {notice && <p className="text-x-ink" data-mac-power-notice>{notice}</p>}
          <Button size="sm" disabled={!!busy} loading={busy === 'approval'} onClick={() => act('approval')}>Open Login Items & Extensions</Button>
        </div>}
        {['not_registered', 'unregistered'].includes(status.state) && !status.message && <p className="mt-3 text-xs text-x-ink-secondary">Turning on registers the IVE background helper. macOS then asks you to allow it under Login Items & Extensions.</p>}
        {status.state === 'restore_failed' && <div className="mt-3 text-xs"><CopyCommand command={RESTORE_COMMAND} /></div>}
      </div>

      {failure && <div role="alert" className="space-y-2 rounded-lg border border-x-danger/30 bg-x-danger/5 p-3 text-xs text-x-danger" data-mac-power-error={failure.reason || 'error'}>
        <p className="leading-relaxed">{failure.message}</p>
        {batteryRefused && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button variant="primary" icon={Battery} disabled={!!busy} loading={busy === 'start'} onClick={() => act('start', { allow_battery: true })}>Allow battery use and turn on</Button>
          <span className="text-x-ink-secondary">{BATTERY_SENTENCE}</span>
        </div>}
        {loginItemsRefused && <div className="flex flex-wrap gap-2">
          <Button disabled={!!busy} loading={busy === 'approval'} onClick={() => act('approval')}>Open Login Items & Extensions</Button>
          {failure.reason !== 'helper_outdated' && <Button icon={RotateCw} disabled={!!busy} onClick={() => refresh(true)}>Check again</Button>}
        </div>}
        {failure.reason === 'sleep_already_disabled_elsewhere' && <CopyCommand command={RESTORE_COMMAND} />}
        {failure.reason === 'already_running' && <Button size="sm" icon={RotateCw} disabled={!!busy} onClick={() => refresh(true)}>Check status</Button>}
        {paneFallback && <Button size="sm" icon={Settings2} disabled={opening} loading={opening} onClick={() => openSettings(failure.pane)}>{paneLabel(failure.pane)}</Button>}
      </div>}

      <div className="space-y-5">
        <div className={`flex flex-wrap items-center justify-between gap-3 ${dim}`}>
          <label htmlFor="mac-power-duration" className="flex items-center gap-2 text-sm font-medium text-x-ink"><Timer size={16} />Maximum duration</label>
          <select id="mac-power-duration" disabled={locked} value={options.duration_seconds} onChange={e => update({ duration_seconds: Number(e.target.value) })} className="rounded-md border border-x-line-strong bg-x-surface px-3 py-2 text-xs text-x-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-x-focus">
            {DURATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className={dim}>
          <label className="flex items-start gap-3 text-xs leading-relaxed text-x-muted">
            <input type="checkbox" disabled={locked} checked={!!liveOptions.allow_battery} onChange={e => update({ allow_battery: e.target.checked })} className="mt-0.5 accent-[var(--color-x-accent)]" />
            <span><b className="flex items-center gap-1.5 font-medium text-x-ink"><Battery size={14} />Also run on battery</b>Without this, turning on fails while on battery and the feature ends when the adapter is unplugged.</span>
          </label>
          {batteryFirst && <p className="mt-1.5 pl-7 text-xs text-x-warning" data-mac-power-battery-hint>You are on battery. Allow battery use or connect the power adapter.</p>}
        </div>
        <div className="border-t border-x-line pt-5">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-x-muted">Only with the lid closed</p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <label className={`flex min-w-[240px] flex-1 items-start gap-3 text-xs leading-relaxed text-x-muted ${dim}`}>
              <input type="checkbox" disabled={locked} checked={!!liveOptions.lid_low_power} onChange={e => update({ lid_low_power: e.target.checked })} className="mt-0.5 accent-[var(--color-x-accent)]" />
              <span><b className="flex items-center gap-1.5 font-medium text-x-ink"><Leaf size={14} />Low Power Mode on battery while the lid is closed</b>IVE switches the battery profile to Low Power Mode when the lid closes. It takes effect while the Mac runs on battery.</span>
            </label>
            <Button size="sm" icon={Settings2} disabled={opening} loading={opening} onClick={() => openSettings('battery')}>Open Battery settings</Button>
          </div>
          <div className={`mt-5 ${dim}`}>
            <p className="flex items-center gap-1.5 text-xs font-medium text-x-ink"><Pause size={14} />Pause these apps</p>
            <p className="mt-1 text-xs leading-relaxed text-x-muted">Messages and music from these apps pause until the lid opens. IVE and agents keep running.</p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {APPS.map(([id, name]) => <label key={id} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs text-x-ink ${liveOptions.pause_apps.includes(id) ? 'border-x-accent/40 bg-x-tint' : 'border-x-line bg-x-surface'}`}>
                <input type="checkbox" disabled={locked} checked={liveOptions.pause_apps.includes(id)} onChange={e => update({ pause_apps: e.target.checked ? [...options.pause_apps, id] : options.pause_apps.filter(key => key !== id) })} className="accent-[var(--color-x-accent)]" />{name}
              </label>)}
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-x-line pt-5">
        <div className="flex flex-wrap gap-2">
          {(active || restoring) ? <Button icon={Square} disabled={!!busy} loading={busy === 'stop'} onClick={() => act('stop')}>Turn off and restore</Button>
            : !batteryRefused && <Button variant="primary" icon={batteryFirst ? Battery : Play} disabled={!!busy || !canStart} loading={busy === 'start'} onClick={() => act('start', batteryFirst ? { allow_battery: true } : undefined)} data-mac-power-start>{startLabel}</Button>}
          <Button icon={RotateCw} disabled={!!busy} onClick={() => refresh(true)}>Check status</Button>
        </div>
        {batteryFirst && <p className="mt-2 text-xs text-x-ink-secondary" data-mac-power-battery-sentence>{BATTERY_SENTENCE}</p>}
        <p className="mt-3 text-[11px] leading-relaxed text-x-muted">Ends with the timer, when IVE quits, at 20 % battery or when the Mac gets too warm. Keep the Mac ventilated and lock it before closing the lid (Control-Command-Q).</p>
      </div>
    </div>
  </div>
}
