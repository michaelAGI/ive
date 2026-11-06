import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronRight, Circle, GripVertical, Link, Play } from 'lucide-react'
import { taskLabels } from '../../lib/boardColumns'
import {
  changedFiles, filesChangedCount, filesChangedLabel, originChip, resultText,
  reviewSessionId, sessionDotState, verificationBadge,
} from '../../lib/taskReview'
import { Button } from '../ui'
import StatusDot from '../ui/StatusDot'

// Verification badge tones: the only colour on a card besides the focus ring.
const BADGE_CLASS = {
  passed: 'text-x-good border-x-good/30 bg-x-good/10',
  failed: 'text-x-danger border-x-danger/30 bg-x-danger/10',
  running: 'text-x-accent border-x-accent/30 bg-x-accent/10',
  none: 'text-x-muted border-x-line bg-x-surface-2',
}

function TitleEditor({ value, onChange, onCommit, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      data-testid="board-inline-title"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          onCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      aria-label="Edit card title"
      className="min-w-0 flex-1 h-8 px-2 text-[12px] font-semibold bg-x-surface border border-x-accent rounded-lg text-x-ink focus:outline-none focus:ring-[3px] focus:ring-x-focus"
    />
  )
}

// The inline "Send back" note. Escape closes the note (FeatureBoard leaves
// Escape alone inside [data-card-note]); ⌘Enter sends.
function SendBackNote({ busy, onSend, onCancel }) {
  const [note, setNote] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  const send = () => { if (note.trim() && !busy) onSend(note.trim()) }
  return (
    <form
      data-card-note
      data-testid="card-send-back"
      className="pl-9 space-y-1.5"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => { event.preventDefault(); send() }}
    >
      <label className="block text-[11px] font-medium text-x-ink-secondary">
        What should change?
        <textarea
          ref={ref}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Name the missing piece or the bug. The next worker reads this first."
          aria-label="What should change?"
          className="mt-1 w-full px-2 py-1.5 text-[11px] font-normal bg-x-surface border border-x-line rounded-lg text-x-ink-secondary placeholder:text-x-faint focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus resize-none"
        />
      </label>
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" shape="pill" variant="primary" disabled={!note.trim() || busy}>Send back</Button>
        <Button type="button" size="sm" shape="pill" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

export default function TaskCard({
  task,
  onDragStart,
  onClick,
  onStart,
  isFocused,
  workspaceName,
  workspacePath,
  relState,
  onMouseEnter,
  onMouseLeave,
  isEditing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  attentionReasons = [],
  onAccept,
  onSendBack,
  onOpenSession,
  onShowChanges,
  sessionAvailable = true,
  busy = false,
  checking = false,
}) {
  const labels = taskLabels(task).filter((label) => !label.startsWith('parked:'))
  const hasDeps = (() => {
    const raw = task.depends_on
    if (!raw || raw === '[]') return false
    if (Array.isArray(raw)) return raw.length > 0
    try { return JSON.parse(raw).length > 0 } catch { return false }
  })()
  const done = task.status === 'done'
  const review = task.status === 'review'
  const active = ['in_progress', 'testing', 'documenting'].includes(task.status)
  const origin = originChip(task)
  const agentName = task.assigned_session_name || null
  const dot = sessionDotState(task)
  const summary = resultText(task)
  const roots = [workspacePath, task.worktree_path]
  const files = changedFiles(task, roots)
  const fileCount = filesChangedCount(task, roots)
  const badge = verificationBadge(task)
  const showEvidence = review || fileCount > 0 || !!task.verification
  const footerStatus = review ? null : (task.status?.replaceAll('_', ' ') || 'backlog')
  const sessionId = reviewSessionId(task)
  const [noteOpen, setNoteOpen] = useState(false)
  const sendBackRef = useRef(null)
  const stop = (event) => event.stopPropagation()
  // Cancelling the note hands focus back to "Send back", so the next Escape
  // does not fall through to the board.
  const closeNote = () => { setNoteOpen(false); requestAnimationFrame(() => sendBackRef.current?.focus()) }

  useEffect(() => { if (!review) setNoteOpen(false) }, [review])

  let stateClasses = 'border-x-line bg-x-surface'
  if (isFocused) stateClasses = 'border-x-accent bg-x-tint ring-2 ring-x-focus'
  else if (relState === 'hovered') stateClasses = 'border-x-line-strong bg-x-hover'
  else if (relState === 'blocker' || relState === 'dependent') stateClasses = 'border-x-line-strong bg-x-surface-2'
  else if (relState === 'unrelated') stateClasses = 'border-x-line opacity-35'

  return (
    <article
      data-task-id={task.id}
      data-task-status={task.status}
      data-focused={isFocused ? 'true' : 'false'}
      draggable={!isEditing && !noteOpen}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart?.(event, task)
      }}
      onClick={() => { if (!isEditing) onClick?.(task) }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-current={isFocused ? 'true' : undefined}
      className={`x-task-card group relative flex flex-col gap-2 p-3 border cursor-pointer transition-colors duration-[80ms] ease-x hover:border-x-line-strong ${stateClasses}`}
    >
      <GripVertical
        size={10}
        className="absolute top-3 right-3 text-x-faint opacity-0 group-hover:opacity-100 transition-opacity duration-[80ms]"
      />

      <div className="flex items-start gap-2 pr-4">
        <span className="x-row-icon" aria-hidden="true">
          {done ? (
            <CheckCircle2 size={12} className="text-x-good" />
          ) : (
            <Circle size={7} className={`fill-current ${isFocused ? 'text-x-accent' : 'text-x-muted'} ${active ? 'animate-subtle-pulse' : ''}`} />
          )}
        </span>
        {isEditing ? (
          <TitleEditor
            value={editValue}
            onChange={onEditChange}
            onCommit={onEditCommit}
            onCancel={onEditCancel}
          />
        ) : (
          <span className="x-card-title min-w-0 flex-1 text-[12px] font-semibold text-x-ink leading-snug line-clamp-2">
            {task.title}
          </span>
        )}
      </div>

      {(origin || agentName) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-9 text-[11px]" data-testid="card-origin">
          {origin && (
            <span data-origin={origin.origin} className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded-full border border-x-line bg-x-surface-2 text-[10px] font-medium text-x-ink-secondary">
              {origin.label}
            </span>
          )}
          {agentName && (
            <span className="inline-flex items-center gap-1.5 min-w-0 text-x-muted" title={`${agentName}${task.assigned_session_status ? ` · ${task.assigned_session_status}` : ''}`} data-testid="card-agent">
              {dot && <StatusDot state={dot} />}
              <span className="truncate max-w-[150px]">{agentName}</span>
            </span>
          )}
        </div>
      )}

      {summary && (
        <p className="pl-9 text-[11px] leading-snug text-x-ink-secondary line-clamp-2" data-testid="card-result" title={summary}>
          {summary}
        </p>
      )}

      {showEvidence && (
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1 pl-9 text-[11px]" data-testid="card-evidence">
          {fileCount > 0 ? (
            <details className="x-card-files min-w-0 flex-1" onClick={stop} data-testid="card-files">
              <summary className="inline-flex items-center gap-1 cursor-pointer list-none text-x-ink-secondary hover:text-x-ink">
                <ChevronRight size={10} className="x-card-chevron shrink-0" aria-hidden="true" />
                {filesChangedLabel(fileCount)}
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-x-muted">
                {files.map((file) => <li key={file} className="truncate" title={file}>{file}</li>)}
                {fileCount > files.length && <li className="text-x-muted">and {fileCount - files.length} more</li>}
              </ul>
            </details>
          ) : (
            <span className="flex-1 text-x-muted">{filesChangedLabel(0)}</span>
          )}
          <span
            data-verification={badge.state}
            className={`inline-flex items-center shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${BADGE_CLASS[badge.state]}`}
          >
            {badge.label}
          </span>
        </div>
      )}

      {checking && (
        <p className="pl-9 text-[11px] text-x-accent-ink" role="status" data-testid="card-checking">Test agent checking…</p>
      )}

      {attentionReasons.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-9" data-testid="attention-reasons">
          {attentionReasons.map((reason) => (
            <span key={reason} className="px-1.5 py-0.5 text-[10px] font-mono text-x-muted bg-x-surface-2 border border-x-line rounded-full">
              {reason}
            </span>
          ))}
        </div>
      )}

      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-9">
          {labels.slice(0, 4).map((label) => (
            <span key={label} className="px-1.5 py-0.5 text-[10px] font-mono text-x-muted bg-x-surface-2 border border-x-line rounded-full">
              {label}
            </span>
          ))}
        </div>
      )}

      {review && !noteOpen && (
        <div className="flex flex-col gap-1 pl-9" data-testid="card-actions" onClick={stop}>
          <div className="flex items-center gap-1.5">
            <Button size="sm" shape="pill" variant="primary" disabled={busy} onClick={() => onAccept?.(task)}>Accept</Button>
            <Button ref={sendBackRef} size="sm" shape="pill" disabled={busy} aria-expanded={noteOpen} onClick={() => setNoteOpen(true)}>Send back</Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-[11px]">
            {sessionId && sessionAvailable && <button type="button" className="x-card-link" onClick={() => onOpenSession?.(task)}>Open session</button>}
            {sessionId && !sessionAvailable && <span className="x-card-link-muted" data-testid="card-session-gone">Session no longer exists</span>}
            <button type="button" className="x-card-link" onClick={() => onShowChanges?.(task)}>Show changes</button>
          </div>
        </div>
      )}
      {review && noteOpen && (
        <SendBackNote busy={busy} onSend={(note) => { setNoteOpen(false); onSendBack?.(task, note) }} onCancel={closeNote} />
      )}

      <div className="flex items-center gap-1.5 mt-0.5 pt-2 border-t border-x-line text-[10px] font-mono text-x-muted">
        {footerStatus && <span>{footerStatus}</span>}
        {workspaceName && <span className="truncate max-w-[84px]">{footerStatus ? '· ' : ''}{workspaceName}</span>}
        {task.branch_label && <span className="truncate max-w-[110px]" title={task.branch_label}>{footerStatus || workspaceName ? '· ' : ''}{task.branch_label}</span>}
        <span className="flex-1" />
        {onStart && !done && !review && (
          <button
            onClick={(event) => { event.stopPropagation(); onStart(task) }}
            title="Route to a worker"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-x-accent text-x-on-accent opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-[80ms]"
          >
            <Play size={8} className="fill-current" /> route
          </button>
        )}
        {hasDeps && <Link size={9} title="Has dependencies" />}
        {task.queued_for_session_id && <span>queued</span>}
      </div>
    </article>
  )
}
