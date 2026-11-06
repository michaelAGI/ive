// Review helpers for task cards and the Review tab. Pure functions over the
// task row GET /api/tasks returns (assigned_session_*, files_changed,
// verification, origin, latest_run_*, result_text). No store, no API, so the
// unit tests import this file directly. Every helper tolerates older rows
// that lack the review fields.

export const ORIGIN_CHIPS = {
  guided: 'Guided task',
  agent: 'Reported by agent',
  backstop: 'Auto-documented, session idle 2\u00a0h',
}

export const VERIFICATION_BADGES = {
  passed: { label: 'Verified', tone: 'good' },
  failed: { label: 'Checks failed', tone: 'danger' },
  running: { label: 'Tests running', tone: 'running' },
  none: { label: 'Not verified', tone: 'muted' },
}

const FILE_LIMIT = 50
const MARKER = /^__pipeline_result:(pass|fail):([\s\S]*)$/
// Stage prompts the pipeline used to copy into result_summary, never a report.
const BOILERPLATE = /^(waiting_for_|pick up task:|task id:|you are the assigned worker)/i

function labelsOf(task) {
  const raw = task?.labels
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? parseList(raw) ?? raw.split(',') : []
  return list.map((label) => String(label).trim().toLowerCase()).filter(Boolean)
}

function parseList(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

export function taskOrigin(task) {
  const origin = String(task?.origin || '').toLowerCase()
  if (ORIGIN_CHIPS[origin] || origin === 'user') return origin
  const labels = labelsOf(task)
  if (labels.includes('ive-guided') || task?.latest_run_id) return 'guided'
  if (labels.includes('auto-triage')) return 'backstop'
  return 'user'
}

export function originChip(task) {
  const origin = taskOrigin(task)
  return ORIGIN_CHIPS[origin] ? { origin, label: ORIGIN_CHIPS[origin] } : null
}

export function verificationState(task) {
  const value = String(task?.verification || '').toLowerCase()
  if (VERIFICATION_BADGES[value]) return value
  if (task?.status === 'testing') return 'running'
  return 'none'
}

export function verificationBadge(task) {
  const state = verificationState(task)
  return { state, ...VERIFICATION_BADGES[state] }
}

// Strips the pass/fail marker and drops prompt text; '' means "nothing to show".
export function cleanSummary(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const marker = text.match(MARKER)
  if (marker) return marker[2].trim()
  if (BOILERPLATE.test(text)) return ''
  return text
}

// Same order as the backend's result_text: worker report, latest run report,
// session digest. Older rows only carry result_summary.
export function resultText(task) {
  const candidates = [task?.result_text, task?.result_summary, task?.latest_run_summary, task?.task_summary, task?.current_focus]
  for (const value of candidates) {
    const text = cleanSummary(value)
    if (text) return text
  }
  return ''
}

export function relativePath(path, roots = []) {
  let text = String(path ?? '').trim().replace(/\\/g, '/')
  if (!text) return ''
  const bases = [].concat(roots).filter(Boolean).map((root) => String(root).replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean)
  bases.sort((a, b) => b.length - a.length)
  for (const base of bases) {
    if (text === base) return '.'
    if (text.startsWith(`${base}/`)) { text = text.slice(base.length + 1); break }
  }
  return text.replace(/^\.\//, '')
}

export function changedFiles(task, roots = []) {
  const raw = task?.files_changed
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? parseList(raw) || [] : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    const path = relativePath(typeof item === 'string' ? item : item?.path || item?.file, roots)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(path)
    if (out.length >= FILE_LIMIT) break
  }
  return out
}

export function filesChangedCount(task, roots = []) {
  const listed = changedFiles(task, roots).length
  const reported = Number(task?.files_changed_count)
  return Number.isFinite(reported) && reported > listed ? reported : listed
}

export function filesChangedLabel(count) {
  if (!count) return 'No files recorded'
  return count === 1 ? '1 file changed' : `${count} files changed`
}

// The card's agent dot uses the session vocabulary (ive-dot states). Mirrors
// lib/sessionStatus.js without importing it, so this file stays dependency free.
const FAILED = ['auth_failed', 'error', 'failed', 'crashed']
const EXITED = ['exited', 'offline', 'stopped', 'disconnected']
const WAITING = ['prompting', 'waiting', 'input_needed', 'needs_input']
const WORKING = ['running', 'working', 'executing', 'replaying']

export function sessionDotState(task) {
  if (!task?.assigned_session_name && !task?.assigned_session_id) return null
  const status = String(task.assigned_session_status || '').toLowerCase()
  if (FAILED.includes(status)) return 'failed'
  if (task.assigned_session_alive === false || EXITED.includes(status)) return 'stopped'
  if (WAITING.includes(status)) return 'waiting'
  if (WORKING.includes(status)) return 'running'
  if (!status && task.assigned_session_alive !== true) return 'stopped'
  return 'done'
}

export function isReviewTask(task) {
  return task?.status === 'review'
}

// Cards in review and cards with a pipeline run carry a Review tab. It opens
// first only once there is something to judge (review, testing, done); a card
// still in progress opens on Details and keeps Review in second place.
const REVIEW_FIRST = ['review', 'testing', 'done']

export function hasReviewTab(task) {
  return isReviewTask(task) || !!task?.latest_run_id
}

export function reviewTabFirst(task) {
  return hasReviewTab(task) && REVIEW_FIRST.includes(task?.status)
}

// reviewed_run_id only with a passing verification: the backend answers 409
// for any other run, and every review card must be acceptable (plan C3).
export function acceptPayload(task) {
  const verified = task?.latest_run_id && verificationState(task) === 'passed'
  return verified ? { status: 'done', reviewed_run_id: task.latest_run_id } : { status: 'done' }
}

// The git endpoints answer with git's own words; a folder without a
// repository is a normal case for the Review tab, not an alert.
export function changesErrorText(message) {
  const text = String(message || '')
  if (/not a git repo/i.test(text)) return 'This folder is not a git repository, so no diff is available.'
  return text || 'Changes could not be loaded.'
}

// POST /api/tasks/{id}/iterate. `note` is the lane contract; revision_notes
// keeps older backends writing the same text into the task timeline.
export function sendBackPayload(note) {
  const text = String(note ?? '').trim()
  return { note: text, revision_notes: text }
}

export function autoTestEnabled(workspace) {
  const value = workspace?.auto_test_enabled
  return value === true || value === 1 || value === '1'
}

export function reviewSessionId(task) {
  return task?.assigned_session_id || task?.last_agent_session_id || null
}

export function branchLine(task) {
  const parts = []
  if (task?.branch_label) parts.push(task.branch_label)
  if (task?.worktree_path) parts.push(`worktree ${task.worktree_path}`)
  return parts.join(' · ')
}
