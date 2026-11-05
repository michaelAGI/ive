import { useEffect, useId, useRef, useState } from 'react'
import { ShieldAlert, Loader2, RefreshCw, ArrowUp } from 'lucide-react'
import useSessionPromptReply from '../../hooks/useSessionPromptReply'
import useStore from '../../state/store'
import { permissionPresentation } from '../../lib/conversationPresentation'

const isEditable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

/** The agent's native permission dialog as a card in the conversation.
 *  Same choices as the terminal (1 / 2 / 3), answered against the exact
 *  screen the terminal shows; the digits work here too. */
export default function SessionPromptActions({ sessionId, active, disabled = false, onOpenTerminal, keyboard = false }) {
  const fieldId = useId()
  const [reply, setReply] = useState('')
  const [slowRequest, setSlowRequest] = useState(false)
  const cliType = useStore((s) => s.sessions[sessionId]?.cli_type || 'claude')
  const isActiveSession = useStore((s) => s.activeSessionId === sessionId)
  const { snapshot: current, loading, error, sending, answered, unavailable: hookUnavailable, refresh, reply: send, clearError } = useSessionPromptReply(sessionId, { active })
  const waiting = active && !answered && (!current?.screen?.trim() || current?.incomplete)
  useEffect(() => {
    setSlowRequest(false)
    if (!waiting) return undefined
    const timer = setTimeout(() => setSlowRequest(true), 8000)
    return () => clearTimeout(timer)
  }, [waiting, sessionId])
  const unavailable = disabled || hookUnavailable
  const agent = cliType === 'codex' ? 'Codex' : cliType === 'gemini' ? 'Gemini' : cliType === 'antigravity' ? 'Antigravity' : 'Claude'
  const presentation = current?.prompt ? permissionPresentation(current.prompt, agent) : null
  const sendReply = async (value, manual = false) => {
    if (unavailable) return
    if (await send(value, { manual })) setReply('')
  }
  const sendReplyRef = useRef(sendReply)
  sendReplyRef.current = sendReply
  // 1 / 2 / 3 answer the request like in the terminal: only in the full view
  // of the session the user is looking at (Board tiles mount several cards),
  // never while typing, and never while a dialog, menu or palette is open.
  const choicesKey = presentation && !answered ? presentation.choices.map((c) => c.value).join('') : ''
  useEffect(() => {
    if (!keyboard || !active || !isActiveSession || !choicesKey || unavailable) return undefined
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      if (!choicesKey.includes(event.key) || isEditable(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [data-ive-popover], [data-command-palette]')) return
      event.preventDefault()
      sendReplyRef.current(event.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, active, isActiveSession, choicesKey, unavailable])
  if (!active) return null
  const retry = () => { clearError(); refresh() }
  if (waiting) return (
    <section data-session-prompt-actions data-request-loading className="ive-chat-request-loading" aria-busy={!error && !slowRequest}>
      <div role="status" className="ive-chat-reply-status">
        {!error && !slowRequest && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        <span>{error ? 'Couldn’t load the request.' : slowRequest ? 'The request is taking longer than expected.' : 'Loading request…'}</span>
        {(error || slowRequest) && <button type="button" onClick={retry} className="ive-chat-text-button">Retry</button>}
      </div>
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(error || slowRequest) && current?.screen && <details className="ive-chat-request-details">
        <summary>Request details</summary>
        <pre>{current.screen}</pre>
        {onOpenTerminal && <button type="button" onClick={onOpenTerminal} className="ive-chat-text-button">Open terminal to review</button>}
      </details>}
    </section>
  )
  const question = current?.screen?.split('\n').map((line) => line.trim()).filter((line) => /[?？]$/.test(line)).at(-1)
  const title = answered ? 'Reply sent' : presentation?.title || 'Your answer is needed'
  const detailLines = presentation?.detail ? presentation.detail.split('\n').length : 0

  return (
    <section data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className="ive-chat-question" data-answered={answered ? '' : undefined} aria-busy={loading || sending}>
      <div className="ive-chat-question-heading">
        <ShieldAlert size={18} aria-hidden="true" />
        <div className="ive-chat-question-titles">
          <h3 id={`${fieldId}-title`}>{title}</h3>
          {presentation && !answered && <p className="ive-chat-question-summary">{presentation.summary}</p>}
        </div>
        <button type="button" onClick={retry} disabled={sending} aria-label="Refresh current request" title="Refresh current request" className="ive-chat-icon-button"><RefreshCw size={15} /></button>
      </div>
      {presentation && !answered && (
        <div className="ive-chat-question-request">
          <p className="ive-chat-question-description">{presentation.description}</p>
          {presentation.detailLines.length > 0 && <pre className="ive-chat-question-detail" data-long={detailLines > 14 ? '' : undefined}>{presentation.detailLines.map((line, index) => <span key={index}>{line}</span>)}</pre>}
        </div>
      )}
      {presentation && !answered && presentation.notice && <p className="ive-chat-question-notice">{presentation.notice}</p>}
      {current?.screen && !current.prompt && !current.incomplete && !answered && <p>{question || 'The assistant is waiting for your reply. Review the request details below.'}</p>}
      {presentation && !answered && <div className="ive-chat-question-choices">
        {presentation.choices.map((choice) => <button key={choice.value} type="button" data-choice-kind={choice.kind} onClick={() => sendReply(choice.value)} disabled={unavailable}>
          {choice.label}
          <kbd aria-hidden="true" title={keyboard ? "Keyboard shortcut outside text fields" : "Choice number"}>{choice.value}</kbd>
        </button>)}
      </div>}
      {current?.screen && !answered && <details className="ive-chat-request-details">
        <summary>{presentation ? 'View exact request' : 'View request details'}</summary>
        <pre>{current.prompt?.excerpt || current.screen}</pre>
      </details>}
      {current?.screen && !current.prompt && !current.incomplete && !answered && <form className="ive-chat-question-reply" onSubmit={(event) => { event.preventDefault(); sendReply(reply, true) }}>
        <label htmlFor={`${fieldId}-reply`}>Your reply</label>
        <div>
          <input id={`${fieldId}-reply`} value={reply} placeholder="Write your answer…" maxLength={2000} onChange={(event) => setReply(event.target.value)} disabled={unavailable} />
          <button type="submit" disabled={unavailable || !reply.trim()} aria-label="Send reply"><ArrowUp size={17} /></button>
        </div>
      </form>}
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(sending || answered) && <p role="status" className="ive-chat-reply-status">{sending && <Loader2 size={14} className="animate-spin" />}{sending ? 'Sending…' : `${agent} can continue now.`}</p>}
    </section>
  )
}
