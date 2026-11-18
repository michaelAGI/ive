import { useCallback, useEffect, useRef, useState } from 'react'
import { Smartphone, Cable, Check, Loader2, RefreshCw, ArrowUpRight, Square, ShieldCheck } from 'lucide-react'
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
  const pending = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const next = await api.deviceHubStatus()
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
  const selectRecipe = (item) => { setRecipe(item.id); setTask(item.prompt); setSent(false) }
  const sendTask = () => perform(async () => {
    try {
      await api.sendSessionInput(assignment.session_id, deviceTaskPrompt(selected, task), { ready_timeout: 25 })
      setSent(true)
    } catch (e) {
      throw new Error(`${e.message} Open the agent to check whether the task arrived before sending it again.`)
    }
  })

  return <Modal title="Devices" subtitle="Let your agent see and use your iPhone." icon={Smartphone} size="lg" onClose={onClose} bodyClassName="device-hub">
    <div className="device-hub-body">
      <section className="device-hub-controls" aria-label="iPhone setup and control">
        <div className="device-hub-heading"><span className="device-hub-eyebrow">IPHONE + IVE</span>
          <h2>{assignment ? 'Your iPhone is connected.' : 'Plug in. Let your agent take it from here.'}</h2>
          <p>{assignment ? 'Choose a task below or open the assigned agent. Keep your iPhone unlocked and within reach.' : 'Connect your iPhone to this Mac with a USB cable and unlock it. IVE can prepare the connection for you.'}</p>
        </div>
        {error && <div role="alert" className="device-hub-error">{error}</div>}
        {status?.error && <div role="status" className="device-hub-notice">{status.error.message}</div>}
        <div className="device-hub-devices">
          <div className="device-hub-row"><h3>Your devices</h3><button type="button" className="device-hub-link" disabled={busy} onClick={() => perform(refresh)}><RefreshCw size={13} /> Refresh</button></div>
          {!status ? <p className="device-hub-status"><Loader2 size={16} className="device-hub-spin" /> Checking this Mac…</p> : !status.devices.length ?
            <div className="device-hub-empty"><Cable size={22} /><span>No iPhone detected yet.<small>Connect a data cable, unlock the phone and accept “Trust This Computer” if shown.</small></span></div> :
            <div className="device-hub-device-list">{status.devices.map(d => <button key={d.id} type="button" className={`device-hub-device ${selected === d.id ? 'is-selected' : ''}`}
              aria-pressed={selected === d.id} onClick={() => setSelected(d.id)}><Smartphone size={23} /><span><strong>{d.name}</strong><small>{d.model} · iOS {d.os_version} · {d.transport === 'wired' ? 'USB' : d.transport === 'localNetwork' ? 'Wi-Fi' : 'Connection needs checking'}</small></span>
              {selected === d.id && <Check size={16} />}</button>)}</div>}
        </div>
        <ol className="device-hub-checks" aria-label="Connection steps">
          {[['Mac support', checks?.helper_ready, checks?.supported_mac === false ? checks.requirements : checks?.xcode_ready === false ? 'Xcode needs setup' : 'Prepared once by the agent'],
            ['iPhone connection', device?.developer_mode === 'enabled', 'Trust, unlock and Developer Mode'],
            ['Agent access', !!assignment, assignment ? (sessions[assignment.session_id]?.name || 'Assigned agent') : 'One agent at a time']].map(([label, complete, detail], i) =>
            <li key={label} className={complete ? 'is-complete' : ''}><span>{complete ? <Check size={12} /> : i + 1}</span><div><strong>{label}</strong><small>{detail}</small></div></li>)}
        </ol>
        {setup && <div className="device-hub-progress" role="status" aria-live="polite">
          {setup.state === 'running' ? <Loader2 size={17} className="device-hub-spin" /> : setup.state === 'ready' ? <Check size={17} /> : <Cable size={17} />}
          <div><strong>{setup.state === 'needs_user' ? 'One step needs you' : setup.state === 'ready' ? 'Setup checked' : 'Your setup agent'}</strong><p>{setup.message}</p>
            <button className="device-hub-link" type="button" onClick={() => openSession(setup.session_id)}>Open agent <ArrowUpRight size={13} /></button></div>
        </div>}
        {!assignment && <div className="device-hub-launch">
          <label className="device-hub-field">Agent<select value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}>
            {!providers.length && <option value="">Connect Claude Code or Codex first</option>}{providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <label className="device-hub-permission"><input type="checkbox" checked={fullAccess} onChange={e => setFullAccess(e.target.checked)} disabled={busy} />
            <span><strong>Full access</strong><small>Let this agent run commands and change files and settings on this Mac without individual approvals. Apple’s confirmations still need you.</small></span><ShieldCheck size={17} /></label>
          {!setupActive && <button type="button" className="device-hub-primary" disabled={busy || !status || !provider || checks?.supported_mac === false}
            onClick={() => start(true)}>{busy ? <Loader2 size={16} className="device-hub-spin" /> : <Cable size={16} />} Let an agent set it up</button>}
          {!setupActive && <p className="device-hub-caption">Prepares the Mac, connects the selected iPhone and gives this agent access to its screen and controls. {task.trim() ? 'Your task below starts after setup succeeds. ' : ''}Screenshots are visible to your chosen agent and its provider.</p>}
          {ready && !setupActive && <button type="button" className="device-hub-secondary" disabled={busy || !provider} onClick={() => start(false)}>Start controlling this iPhone <ArrowUpRight size={14} /></button>}
          {ready && <details className="device-hub-existing"><summary>Use an existing session</summary><p>Sessions opened before this update need a restart to load the device tools.</p>
            <label className="device-hub-field">Session<select value={existing} onChange={e => setExisting(e.target.value)}><option value="">Choose a session</option>{availableSessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <button type="button" className="device-hub-secondary" disabled={busy || !existing} onClick={() => perform(async () => { await api.deviceHubAction('assign', { device_id: selected, session_id: existing }); setLastSession(existing) })}>Give this session control</button></details>}
        </div>}
        {assignment && <div className="device-hub-assigned"><strong>{sessions[assignment.session_id]?.name || 'Assigned agent'}</strong><p>Give this agent a task. Access lasts up to one hour and can be stopped at any time.</p>
          <button type="button" className="device-hub-primary" onClick={() => openSession(assignment.session_id)}>Open agent <ArrowUpRight size={15} /></button></div>}
        {(assignment || setup) && <button type="button" className="device-hub-stop" disabled={busy} onClick={stop}><Square size={13} /> Stop {assignment ? 'control' : 'setup'}</button>}
        {setupSession && !setup && !assignment && <button className="device-hub-link" onClick={() => openSession(setupSession)}>Open the created agent session <ArrowUpRight size={13} /></button>}
        <section className="device-hub-ideas" aria-label="Ten useful iPhone tasks">
          <h3>What could your agent do?</h3><p className="device-hub-caption">Choose a starting point, then make it yours. Results depend on the apps and data available on your phone.</p>
          <div className="device-hub-recipes">{deviceUseCases.map((item, i) => <button type="button" key={item.id} aria-pressed={recipe === item.id}
            className={`device-hub-recipe ${recipe === item.id ? 'is-selected' : ''}`} onClick={() => selectRecipe(item)}>
            <span>{String(i + 1).padStart(2, '0')}</span><div><strong>{item.title}</strong><small>{item.benefit}</small></div></button>)}</div>
          <label className="device-hub-field">Your task<textarea value={task} onChange={e => { setTask(e.target.value); setRecipe(''); setSent(false) }}
            placeholder="Choose an idea above or describe what you need…" rows={task ? 5 : 2} /></label>
          {assignment ? <><button type="button" className="device-hub-secondary" disabled={busy || sent || !task.trim()} onClick={sendTask}>
            {sent ? <><Check size={14} /> Task sent</> : <>Send task to agent <ArrowUpRight size={14} /></>}</button>
            {sent && <p className="device-hub-caption" role="status">Open the agent to follow its progress.</p>}</> : <p className="device-hub-caption">{setup ? sent ? 'Your task was sent to the setup agent and starts after setup succeeds.' : 'Setup is already running. Send this task once the iPhone is assigned.' : 'Your task is sent when you start setup or control above.'}</p>}
        </section>
        <details className="device-hub-guide"><summary>Connection guide & troubleshooting</summary>
          <ol><li>Use an Apple silicon Mac with macOS 27 or newer, Xcode 27 or newer, and an iPhone with iOS 27 or newer.</li>
            <li>Connect the iPhone with a data-capable USB cable. Unlock it and accept <strong>Trust This Computer</strong>.</li>
            <li>Choose <strong>Let an agent set it up</strong>. The agent prepares the bundled helper and starts pairing. If Xcode is missing, it opens the official download and tells you which Apple prompts need your confirmation.</li>
            <li>When requested, enable <strong>Settings → Privacy & Security → Developer Mode</strong> on the iPhone. Restart, unlock and confirm. Tell the setup agent to continue.</li>
            <li>After setup, give the assigned agent a task. For tapping and swiping, hold the iPhone in portrait. Text input replaces the phone’s clipboard.</li>
            <li>After the first USB pairing, the same Wi-Fi may work too. Keep the Mac awake and the phone reachable. Different networks and a switched-off Mac are not supported by this connection.</li></ol>
          <p>If a step fails, unlock and reconnect the iPhone, then ask the setup agent to check again. A successful screenshot confirms screen access; the agent must check the result after each input.</p>
          <p>Stop control releases the IVE device tools. A full-access agent session can still run other Mac commands; stop that session too to end all of its activity.</p>
          <p><a href="https://support.apple.com/109054" target="_blank" rel="noreferrer">Apple: trusting this computer ↗</a> · <a href="https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device" target="_blank" rel="noreferrer">Developer Mode ↗</a></p>
          <p>This controls the iPhone from your Mac. “Phone access” in Settings lets you operate IVE from the phone.</p>
        </details>
      </section>
      <aside className="device-hub-preview" aria-label="iPhone screen preview">
        <div className="device-hub-preview-top"><span>{frame ? 'Screen preview' : 'Your iPhone screen'}</span>{assignment && <button type="button" className="device-hub-link" onClick={() => setPreview(v => !v)}>{preview ? 'Pause preview' : 'Show preview'}</button>}</div>
        <div className="device-hub-phone">{frame ? <img src={`data:image/png;base64,${frame.image_base64}`} alt="Latest screenshot from the assigned iPhone" /> :
          <div className="device-hub-phone-empty"><Smartphone size={40} strokeWidth={1} /><strong>{assignment ? 'Ready for your agent' : 'Your phone, within reach.'}</strong><span>{assignment ? 'Show a preview or open the agent to start.' : 'A real screen preview appears here after you connect and assign your iPhone.'}</span></div>}</div>
        <p className="device-hub-caption">{frame ? `Captured ${new Date(frame.observed_at * 1000).toLocaleTimeString()}. ${preview ? 'Updates every few seconds.' : 'Preview paused.'}` : 'No screen is shared before you give access.'}</p>
      </aside>
    </div>
  </Modal>
}
