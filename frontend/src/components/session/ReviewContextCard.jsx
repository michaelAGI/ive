import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircle, RefreshCw, Square } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { reviewExplanationApi } from '../../lib/reviewExplanationApi'
import { uuid } from '../../lib/uuid'
import { EXPLANATION_QUESTIONS, explanationProviderFields, reviewContextSummary, reviewTarget } from '../../lib/reviewContext'
import './review-context.css'

const providerName = (value) => value === 'codex' ? 'Codex' : 'Claude'

export default function ReviewContextCard({ session, workspace, scope, selectedFile, diffText, provider, onProviderChange, onRefresh }) {
  const target = reviewTarget(session, scope, selectedFile)
  const targetKey = JSON.stringify(target)
  const [context, setContext] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [stale, setStale] = useState(false)
  const activeRequest = useRef(null)
  const generation = useRef(0)
  const timer = useRef(null)
  const cardRef = useRef(null)
  const summary = reviewContextSummary(context, { session, workspace, scope, selectedFile })
  useEffect(() => {
    if (!messages.length) return undefined
    const frame = requestAnimationFrame(() => {
      const card = cardRef.current
      if (card) card.scrollTop = card.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [messages.length, pending])
  const stop = () => {
    generation.current += 1
    clearTimeout(timer.current)
    const id = activeRequest.current
    activeRequest.current = null
    if (id) reviewExplanationApi.cancel(id).catch(() => {})
    setPending(false)
    setError('')
  }
  const refreshContext = async () => {
    stop()
    const run = generation.current
    setLoading(true)
    setStale(true)
    try {
      // The visible diff and explanation must refer to the same refresh.
      // Fetch the visible material first, then capture its server revision.
      await onRefresh?.()
      if (run === generation.current) setRefresh((value) => value + 1)
    } catch (cause) {
      if (run !== generation.current) return
      setLoading(false)
      setError(cause.message || 'Could not refresh these changes.')
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    stop()
    setContext(null)
    setMessages([])
    setDraft('')
    setStale(false)
    setError('')
    if (!target) return undefined
    setLoading(true)
    reviewExplanationApi.context(JSON.parse(targetKey), controller.signal).then((value) => {
      if (!controller.signal.aborted) setContext(value)
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message || 'Could not load the review context.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => {
      controller.abort()
      generation.current += 1
      clearTimeout(timer.current)
      if (activeRequest.current) reviewExplanationApi.cancel(activeRequest.current).catch(() => {})
      activeRequest.current = null
    }
  }, [targetKey, refresh])

  // A changed visible diff invalidates an explanation snapshot. The server
  // checks its own revision again before answering; this hint is immediate.
  const previousDiff = useRef(diffText)
  useEffect(() => {
    if (previousDiff.current && previousDiff.current !== diffText && context) setStale(true)
    previousDiff.current = diffText
  }, [diffText, context])

  const ask = async (kind, question = EXPLANATION_QUESTIONS[kind]) => {
    if (!context?.revision || loading || pending || activeRequest.current || !question?.trim() || stale) return
    const requestId = uuid()
    const run = ++generation.current
    const next = [...messages, { role: 'user', content: question.trim() }]
    activeRequest.current = requestId
    setMessages(next)
    setDraft('')
    setPending(true)
    setError('')
    const payload = {
      ...target, ...explanationProviderFields(session, provider),
      revision: context.revision, request_id: requestId,
      question_kind: kind, messages: next.map(({ role, content }) => ({ role, content })),
    }
    const consume = (job) => {
      if (run !== generation.current) return
      if (job.status === 'running' || job.status === 'pending' || job.status === 'queued') {
        timer.current = setTimeout(poll, 900)
        return
      }
      activeRequest.current = null
      setPending(false)
      setStale(Boolean(job.stale))
      if (job.status === 'completed') {
        setMessages((items) => [...items, { role: 'assistant', content: job.answer || 'No explanation returned.', provider: job.cli_type || provider }])
      } else setError(job.status === 'cancelled' ? 'Explanation stopped.' : job.error || 'Could not explain these changes.')
    }
    const fail = (cause) => {
      if (run !== generation.current) return
      // Keep the request id for Stop/unmount if a network failure left the
      // answer running on the server; never resubmit automatically.
      setPending(false)
      setError(cause.message || 'Connection interrupted. Refresh the context to try again.')
      if (cause.status === 409) setStale(true)
    }
    const poll = () => reviewExplanationApi.get(requestId).then(consume).catch(fail)
    try { consume(await reviewExplanationApi.ask(payload)) } catch (cause) { fail(cause) }
  }

  return (
    <section ref={cardRef} className="ive-review-context" aria-label="What this review is for" data-review-context>
      <div className="ive-review-context-heading">
        <h3>Review changes</h3>
        <button type="button" aria-label="Refresh review context" title="Refresh context and changes" disabled={loading} onClick={refreshContext}><RefreshCw size={13} /></button>
      </div>
      <p className="ive-review-target"><strong>{summary.project}</strong><span> · {summary.session}</span></p>
      <p className="ive-review-scope">{summary.scope}{summary.file ? ` · ${summary.file}` : context?.files ? ` · ${context.files.length} ${context.files.length === 1 ? 'file' : 'files'}` : ''}</p>
      {context && <>
        {summary.task && <p><strong>Task:</strong> {summary.task}</p>}
        <p><strong>Why:</strong> {summary.reason}</p>
        {summary.original && <details><summary>Original request</summary><p className="ive-review-original">{summary.original}</p></details>}
      </>}
      <p className="ive-review-scope-note">{summary.warning}</p>
      <p className="ive-review-scope-note">These edits already exist in the project. Reviewing them does not apply or undo them.</p>
      {(context?.truncated || context?.original_prompt?.truncated) && <p className="ive-review-scope-note">The explanation uses a shortened snapshot. Inspect the full changes below before making a decision.</p>}
      {loading && <p role="status"><Loader2 size={12} className="animate-spin" /> Loading context…</p>}
      <div className="ive-review-explain-controls">
        <label>Explain with <select aria-label="Explanation provider" value={provider} disabled={pending} onChange={(event) => onProviderChange(event.target.value)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
        <div>
          <button type="button" onClick={() => ask('purpose')} disabled={!context?.revision || loading || pending || !!activeRequest.current || stale}><MessageCircle size={12} /> Explain this</button>
          <button type="button" onClick={() => ask('separate_agent')} disabled={!context?.revision || loading || pending || !!activeRequest.current || stale}>Why another agent?</button>
        </div>
      </div>
      {stale && <p className="ive-review-scope-note" role="status">The changes have moved on. Refresh the context before asking again.</p>}
      {(messages.length > 0 || pending) && <div className="ive-review-explanation" aria-label="Review explanation">
        <p className="ive-review-scope-note">This conversation explains the selected changes. It does not start a review or change a schedule.</p>
        {messages.map((message, index) => <div key={index} className={`ive-review-explanation-message is-${message.role}`}><strong>{message.role === 'user' ? 'You' : providerName(message.provider)}</strong><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>)}
        {pending && <p role="status"><Loader2 size={12} className="animate-spin" /> {providerName(provider)} is explaining… <button type="button" onClick={stop}><Square size={11} /> Stop</button></p>}
        {!pending && activeRequest.current && <button type="button" onClick={stop}><Square size={11} /> Stop pending request</button>}
        <form onSubmit={(event) => { event.preventDefault(); ask('purpose', draft) }}><input aria-label="Follow-up about this review" placeholder="Ask about these changes…" value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" disabled={loading || pending || !!activeRequest.current || stale || !draft.trim()}>Ask</button></form>
      </div>}
      {error && <p role="alert" className="ive-review-error">{error}</p>}
    </section>
  )
}
