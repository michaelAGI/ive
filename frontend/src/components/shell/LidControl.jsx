import { useCallback, useEffect, useRef, useState } from 'react'
import { Battery, Leaf, Lock, Pause, RotateCw, Settings2, Timer } from 'lucide-react'
import EyelidIcon from './EyelidIcon'
import { api, ApiError } from '../../lib/api'
import { APPS, DURATIONS, LOGIN_ITEMS_REASONS, canStart, needsHelperRestart, fetchSharedOptions, headline, loadOptions, pushSharedOptions, remaining, remainingShort, saveOptions } from '../../lib/macPower'
import './lid-control.css'

// The eyelid in the header: one glance shows whether the Mac keeps working
// with the lid closed, one click opens the switch and the conditions. The
// full explanation and the rare recovery paths stay in Settings → Mac & Power.
const POLL_CLOSED_MS = 15000
const POLL_OPEN_MS = 4000

function describe(e, fallback) {
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body : {}
  return { message: e?.message || fallback, reason: body.reason ? String(body.reason) : null,
    refused: e instanceof ApiError && e.status >= 400 && e.status < 500 && !!body.reason }
}

function endsAt(expires) {
  const t = Date.parse(expires)
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

export default function LidControl({ onOpenSettings }) {
  const [status, setStatus] = useState({ state: 'loading' })
  const [options, setOptions] = useState(loadOptions)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState(null)
  const [now, setNow] = useState(Date.now)
  const root = useRef(null)
  const revision = useRef(0)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const openRef = useRef(false)
  openRef.current = open

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    const current = ++revision.current
    try {
      const value = await api.macPower.status()
      if (!mounted.current || revision.current !== current) return
      setStatus(value)
      setFailure(f => (f && (value.state === 'active' || f.reason === 'status')) ? null : f)
    } catch (e) {
      if (mounted.current && revision.current === current) {
        setStatus({ state: 'unknown' })
        setFailure({ message: e?.message || 'The Mac status could not be checked.', reason: 'status', refused: false })
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    refresh()
    let timer = null
    const arm = () => { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh() }, openRef.current ? POLL_OPEN_MS : POLL_CLOSED_MS) }
    arm()
    const visible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { mounted.current = false; ++revision.current; clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  // Faster polling while the popover is open, a live clock while the mode runs.
  useEffect(() => { if (open) refresh() }, [open, refresh])
  useEffect(() => {
    if (status.state !== 'active') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status.state])
  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return
    const down = (event) => { if (root.current && !root.current.contains(event.target)) setOpen(false) }
    const key = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true) }
  }, [open])

  const update = (change) => { const value = { ...options, ...change }; setOptions(value); saveOptions(value); pushSharedOptions(api, value) }
  // The menu bar item may have changed the conditions: take the shared copy when the popover opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchSharedOptions(api).then((shared) => { if (!cancelled && shared) { setOptions(shared); saveOptions(shared) } })
    return () => { cancelled = true }
  }, [open])
  const act = async (action, overrides) => {
    if (busyRef.current) return
    const payload = { ...options, ...overrides }
    busyRef.current = true; ++revision.current; setBusy(action); setFailure(null)
    let fail = null
    try {
      const value = action === 'start' ? await api.macPower.start(payload) : await api.macPower[action]()
      if (mounted.current) {
        if (overrides && value.state === 'active') update(overrides)
        setStatus(value); setNow(Date.now())
      }
    } catch (e) {
      fail = describe(e, 'The lid-closed mode could not be changed.')
      if (mounted.current && !fail.refused) setStatus({ state: 'unknown' })
    } finally {
      busyRef.current = false
      if (mounted.current) { setBusy(''); if (fail) setFailure(fail) }
    }
  }

  const active = status.state === 'active'
  const restoring = ['restoring', 'restore_failed'].includes(status.state)
  const startable = canStart(status)
  const unavailable = status.state === 'unavailable'
  const batteryFirst = startable && !options.allow_battery && status.on_battery === true
  const batteryRefused = failure?.reason === 'battery_not_allowed' && !options.allow_battery
  const loginItems = LOGIN_ITEMS_REASONS.includes(failure?.reason) || status.state === 'needs_approval'
  const restartable = needsHelperRestart(status)
  const locked = active || restoring || !!busy
  const toggle = () => {
    if (active || restoring) return act('stop')
    if (!startable) return
    return act('start', batteryFirst ? { allow_battery: true } : undefined)
  }
  const title = headline(status, now)

  return (
    <div ref={root} className="ive-lid" data-lid-control="" data-lid-state={status.state}>
      <button
        type="button"
        data-chrome-button
        className={`ive-header-btn ive-lid-btn${active ? ' is-on' : ''}`}
        aria-label={active ? 'Lid-closed mode is on' : 'Lid-closed mode'}
        aria-pressed={active}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(v => !v)}
      >
        <EyelidIcon closed={active} blink={!active && !busy} size={20} />
        {active && <span className="ive-lid-btn-label" aria-hidden="true">{remainingShort(status.expires_at, now)}</span>}
      </button>

      {open && (
        <div className="ive-lid-pop scale-in" role="dialog" aria-label="Lid-closed mode">
          <div className="ive-lid-row ive-lid-head">
            <div className="min-w-0">
              <div className="ive-lid-title">Close the lid, agents keep working</div>
              <p className="ive-lid-sub" role="status">{active ? `On until ${endsAt(status.expires_at)} · ${remaining(status.expires_at, now)} left` : restartable ? 'Off. The Mac helper needs a restart first.' : (status.message || title)}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={active}
              aria-label="Keep working with the lid closed"
              className={`ive-switch${active ? ' is-on' : ''}${busy ? ' is-busy' : ''}`}
              disabled={!!busy || unavailable || (!active && !restoring && !startable)}
              onClick={toggle}
            >
              <span className="ive-switch-knob" />
            </button>
          </div>

          {failure && (
            <div className="ive-lid-alert" role="alert">
              <p>{failure.message}</p>
              {batteryRefused && <button type="button" className="ive-lid-action" disabled={!!busy} onClick={() => act('start', { allow_battery: true })}><Battery size={13} aria-hidden="true" />Allow battery use and turn on</button>}
              {loginItems && <button type="button" className="ive-lid-action" disabled={!!busy} onClick={() => act('approval')}>Open Login Items & Extensions</button>}
            </div>
          )}
          {restartable && (
            <div className="ive-lid-alert" data-lid-restart="">
              <p>{status.message || 'The Mac helper still runs from another copy of IVE.'}</p>
              <button type="button" className="ive-lid-action" disabled={!!busy} onClick={() => act('restartHelper')}><RotateCw size={13} aria-hidden="true" />{busy === 'restartHelper' ? 'Waiting for your password…' : 'Restart Mac helper'}</button>
            </div>
          )}
          {!failure && status.state === 'needs_approval' && (
            <div className="ive-lid-alert">
              <p>macOS has to allow the IVE helper once.</p>
              <button type="button" className="ive-lid-action" disabled={!!busy} onClick={() => act('approval')}>Open Login Items & Extensions</button>
            </div>
          )}
          {batteryFirst && !failure && <p className="ive-lid-hint">You are on battery. Turning on allows battery use until 20 % remain.</p>}

          <div className={`ive-lid-conditions${locked ? ' is-locked' : ''}`}>
            <label className="ive-lid-row">
              <span className="ive-lid-label"><Timer size={14} aria-hidden="true" />For at most</span>
              <select className="ive-lid-select" disabled={locked} value={options.duration_seconds} onChange={e => update({ duration_seconds: Number(e.target.value) })}>
                {DURATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="ive-lid-row ive-lid-check">
              <span className="ive-lid-label"><Battery size={14} aria-hidden="true" />Also on battery</span>
              <input type="checkbox" disabled={locked} checked={active ? !!status.allow_battery : !!options.allow_battery} onChange={e => update({ allow_battery: e.target.checked })} />
            </label>
            <label className="ive-lid-row ive-lid-check">
              <span className="ive-lid-label"><Leaf size={14} aria-hidden="true" />Low Power Mode while closed</span>
              <input type="checkbox" disabled={locked} checked={active ? !!status.lid_low_power : !!options.lid_low_power} onChange={e => update({ lid_low_power: e.target.checked })} />
            </label>
            <div className="ive-lid-row ive-lid-apps">
              <span className="ive-lid-label"><Pause size={14} aria-hidden="true" />Pause while closed</span>
              <div className="ive-lid-chips">
                {APPS.map(([id, name]) => {
                  const on = (active ? status.pause_apps || [] : options.pause_apps).includes(id)
                  return <button key={id} type="button" className={`ive-lid-chip${on ? ' is-on' : ''}`} aria-pressed={on} disabled={locked}
                    onClick={() => update({ pause_apps: on ? options.pause_apps.filter(key => key !== id) : [...options.pause_apps, id] })}>{name}</button>
                })}
              </div>
            </div>
          </div>

          <div className="ive-lid-foot">
            <span className="ive-lid-hint"><Lock size={12} aria-hidden="true" />Lock the Mac (Control-Command-Q) before closing the lid.</span>
            <button type="button" className="ive-lid-action" onClick={() => { setOpen(false); onOpenSettings?.('mac-power') }}><Settings2 size={13} aria-hidden="true" />All settings</button>
          </div>
        </div>
      )}
    </div>
  )
}
