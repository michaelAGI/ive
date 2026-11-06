import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, FileDiff, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../../lib/api'
import { parseDiffLines } from '../../lib/diffParser'
import {
  branchLine, changedFiles, changesErrorText, cleanSummary, filesChangedCount, filesChangedLabel,
  resultText, reviewSessionId, verificationBadge,
} from '../../lib/taskReview'
import { Button } from '../ui'

// The Review tab of a card: three columns like SessionBrief (Where things
// stand · Changes & results · Checks), then the timeline from
// /api/tasks/{id}/events. Reads only; Accept, Send back and Open session live
// in the modal header, the send-back note sits below the columns.
const DIFF_LINE_LIMIT = 800
const BADGE_CLASS = {
  passed: 'text-x-good border-x-good/30 bg-x-good/10',
  failed: 'text-x-danger border-x-danger/30 bg-x-danger/10',
  running: 'text-x-accent border-x-accent/30 bg-x-accent/10',
  none: 'text-x-muted border-x-line bg-x-surface-2',
}
const QUEUE_LABEL = { queued: 'Test queued', running: 'Test agent checking', passed: 'Test agent reported pass', failed: 'Test agent reported failure', done: 'Test agent reported pass', parked: 'Test parked, needs a human' }

function eventLabel(type) {
  const text = String(type || 'event').replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function when(value) {
  if (!value) return ''
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function Markdown({ text }) {
  return <div className="ive-flow-markdown x-review-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>
}

function DiffBlock({ diff }) {
  const lines = useMemo(() => parseDiffLines(diff), [diff])
  const shown = lines.slice(0, DIFF_LINE_LIMIT)
  return (
    <pre className="x-review-diff" data-testid="review-diff">
      {shown.map((line, index) => <span key={index} className={`x-diff-${line.type}`}>{line.text}{'\n'}</span>)}
      {lines.length > shown.length && <span className="x-diff-info">… {lines.length - shown.length} more lines. Open Changes for the full diff.</span>}
    </pre>
  )
}

export default function TaskReviewTab({ task, workspace, events = [], historyLoading = false, onOpenRun, onSendBack, sendBackOpen = false, onSendBackOpenChange, busy = false, checking = false }) {
  const workspaceId = workspace?.id || task.workspace_id
  const inReview = task.status === 'review'
  const sessionId = task.worktree_path ? reviewSessionId(task) : null
  const roots = [workspace?.path, task.worktree_path]
  const files = changedFiles(task, roots)
  const fileCount = filesChangedCount(task, roots)
  const summary = resultText(task)
  const runSummary = cleanSummary(task.latest_run_summary)
  const verifySummary = cleanSummary(task.latest_run_verify_summary)
  const badge = verificationBadge(task)
  const branch = branchLine(task)
  const [changes, setChanges] = useState(null)
  const [changesError, setChangesError] = useState('')
  const [changesBusy, setChangesBusy] = useState(false)
  const [queue, setQueue] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!workspaceId) return undefined
    let disposed = false
    setChangesBusy(true)
    setChangesError('')
    Promise.allSettled([
      api.getGitDiff(workspaceId, { sessionId }),
      api.getGitDiff(workspaceId, { sessionId, staged: true }),
      api.getGitStatus(workspaceId, { sessionId }),
    ]).then(([unstaged, staged, status]) => {
      if (disposed) return
      if (unstaged.status === 'rejected' && staged.status === 'rejected') {
        setChanges(null)
        setChangesError(changesErrorText(unstaged.reason?.message))
      } else {
        setChanges({
          unstaged: unstaged.status === 'fulfilled' ? unstaged.value?.diff || '' : '',
          staged: staged.status === 'fulfilled' ? staged.value?.diff || '' : '',
          truncated: Boolean((unstaged.status === 'fulfilled' && unstaged.value?.truncated) || (staged.status === 'fulfilled' && staged.value?.truncated)),
          status: status.status === 'fulfilled' ? status.value : null,
        })
      }
      setChangesBusy(false)
    })
    return () => { disposed = true }
  }, [workspaceId, sessionId, refresh])

  useEffect(() => {
    if (!workspaceId) return undefined
    let disposed = false
    api.getTestQueue(workspaceId)
      .then((rows) => { if (!disposed) setQueue((Array.isArray(rows) ? rows : []).filter((row) => row.task_id === task.id).at(-1) || null) })
      .catch(() => { if (!disposed) setQueue(null) })
    return () => { disposed = true }
  }, [workspaceId, task.id, refresh, task.status])

  const statusFiles = useMemo(() => {
    const git = changes?.status
    if (!git) return []
    const raw = [...(git.staged || []), ...(git.unstaged || []), ...(git.untracked || []), ...(git.files || [])]
    return [...new Set(raw.map((file) => (typeof file === 'string' ? file : file?.path)).filter(Boolean))]
  }, [changes])
  const listed = files.length ? files : statusFiles
  const diff = [changes?.unstaged, changes?.staged].filter(Boolean).join('\n')
  const timeline = useMemo(() => [...events].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 40), [events])
  const sessionLabel = task.assigned_session_name || (reviewSessionId(task) ? 'the agent session' : null)

  const send = (event) => {
    event?.preventDefault?.()
    const text = note.trim()
    if (!text || busy) return
    onSendBack?.(task, text)
    setNote('')
    onSendBackOpenChange?.(false)
  }

  return (
    <div className="x-review-tab" data-testid="task-review-tab">
      <div className="ive-brief-columns x-review-columns">
        <section className="min-w-0" data-review-column="changed">
          <h3>Where things stand</h3>
          {summary ? <Markdown text={summary} /> : (
            <p className="ive-brief-muted">{sessionLabel ? `No report yet. Open ${sessionLabel} to see what the agent did.` : 'No report yet. The agent has not written one.'}</p>
          )}
          {runSummary && runSummary !== summary && (
            <details className="x-review-more">
              <summary>Agent report from the latest run</summary>
              <Markdown text={runSummary} />
            </details>
          )}
          {task.latest_run_id && onOpenRun && (
            <div className="ive-brief-actions">
              <button type="button" className="ive-brief-link" onClick={() => onOpenRun(task.latest_run_id)}>Run details <ArrowUpRight size={13} /></button>
            </div>
          )}
        </section>

        <section className="min-w-0" data-review-column="changes">
          <h3>Changes &amp; results</h3>
          <p className="ive-brief-muted">
            {filesChangedLabel(fileCount)}{branch ? ` · ${branch}` : ''}{!task.worktree_path && workspace?.path ? ' · project folder' : ''}
          </p>
          {listed.length > 0 && (
            <ul className="x-review-files" data-testid="review-files">
              {listed.map((file) => <li key={file} className="ive-brief-file" title={file}><FileDiff size={12} /><span>{file}</span></li>)}
              {fileCount > listed.length && <li className="ive-brief-muted">and {fileCount - listed.length} more</li>}
            </ul>
          )}
          {changesBusy ? <p className="ive-brief-muted">Loading diff…</p>
            : changesError ? <p role="alert" className="ive-flow-error">{changesError}</p>
              : diff ? <DiffBlock diff={diff} />
                : <p className="ive-brief-muted">No uncommitted changes in {task.worktree_path ? 'the session worktree' : 'the project folder'}. Committed work shows in the agent report.</p>}
          {changes?.truncated && <p className="ive-brief-muted">The diff is truncated. Open the session and the Changes view for everything.</p>}
          <div className="ive-brief-actions">
            <button type="button" className="ive-brief-link" onClick={() => setRefresh((n) => n + 1)} disabled={changesBusy}><RefreshCw size={12} />Refresh</button>
          </div>
        </section>

        <section className="min-w-0" data-review-column="checks">
          <h3>Checks</h3>
          <p>
            <span data-verification={badge.state} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE_CLASS[badge.state]}`}>{badge.label}</span>
          </p>
          {checking && <p className="text-x-accent-ink text-[12px]" role="status">Test agent checking…</p>}
          {verifySummary ? <Markdown text={verifySummary} /> : <p className="ive-brief-muted">{badge.state === 'running' ? 'The test agent is still working.' : inReview ? 'No verification report. Read the changes before you accept.' : 'No verification report yet.'}</p>}
          {queue && (
            <p className="ive-brief-muted" data-testid="review-test-queue">
              {QUEUE_LABEL[queue.status] || `Test queue: ${queue.status}`}{queue.result_summary ? `: ${cleanSummary(queue.result_summary)}` : ''}
            </p>
          )}
        </section>
      </div>

      {sendBackOpen && (
        <form className="x-review-sendback" data-card-note data-testid="review-send-back" onSubmit={send}>
          <label className="block text-[12px] font-medium text-x-ink-secondary">
            What should change?
            <textarea
              autoFocus
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onSendBackOpenChange?.(false) }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event)
              }}
              rows={3}
              maxLength={4000}
              placeholder="Name the missing piece or the bug. The next worker reads this first."
              aria-label="What should change?"
              className="mt-1 w-full px-3 py-2 text-[13px] font-normal bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus resize-none"
            />
          </label>
          <div className="flex items-center gap-2 mt-2">
            <Button type="submit" size="sm" variant="primary" disabled={!note.trim() || busy}>Send back</Button>
            <Button type="button" size="sm" onClick={() => onSendBackOpenChange?.(false)}>Cancel</Button>
            <span className="text-[11px] text-x-muted">The card goes back to To Do with your note. The agent session keeps running.</span>
          </div>
        </form>
      )}

      <section className="x-review-timeline" data-testid="review-timeline">
        <h3>Timeline</h3>
        {historyLoading && !timeline.length && <p className="ive-brief-muted">Loading…</p>}
        {!historyLoading && !timeline.length && <p className="ive-brief-muted">No events recorded for this card yet.</p>}
        {timeline.length > 0 && (
          <ol>
            {timeline.map((event, index) => (
              <li key={event.id ?? index}>
                <span className="x-review-event-type">{eventLabel(event.event_type)}{event.actor && <span className="x-review-event-actor"> by {event.actor}</span>}</span>
                <span className="x-review-event-time">{when(event.created_at)}</span>
                {(event.message || event.new_value) && <p>{event.message || event.new_value}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
