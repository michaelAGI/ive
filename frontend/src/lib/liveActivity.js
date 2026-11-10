// A live process is not the same thing as an active turn. Keep the Overview
// lane and its filters on this one conservative definition of current work.
import { getSessionDisplayStatus, isShellSession } from './sessionStatus.js'
import { sessionNeedsAttention } from './sessionAttention.js'
import { isVisibleSession } from './visibleSessions.js'

export function liveActivityOf(session, sessionStarted = {}) {
  if (!session) return 'stopped'
  const meta = getSessionDisplayStatus(session, sessionStarted)
  if (meta.state === 'failed') return 'attention'
  if (session.pty_alive === false || meta.state === 'stopped') return 'stopped'
  if (sessionNeedsAttention(session) || meta.state === 'waiting') return 'attention'
  if (isShellSession(session)) return session.terminal_activity === 'working' ? 'working' : 'idle'
  // Replay/output activity and a recently used tool are not proof that an
  // agent is still working. Only its current turn state belongs here.
  return meta.isWorking ? 'working' : 'idle'
}

export function scopedActivitySessions(sessions, { tabScope, activeWorkspaceId } = {}) {
  return Object.values(sessions || {}).filter((session) => isVisibleSession(session)
    && (tabScope !== 'workspace' || !activeWorkspaceId || session.workspace_id === activeWorkspaceId))
}

export function activityMatches(session, filter, sessionStarted = {}) {
  if (filter === 'working') return liveActivityOf(session, sessionStarted) === 'working'
  if (filter === 'attention') return liveActivityOf(session, sessionStarted) === 'attention'
  return true
}

export function openActivityTabs(openTabs, sessions, scope, filter = 'all', sessionStarted = {}) {
  const available = new Set(scopedActivitySessions(sessions, scope).map((session) => session.id))
  return openTabs.filter((id) => available.has(id) && activityMatches(sessions[id], filter, sessionStarted))
}

// An observed turn timer must never silently fall back to the age of the PTY
// (an agent may have been open for days). The UI labels this as observed time.
export function observedWorkDuration(start, now = Date.now()) {
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(now) || start > now) return ''
  const seconds = Math.floor((now - start) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
