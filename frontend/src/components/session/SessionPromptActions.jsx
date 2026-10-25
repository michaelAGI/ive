import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { MessageCircle, Loader2, ArrowUp } from 'lucide-react'
import useStore from '../../state/store'
import useSessionPromptReply from '../../hooks/useSessionPromptReply'
import PromptMenu from './PromptMenu'
import { opensTerminal, optionForKey } from '../../lib/promptMenu'

// The current terminal dialog, answered in place: a card above the chat
// composer (variant 'card' | 'tile') or a band above a terminal tile
// (variant 'band'). The imperative handle lets the composer route Enter and
// y/n/1-9 shortcuts through the same guarded reply.
const QUIET_AFTER_SEND_MS = 10000

export default function SessionPromptActions({ ref, sessionId, active, disabled = false, variant = 'card', hint = '' }) {
  const fieldId = useId()
  const rootRef = useRef(null)
  const [reply, setReply] = useState('')
  const [slowRequest, setSlowRequest] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const { snapshot: current, menu, viewState, loading, error, sending, answered, answeredChoice, justSent, sentAt, unavailable: hookUnavailable, refresh, reply: send, clearError } = useSessionPromptReply(sessionId, { active })
  const band = variant === 'band'
  const showMenu = !!menu && !(answered && !justSent)
  const needsTerminal = !menu && ((!!viewState && viewState !== 'ready') || !!current?.incomplete)
  const waiting = active && !menu && !answered && (!current?.screen?.trim() || current?.incomplete)
  useEffect(() => {
    setSlowRequest(false)
    if (!waiting || band) return undefined
    const timer = setTimeout(() => setSlowRequest(true), 8000)
    return () => clearTimeout(timer)
  }, [waiting, band, sessionId])
  // After an answer the screen moves on; no manual form while the agent takes over.
  useEffect(() => {
    if (!sentAt) { setQuiet(false); return undefined }
    setQuiet(true)
    const timer = setTimeout(() => setQuiet(false), QUIET_AFTER_SEND_MS)
    return () => clearTimeout(timer)
  }, [sentAt])
  const bandVisible = band && active && (showMenu || needsTerminal)
  useEffect(() => {
    if (!band) return undefined
    window.dispatchEvent(new Event('cc-terminal-refit'))
    return () => window.dispatchEvent(new Event('cc-terminal-refit'))
  }, [band, bandVisible])
  const openTerminal = () => {
    const store = useStore.getState()
    store.goSession(sessionId)
    store.toggleTerminalDrawer(sessionId, true)
  }
  useImperativeHandle(ref, () => ({
    get menu() { return showMenu && active ? menu : null },
    // The last answer is still on its way (or loading): a shortcut typed now is not lost silently.
    get busy() { return sending || loading || answered },
    focus() {
      const el = rootRef.current?.querySelector('[data-prompt-menu-focus]')
      el?.scrollIntoView?.({ block: 'nearest' })
      el?.focus()
      return !!el
    },
    // "Type something." / "Chat about this" from the composer: the terminal, nothing sent.
    reply: (value) => (opensTerminal(optionForKey(menu, value), menu) ? (openTerminal(), Promise.resolve(true)) : send(value)),
  }), [showMenu, active, menu, send, sending, loading, answered])
  if (!active) return null
  const unavailable = disabled || hookUnavailable
  const retry = () => { clearError(); refresh() }

  if (band) {
    if (showMenu) return (
      <section ref={rootRef} data-session-prompt-actions data-prompt-band data-prompt-menu={sessionId} className="ive-prompt-band" aria-label="Question from the agent" aria-busy={sending}>
        <PromptMenu sessionId={sessionId} menu={menu} variant="compact" onReply={(value) => send(value)} sending={sending} error={error} answered={answered} answeredChoice={answeredChoice} justSent={justSent} disabled={disabled} onOpenTerminal={openTerminal} />
      </section>
    )
    if (needsTerminal) return (
      <section ref={rootRef} data-session-prompt-actions data-prompt-band data-prompt-menu={sessionId} className="ive-prompt-band is-plain" aria-label="Question from the agent">
        <button type="button" data-prompt-menu-focus="" className="ive-chat-text-button" onClick={openTerminal}>Open terminal to review</button>
      </section>
    )
    return null
  }

  if (waiting) return (
    <section ref={rootRef} data-session-prompt-actions data-request-loading className="ive-chat-request-loading" aria-busy={!error && !slowRequest}>
      <div role="status" className="ive-chat-reply-status">
        {!error && !slowRequest && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        <span>{error ? 'Couldn’t load the request.' : slowRequest ? 'The request is taking longer than expected.' : 'Loading request…'}</span>
        {(error || slowRequest) && <button type="button" onClick={retry} className="ive-chat-text-button">Retry</button>}
      </div>
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(error || slowRequest) && current?.screen && <details className="ive-chat-request-details">
        <summary>Request details</summary>
        <pre>{current.screen}</pre>
        <button type="button" onClick={openTerminal} className="ive-chat-text-button">Open terminal to review</button>
      </details>}
    </section>
  )

  if (showMenu) return (
    <section ref={rootRef} data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className={`ive-chat-question is-prompt-menu${variant === 'tile' ? ' is-tile' : ''}`} aria-busy={loading || sending}>
      <div className="ive-chat-question-heading">
        <MessageCircle size={17} aria-hidden="true" />
        <h3 id={`${fieldId}-title`}>Your answer is needed</h3>
      </div>
      <PromptMenu sessionId={sessionId} menu={menu} variant={variant} onReply={(value) => send(value)} sending={sending} error={error} answered={answered} answeredChoice={answeredChoice} justSent={justSent} disabled={disabled} onOpenTerminal={openTerminal} hint={hint} />
    </section>
  )

  // The heading stays put; the status line carries "Sent, continuing…".
  if (answered && justSent) return (
    <section ref={rootRef} data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className={`ive-chat-question${variant === 'tile' ? ' is-tile' : ''}`}>
      <div className="ive-chat-question-heading"><MessageCircle size={17} aria-hidden="true" /><h3 id={`${fieldId}-title`}>Your answer is needed</h3></div>
      <p role="status" className="ive-chat-reply-status">Sent, continuing…</p>
    </section>
  )
  if (!current?.screen || answered || quiet) return null
  // An unrecognised question: the exact screen plus one explicit, guarded line of text.
  const question = current.screen.split('\n').map((line) => line.trim()).filter((line) => /[?？]$/.test(line)).at(-1)
  const sendReply = async (event) => {
    event.preventDefault()
    if (unavailable) return
    if (await send(reply, { manual: true })) setReply('')
  }
  return (
    <section ref={rootRef} data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className={`ive-chat-question${variant === 'tile' ? ' is-tile' : ''}`} aria-busy={loading || sending}>
      <div className="ive-chat-question-heading">
        <MessageCircle size={17} aria-hidden="true" />
        <h3 id={`${fieldId}-title`}>Your answer is needed</h3>
      </div>
      <p>{question || 'The assistant is waiting for your reply. Review the request details below.'}</p>
      <details className="ive-chat-request-details">
        <summary>View request details</summary>
        <pre>{current.screen}</pre>
        <button type="button" onClick={openTerminal} className="ive-chat-text-button">Open terminal to review</button>
      </details>
      <form className="ive-chat-question-reply" onSubmit={sendReply}>
        <label htmlFor={`${fieldId}-reply`}>Your reply</label>
        <div>
          <input id={`${fieldId}-reply`} value={reply} placeholder="Write your answer…" maxLength={2000} onChange={(event) => setReply(event.target.value)} disabled={unavailable} />
          <button type="submit" disabled={unavailable || !reply.trim()} aria-label="Send reply"><ArrowUp size={17} /></button>
        </div>
      </form>
      {hint && <p role="alert" className="ive-chat-question-error">{hint}</p>}
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(sending || justSent) && <p role="status" className="ive-chat-reply-status">{sending && <Loader2 size={14} className="animate-spin" />}{sending ? 'Sending…' : 'Sent, continuing…'}</p>}
    </section>
  )
}
