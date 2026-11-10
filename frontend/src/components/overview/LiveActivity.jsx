import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronUp, CircleCheck, Radio, WifiOff } from 'lucide-react'
import useStore from '../../state/store'
import { activityLineOf } from '../../lib/sessionVocabulary'
import { isShellSession } from '../../lib/sessionStatus'
import { liveActivityOf, observedWorkDuration, openActivityTabs, scopedActivitySessions } from '../../lib/liveActivity'
import { getCliLabel } from '../../lib/constants'
import './live-activity.css'

function ActivitySignal({ active }) {
  return <span className="ive-work-signal" data-active={active ? 'true' : 'false'} aria-hidden="true"><i /><i /><i /><i /></span>
}

export default function LiveActivity({ filter, onFilterChange }) {
  const sessions = useStore((s) => s.sessions)
  const openTabs = useStore((s) => s.openTabs)
  const workspaces = useStore((s) => s.workspaces)
  const tabScope = useStore((s) => s.tabScope)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const sessionLastTool = useStore((s) => s.sessionLastTool)
  const sessionWorkStartedAt = useStore((s) => s.sessionWorkStartedAt)
  const connected = useStore((s) => s.connected)
  const synced = useStore((s) => s.sessionStateSynced)
  const live = connected && synced
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(Date.now)
  const focusedCard = useRef(null)
  const collapseButton = useRef(null)

  const scoped = useMemo(() => scopedActivitySessions(sessions, { tabScope, activeWorkspaceId }), [sessions, tabScope, activeWorkspaceId])
  // Stable source order keeps cards still while tool events arrive. An active
  // turn changing its last-tool timestamp must not move under the pointer.
  const working = scoped.filter((session) => liveActivityOf(session, sessionStarted) === 'working')
  const waiting = scoped.filter((session) => liveActivityOf(session, sessionStarted) === 'attention')
  const counts = Object.fromEntries(['all', 'working', 'attention'].map((value) => [value,
    openActivityTabs(openTabs, sessions, { tabScope, activeWorkspaceId }, value, sessionStarted).length,
  ]))
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const scopeName = tabScope === 'workspace' && activeWorkspaceId ? workspaceNames.get(activeWorkspaceId) || 'This project' : 'All projects'

  useLayoutEffect(() => {
    if (!focusedCard.current || working.some((session) => session.id === focusedCard.current)) return
    // A turn may finish while its card has keyboard focus. Return focus to
    // the section control, rather than dropping the next Tab into the page.
    if (document.activeElement === document.body) collapseButton.current?.focus({ preventScroll: true })
    focusedCard.current = null
  }, [working])

  useEffect(() => {
    if (!live || !working.length || collapsed) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, working.length, collapsed])

  const open = (session) => {
    const store = useStore.getState()
    // Merely inspecting an active session must not submit input or restart it.
    store.goSession(session.id, { autoStart: false })
  }

  return <div className="ive-overview-activity" data-overview-activity="" data-live={live ? 'true' : 'false'}>
    <section className="ive-live-work" aria-labelledby="ive-live-work-title" data-working-section="">
      <div className="ive-live-work-heading">
        <div className="ive-live-work-title">
          <Radio size={15} aria-hidden="true" />
          <h2 id="ive-live-work-title">{live ? 'Working now' : 'Last known activity'}</h2>
          <span className="ive-live-work-count" data-working-count="">{working.length}</span>
          <span className="ive-live-work-scope">{scopeName}</span>
        </div>
        <div className="ive-live-work-actions">
          {waiting.length > 0 && <button type="button" className="ive-live-needs-you" onClick={() => open(waiting[0])} title="Open the first session that needs your attention">
            <span aria-hidden="true" />{waiting.length} {waiting.length === 1 ? 'needs' : 'need'} you<ArrowUpRight size={12} aria-hidden="true" />
          </button>}
          <button ref={collapseButton} type="button" className="ive-live-collapse" aria-label={collapsed ? 'Expand working sessions' : 'Collapse working sessions'} aria-expanded={!collapsed} aria-controls="ive-live-work-cards" onClick={() => setCollapsed((value) => !value)}>
            {collapsed ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {!live && <p className="ive-live-offline" role="status"><WifiOff size={13} aria-hidden="true" />{connected ? 'Refreshing session state…' : 'Connection lost. Activity may have changed.'}</p>}
      {!collapsed && <div id="ive-live-work-cards" className="ive-live-work-body">
        {working.length > 0 ? <ul className="ive-live-work-cards" aria-label={live ? 'Working sessions' : 'Last known working sessions'}>
          {working.map((session) => {
            const lastTool = sessionLastTool[session.id] || session.last_activity
            const activity = activityLineOf(session, { lastTool })
            const duration = live ? observedWorkDuration(sessionWorkStartedAt[session.id], now) : ''
            const workspace = workspaceNames.get(session.workspace_id)
            return <li key={session.id}>
              <button type="button" className="ive-live-work-card" data-working-session={session.id} onClick={() => open(session)} onFocus={() => { focusedCard.current = session.id }} onBlur={(event) => { if (event.relatedTarget) focusedCard.current = null }} aria-label={`Open working session ${session.name || 'Session'}`}>
                <span className="ive-live-work-card-top"><ActivitySignal active={live} /><strong>{session.name || 'Session'}</strong><ArrowUpRight size={14} className="ive-live-open-arrow" aria-hidden="true" /></span>
                <span className="ive-live-work-step" title={activity || undefined}>{activity ? <><span>Latest · </span>{activity}</> : isShellSession(session) ? 'Command running' : 'Agent is working'}</span>
                <span className="ive-live-work-card-foot"><span>{isShellSession(session) ? 'Terminal' : getCliLabel(session.cli_type || 'claude')}{workspace ? ` · ${workspace}` : ''}</span>{duration && <time title="Time IVE has observed this turn working">{duration}</time>}</span>
              </button>
            </li>
          })}
        </ul> : <p className="ive-live-work-empty"><CircleCheck size={16} aria-hidden="true" /><span>{live ? 'No sessions are working right now.' : 'No working sessions in the last known state.'}{live && waiting.length > 0 ? ' A session is waiting for you.' : ''}</span></p>}
      </div>}
    </section>
    <div className="ive-overview-filter-bar">
      <span className="ive-overview-filter-label">Open sessions</span>
      <div className="ive-overview-filters" role="group" aria-label="Filter open sessions">
        {[['all', 'All'], ['working', 'Working'], ['attention', 'Needs you']].map(([value, label]) => <button type="button" key={value} data-activity-filter={value} aria-pressed={filter === value} onClick={() => onFilterChange(value)}>{label}<span>{counts[value]}</span></button>)}
      </div>
    </div>
  </div>
}
