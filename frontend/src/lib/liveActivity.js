// A live process is not the same thing as an active turn. Keep the Overview
// status row and its filters on this one conservative definition of current
// work: working / attention ("Needs you") / idle ("Done") / stopped.
import { getSessionDisplayStatus } from './sessionStatus.js'
import { sessionNeedsAttention } from './sessionAttention.js'
import { isVisibleSession } from './visibleSessions.js'

export function liveActivityOf(session, sessionStarted = {}) {
  if (!session) return 'stopped'
  const meta = getSessionDisplayStatus(session, sessionStarted)
  if (meta.state === 'failed') return 'attention'
  if (session.pty_alive === false || meta.state === 'stopped') return 'stopped'
  if (sessionNeedsAttention(session) || meta.state === 'waiting') return 'attention'
  // Replay/output activity and a recently used tool are not proof that an
  // agent is still working. Only its current turn state belongs here; for a
  // plain terminal that is a running program or its agent's running turn.
  return meta.isWorking ? 'working' : 'idle'
}

export function scopedActivitySessions(sessions, { tabScope, activeWorkspaceId } = {}) {
  return Object.values(sessions || {}).filter((session) => isVisibleSession(session)
    && (tabScope !== 'workspace' || !activeWorkspaceId || session.workspace_id === activeWorkspaceId))
}

// The states of the status row, in the order it shows them. Every open
// session is in exactly one of Working / Needs you / Done, so the three
// always add up to All. A stopped session sits in Done, like on the board
// (sessionVocabulary.boardColumnOf); a failed one needs you.
export const ACTIVITY_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'working', label: 'Working' },
  { value: 'attention', label: 'Needs you' },
  { value: 'done', label: 'Done' },
]

export function activityFilterOf(session, sessionStarted = {}) {
  const activity = liveActivityOf(session, sessionStarted)
  return activity === 'working' || activity === 'attention' ? activity : 'done'
}

export function activityMatches(session, filter, sessionStarted = {}) {
  if (filter === 'working' || filter === 'attention' || filter === 'done') return activityFilterOf(session, sessionStarted) === filter
  return true
}

export function openActivityTabs(openTabs, sessions, scope, filter = 'all', sessionStarted = {}) {
  const available = new Set(scopedActivitySessions(sessions, scope).map((session) => session.id))
  return openTabs.filter((id) => available.has(id) && activityMatches(sessions[id], filter, sessionStarted))
}

// One pass over the open tiles: how many the row shows per state.
export function activityCounts(openTabs, sessions, scope, sessionStarted = {}) {
  const counts = { all: 0, working: 0, attention: 0, done: 0 }
  for (const id of openActivityTabs(openTabs, sessions, scope, 'all', sessionStarted)) {
    counts.all += 1
    counts[activityFilterOf(sessions[id], sessionStarted)] += 1
  }
  return counts
}
