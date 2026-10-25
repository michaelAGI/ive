// Single source of truth for the Tasks board (⌘B) columns.
// Used by FeatureBoard for layout + by WorkspaceSettingsPanel to populate
// the per-workspace "default destination" dropdowns. `hint` sits under the
// column title, `empty` replaces a bare "no cards".
export const COLUMNS = [
  { key: 'backlog', label: 'Backlog', hint: 'Ideas, not started', empty: 'No ideas parked here. Press n or the plus button to add a card.' },
  { key: 'todo', label: 'To Do', hint: 'Ready to start', empty: 'Nothing is waiting to start.' },
  { key: 'planning', label: 'Planning', hint: 'Agent plans first', empty: 'No agent is planning right now.' },
  { key: 'in_progress', label: 'In Progress', hint: 'Agent working', empty: 'No agent is working on a card.' },
  { key: 'review', label: 'Review', hint: 'Done by an agent, your call', empty: 'Nothing to review. Cards land here when an agent reports it is finished.' },
  { key: 'testing', label: 'Testing', hint: 'Test agent checking', empty: 'No test agent is checking a card.' },
  { key: 'documenting', label: 'Docs', hint: 'Being written up', empty: 'Nothing is being written up.' },
  { key: 'done', label: 'Done', hint: 'Finished', empty: 'Nothing finished yet. Accepted cards land here.' },
  { key: 'blocked', label: 'Blocked', hint: 'Needs a decision', empty: 'Nothing is blocked.' },
]

// Triage is intentionally a view over the board, never a workflow gate. Seven
// days is long enough not to nag about normal week-scale work, while still
// surfacing an unowned card before it disappears into a second planning cycle.
export const BOARD_STALE_DAYS = 7
export const BOARD_PARK_DAYS = 7

export function taskLabels(task) {
  const raw = task?.labels
  if (Array.isArray(raw)) return raw.map(String).map((label) => label.trim()).filter(Boolean)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).map((label) => label.trim()).filter(Boolean)
  } catch {}
  return raw.split(',').map((label) => label.trim()).filter(Boolean)
}

export function parkedUntil(task) {
  const label = taskLabels(task).find((item) => item.startsWith('parked:'))
  if (!label) return null
  const value = label.slice('parked:'.length)
  const date = new Date(`${value}T23:59:59`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function parkTaskLabels(task, now = new Date()) {
  const until = new Date(now)
  until.setDate(until.getDate() + BOARD_PARK_DAYS)
  const stamp = until.toISOString().slice(0, 10)
  return [
    ...taskLabels(task).filter((label) => !label.startsWith('parked:')),
    `parked:${stamp}`,
  ]
}

function taskDate(task) {
  const value = task?.updated_at || task?.created_at
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isCompletedSession(session) {
  const status = String(session?.status || '').toLowerCase()
  return ['exited', 'offline', 'stopped', 'disconnected', 'completed', 'complete', 'done', 'failed', 'error'].includes(status)
}

function hasDocumentation(task, linkedSessions) {
  if (task?.result_summary || task?.lessons_learned || task?.important_notes) return true
  return linkedSessions.some((session) => ['created', 'updated'].includes(session?.board_action))
}

export function needsAttentionReasons(task, sessions = {}, now = new Date()) {
  if (!task || ['done', 'archived'].includes(task.status)) return []
  const parkDate = parkedUntil(task)
  if (parkDate && parkDate > now) return []

  const labels = taskLabels(task).map((label) => label.toLowerCase())
  const reasons = []
  if (labels.some((label) => ['observatory', 'agent-suggested', 'agent_suggested', 'suggested'].includes(label))) {
    reasons.push('agent suggested')
  }

  const changedAt = taskDate(task)
  const staleBefore = now.getTime() - BOARD_STALE_DAYS * 24 * 60 * 60 * 1000
  if (!task.assigned_session_id && changedAt && changedAt.getTime() < staleBefore) {
    reasons.push(`unowned · ${BOARD_STALE_DAYS}d stale`)
  }

  const sessionList = Object.values(sessions || {})
  const linkedSessions = sessionList.filter((session) =>
    session?.id === task.assigned_session_id ||
    session?.id === task.last_agent_session_id ||
    session?.task_id === task.id ||
    session?.active_ticket_id === task.id
  )
  if (linkedSessions.some(isCompletedSession) && !hasDocumentation(task, linkedSessions)) {
    reasons.push('worker finished · undocumented')
  }
  return reasons
}

// Column headers are deliberately quiet. Status is structure, not selection;
// the board reserves orange for the focused card and the primary action.
export const columnAccent = {
  backlog: 'text-x-muted',
  todo: 'text-x-muted',
  planning: 'text-x-muted',
  in_progress: 'text-x-muted',
  review: 'text-x-muted',
  testing: 'text-x-muted',
  documenting: 'text-x-muted',
  done: 'text-x-muted',
  blocked: 'text-x-muted',
}
