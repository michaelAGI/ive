import { useCallback, useEffect, useRef, useState } from 'react'
import { Smartphone, Cable, Check, Loader2, RefreshCw, ArrowUpRight, Square, ChevronRight } from 'lucide-react'
import Modal from '../ui/Modal'
import { api } from '../../lib/api'
import { getCliTypes } from '../../lib/constants'
import { lastAgentChoice } from '../../lib/quickStart'
import { startDeviceAgent, deviceTaskPrompt } from '../../lib/deviceHub'
import { deviceUseCases } from '../../lib/deviceUseCases'
import useStore from '../../state/store'
import './devices.css'

export default function DeviceHub({ onClose }) {
  const profiles = useStore(s => s.cliProfiles)
  const sessions = useStore(s => s.sessions)
  const providers = getCliTypes().filter(p => ['claude', 'codex'].includes(p.id))
  const [provider, setProvider] = useState(() => {
    const choice = lastAgentChoice().cli
    return providers.some(p => p.id === choice) ? choice : providers[0]?.id || ''
  })
  const [fullAccess, setFullAccess] = useState(true)
  const [status, setStatus] = useState(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState(null)
  const [preview, setPreview] = useState(false)
  const [lastSession, setLastSession] = useState(null)
  const [task, setTask] = useState('')
  const [recipe, setRecipe] = useState('')
  const [sent, setSent] = useState(false)
  const [existing, setExisting] = useState('')
  const taskInput = useRef(null)
  const ideas = useRef(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async (force = false) => {
    const next = await api.deviceHubStatus(force)
    if (!mounted.current) return
    setStatus(next)
    setSelected(current => next.devices.some(d => d.id === current) ? current :
      next.devices.length === 1 ? next.devices[0].id : '')
  }, [])
  useEffect(() => {
    mounted.current = true
    let timer
    const poll = async () => {
      try { await refresh() } catch (e) { if (mounted.current) setError(e.message) }
      if (mounted.current) timer = setTimeout(poll, 4000)
    }
    poll()
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [refresh])
  useEffect(() => {
    if (!provider && providers.length) setProvider(providers[0].id)
  }, [profiles, provider]) // Profiles arrive after the app connects.
  const device = status?.devices.find(d => d.id === selected)
  const assignment = device?.assignment
  const setup = status?.setup
  const setupActive = setup && setup.state !== 'ready'
  const setupSession = setup?.session_id || lastSession
  useEffect(() => { setFrame(null); setPreview(false) }, [selected, assignment?.lease_id])
  useEffect(() => { setSent(false) }, [selected])
  useEffect(() => {
    if (!preview || !selected || !assignment) return
    let cancelled = false, timer
    const poll = async () => {
      try {
        const next = await api.deviceHubAction('observe', { device_id: selected })
        if (!cancelled) setFrame(next)
      } catch (e) {
        if (!cancelled) { setError(e.message); setFrame(null); setPreview(false) }
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [preview, selected, assignment?.lease_id])
  const perform = async (fn) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await fn(); await refresh() }
    catch (e) { if (mounted.current) { setError(e.message); if (e.deviceSessionId) setLastSession(e.deviceSessionId) } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const openSession = id => { useStore.getState().goSession(id); onClose() }
  const start = (isSetup) => perform(async () => {
    await startDeviceAgent({ api, provider, fullAccess, deviceId: selected,
      setup: isSetup, task, onSession: session => { useStore.getState().addSession(session); setLastSession(session.id) } })
    setSent(!!task.trim())
  })
  const stop = () => perform(async () => {
    setPreview(false); setFrame(null)
    if (assignment) await api.deviceHubAction('unassign', { device_id: selected })
    if (setup && (!assignment || setup.device_id === selected)) await api.deviceHubAction('stop-setup')
  })
  const availableSessions = Object.values(sessions).filter(s => !s.archived && ['claude', 'codex'].includes(s.cli_type)
    && !['plan', 'read-only'].includes(s.permission_mode))
  const checks = status?.checks
  const ready = !!device?.control_available
  const selectRecipe = (item) => {
    setRecipe(item.id); setTask(item.prompt); setSent(false)
    if (ideas.current) ideas.current.open = false
    taskInput.current?.focus()
  }
  const sendTask = () => perform(async () => {
    try {
      await api.sendSessionInput(assignment.session_id, deviceTaskPrompt(selected, task), { ready_timeout: 25 })
      setSent(true)
    } catch (e) {
      throw new Error(`${e.message} Open the agent to check whether the task arrived before sending it again.`)
    }
  })

  const showScreen = !!assignment && (preview || !!frame)
  const connectionChecks = [
    ['Mac', checks?.helper_ready ? 'Ready' : checks?.supported_mac === false ? checks.requirements : checks?.xcode_ready === false ? 'Xcode setup required' : 'The agent will prepare this Mac', checks?.helper_ready],
    ['iPhone', device?.developer_mode === 'enabled' ? 'Developer Mode enabled' : 'Unlock, trust this Mac and enable Developer Mode', device?.developer_mode === 'enabled'],
    ['Access', assignment ? (sessions[assignment.session_id]?.name || 'Assigned agent') : 'No agent assigned', !!assignment],
  ]

  return <Modal title="Devices" size="md" onClose={onClose} className={showScreen ? 'device-hub-modal has-screen' : 'device-hub-modal'} bodyClassName="device-hub">
    <div className={`device-hub-body ${showScreen ? 'has-screen' : ''}`}>
      <section className="device-hub-controls" aria-label="iPhone setup and control">
        <div className="device-hub-heading">
          <h2>{assignment ? 'iPhone control' : setupActive ? 'Connecting your iPhone' : 'Connect an iPhone'}</h2>
          <p>{assignment ? 'Give your agent a task. Keep the iPhone unlocked.' : setupActive ? 'Your agent will guide you through the remaining steps.' : 'Connect by USB, unlock the phone and tap “Trust” if asked.'}</p>
        </div>
        {error && <div role="alert" className="device-hub-error">{error}</div>}
        {status?.error && <div role="status" className="device-hub-notice">{status.error.message}</div>}

        <div className="device-hub-devices">
          <div className="device-hub-row"><h3>iPhone</h3><button type="button" className="device-hub-link" disabled={busy} onClick={() => perform(() => refresh(true))}><RefreshCw size={13} /> Refresh</button></div>
          {!status ? <p className="device-hub-status"><Loader2 size={16} className="device-hub-spin" /> Checking for devices…</p> : !status.devices.length ?
            <div className="device-hub-empty"><Cable size={20} /><span>No iPhone connected<small>Use a USB cable that supports data transfer.</small></span></div> :
            <div className="device-hub-device-list">{status.devices.map(d => <button key={d.id} type="button" className={`device-hub-device ${selected === d.id ? 'is-selected' : ''}`}
              aria-pressed={selected === d.id} onClick={() => setSelected(d.id)}><Smartphone size={21} strokeWidth={1.5} /><span><strong>{d.name}</strong><small>{d.model} · iOS {d.os_version} · {d.transport === 'wired' ? 'USB' : d.transport === 'localNetwork' ? 'Wi-Fi' : 'Check connection'}</small></span>
              {selected === d.id && <Check size={15} />}</button>)}</div>}
        </div>

        {setup && <div className="device-hub-progress" role="status" aria-live="polite">
          {setup.state === 'running' ? <Loader2 size={16} className="device-hub-spin" /> : setup.state === 'ready' ? <Check size={16} /> : <Cable size={16} />}
          <div><strong>{setup.state === 'needs_user' ? 'Check your iPhone' : setup.state === 'ready' ? 'Setup complete' : setup.state === 'failed' ? 'Setup needs attention' : 'Setup in progress'}</strong><p>{setup.message}</p>
            <button className="device-hub-link" type="button" onClick={() => openSession(setup.session_id)}>Open setup agent <ArrowUpRight size={13} /></button></div>
        </div>}

        {!assignment && !setupActive && <div className="device-hub-launch">
          <label className="device-hub-field">Agent<select value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}>
            {!providers.length && <option value="">Connect Claude Code or Codex first</option>}{providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <label className="device-hub-permission"><input type="checkbox" checked={fullAccess} onChange={e => setFullAccess(e.target.checked)} disabled={busy} />
            <span><strong>Full access on this Mac</strong><small>Can run commands and change files and settings without asking. Apple confirmations still need you.</small></span></label>
        </div>}

        {assignment && <div className="device-hub-assigned">
          <span className="device-hub-agent-status"><span aria-hidden="true" />{sessions[assignment.session_id]?.name || 'Assigned agent'}</span>
          <button type="button" className="device-hub-link" onClick={() => openSession(assignment.session_id)}>Open agent <ArrowUpRight size={13} /></button>
        </div>}

        <section className="device-hub-task" aria-label="iPhone task">
          <label className="device-hub-field">{assignment ? 'Task' : 'Task (optional)'}<textarea ref={taskInput} value={task} onChange={e => { setTask(e.target.value); setRecipe(''); setSent(false) }}
            placeholder="What should the agent do on your iPhone?" rows={task ? 5 : 3} /></label>
          <details className="device-hub-ideas" ref={ideas}><summary>Choose a task idea <ChevronRight size={13} /></summary>
            <div className="device-hub-recipes">{deviceUseCases.map(item => <button type="button" key={item.id} aria-pressed={recipe === item.id}
              className={`device-hub-recipe ${recipe === item.id ? 'is-selected' : ''}`} onClick={() => selectRecipe(item)}>
              <span><strong>{item.title}</strong><small>{item.benefit}</small></span><ChevronRight size={14} /></button>)}</div>
          </details>
        </section>

        {checks?.supported_mac === false && <p className="device-hub-notice" role="status">{checks.requirements || 'iPhone control requires Apple silicon, macOS 27 and Xcode 27.'}</p>}
        <div className="device-hub-actions">
          {!assignment && !setupActive && <>
            <button type="button" className="device-hub-primary" disabled={busy || !status || !provider || checks?.supported_mac === false} onClick={() => start(!ready)}>
              {busy ? <Loader2 size={15} className="device-hub-spin" /> : null}{ready ? 'Start control' : 'Connect iPhone'}<ArrowUpRight size={15} /></button>
            <p className="device-hub-caption">{ready ? 'Gives this agent access to your iPhone.' : 'Your agent sets up the connection and gets access to your iPhone.'} Its screen is visible to the agent and its provider.</p>
          </>}
          {assignment && <>
            <button type="button" className="device-hub-primary" disabled={busy || sent || !task.trim()} onClick={sendTask}>
              {sent ? <><Check size={14} /> Task sent</> : <>Send task <ArrowUpRight size={14} /></>}</button>
            {sent && <p className="device-hub-caption" role="status">Open the agent to follow its progress.</p>}
            <div className="device-hub-control-actions">
              <button type="button" className="device-hub-link" onClick={() => { setPreview(!showScreen); setFrame(null) }}><Smartphone size={14} />{showScreen ? 'Hide screen' : 'Show screen'}</button>
              <button type="button" className="device-hub-stop" disabled={busy} onClick={stop}><Square size={12} /> Stop control</button>
            </div>
            <p className="device-hub-caption">Access ends after one hour, or when you stop control.</p>
          </>}
          {!assignment && setup && <>
            {task.trim() && <p className="device-hub-caption">{sent ? 'Your task starts once setup is complete.' : 'Send this task once the iPhone is connected.'}</p>}
            <button type="button" className="device-hub-stop" disabled={busy} onClick={stop}><Square size={12} /> Stop setup</button>
          </>}
          {setupSession && !setup && !assignment && <button type="button" className="device-hub-link" onClick={() => openSession(setupSession)}>Open created agent <ArrowUpRight size={13} /></button>}
        </div>

        {ready && !assignment && !setupActive && <details className="device-hub-existing"><summary>Use an existing session</summary><p>Restart sessions opened before the device tools were installed.</p>
          <label className="device-hub-field">Session<select value={existing} onChange={e => setExisting(e.target.value)}><option value="">Choose a session</option>{availableSessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <button type="button" className="device-hub-secondary" disabled={busy || !existing} onClick={() => perform(async () => { await api.deviceHubAction('assign', { device_id: selected, session_id: existing }); setLastSession(existing) })}>Give control</button></details>}

        <details className="device-hub-connection"><summary>Connection details</summary>
          <dl className="device-hub-checks">{connectionChecks.map(([label, detail, complete]) => <div key={label}><dt>{label}</dt><dd>{complete && <Check size={13} />}{detail}</dd></div>)}</dl>
        </details>
        <details className="device-hub-guide"><summary>Connection help</summary>
          <ol><li>Use an Apple silicon Mac with macOS 27 or newer, Xcode 27 or newer, and an iPhone with iOS 27 or newer.</li>
            <li>Connect the iPhone with a data-capable USB cable. Unlock it and accept <strong>Trust This Computer</strong>.</li>
            <li>Choose <strong>Connect iPhone</strong>. The agent prepares the bundled helper and starts pairing. If Xcode is missing, it opens the official download and tells you which Apple prompts need your confirmation.</li>
            <li>When requested, enable <strong>Settings → Privacy & Security → Developer Mode</strong> on the iPhone. Restart, unlock and confirm. Tell the setup agent to continue.</li>
            <li>After setup, give the assigned agent a task. For tapping and swiping, hold the iPhone in portrait. Text input replaces the phone’s clipboard.</li>
            <li>After the first USB pairing, the same Wi-Fi may work too. Keep the Mac awake and the phone reachable. Different networks and a switched-off Mac are not supported by this connection.</li></ol>
          <p>If a step fails, unlock and reconnect the iPhone, then ask the setup agent to check again. A successful screenshot confirms screen access; the agent must check the result after each input.</p>
          <p>Stop control releases the IVE device tools. A full-access agent session can still run other Mac commands; stop that session too to end all of its activity.</p>
          <p><a href="https://support.apple.com/109054" target="_blank" rel="noreferrer">Apple: trusting this computer ↗</a> · <a href="https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device" target="_blank" rel="noreferrer">Developer Mode ↗</a></p>
          <p>This controls the iPhone from your Mac. “Phone access” in Settings lets you operate IVE from the phone.</p>
        </details>
      </section>
      {showScreen && <aside className="device-hub-preview" aria-label="iPhone screen preview">
        <div className="device-hub-preview-top"><h3>Screen preview</h3>{frame && <button type="button" className="device-hub-link" onClick={() => setPreview(v => !v)}>{preview ? 'Pause' : 'Resume'}</button>}</div>
        <div className="device-hub-screen">{frame ? <img src={`data:image/png;base64,${frame.image_base64}`} alt="Latest screenshot from the assigned iPhone" /> :
          <div className="device-hub-screen-loading" role="status"><Loader2 size={20} className="device-hub-spin" /><span>Fetching screen…</span></div>}</div>
        {frame && <p className="device-hub-caption">Captured {new Date(frame.observed_at * 1000).toLocaleTimeString()}. {preview ? 'Updates every few seconds.' : 'Preview paused.'}</p>}
      </aside>}
    </div>
  </Modal>
}
