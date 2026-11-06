import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { MessageCircle, ShieldAlert, Loader2, RefreshCw } from 'lucide-react'
import useStore from '../../state/store'
import useSessionPromptReply from '../../hooks/useSessionPromptReply'
import PromptMenu from './PromptMenu'
import { opensTerminal, optionForKey, questionFirst } from '../../lib/promptMenu'
import { excerptWithRules, permissionPresentation } from '../../lib/conversationPresentation'

const isEditable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

// The current terminal dialog, answered in place. A permission request in the
// full session view (variant 'card') is drawn like a chat app draws it: who
// wants what, the exact command or file, then the same 1 / 2 / 3 choices as
// the terminal. Plan approvals, AskUserQuestion menus, Codex dialogs, Board
// tiles (variant 'tile') and the band above a terminal tile (variant 'band')
// show the dialog 1:1 (PromptMenu).
// Every reply goes through the guarded endpoint against the exact dialog on
// screen. The imperative handle lets the composer route Enter and y/n/1-9
// shortcuts through the same reply.
export default function SessionPromptActions({ ref, sessionId, active, disabled = false, variant = 'card', hint = '', keyboard = false }) {
  const fieldId = useId()
  const rootRef = useRef(null)
  const [slowRequest, setSlowRequest] = useState(false)
  const cliType = useStore((s) => s.sessions[sessionId]?.cli_type || 'claude')
  const isActiveSession = useStore((s) => s.activeSessionId === sessionId)
  const attention = useStore((s) => s.sessions[sessionId]?.attention)
  const expectsDialog = attention?.kind === 'permission' || attention?.kind === 'configuration'
    || !!attention?.menu || !!attention?.options?.length
  const { snapshot: current, menu, viewState, loading, error, sending, answered, answeredChoice, justSent, unavailable: hookUnavailable, refresh, reply: send, clearError } = useSessionPromptReply(sessionId, { active })
  const band = variant === 'band'
  const showMenu = !!menu && !(answered && !justSent)
  const needsTerminal = !menu && ((!!viewState && viewState !== 'ready') || !!current?.incomplete)
  const waiting = active && !menu && !answered && (current?.incomplete || (expectsDialog && !current?.screen?.trim()))
  const unavailable = disabled || hookUnavailable
  const agent = cliType === 'codex' ? 'Codex' : cliType === 'gemini' ? 'Gemini' : cliType === 'antigravity' ? 'Antigravity' : 'Claude'
  // A Claude Code permission dialog in the full session view is the card;
  // everything else (plans, questions, Codex's question-first dialogs, Board
  // tiles and terminal bands) shows the dialog 1:1.
  const asCard = variant === 'card' && !!menu && menu.kind === 'permission' && menu.answerable !== false && !questionFirst(menu)
  const presentation = asCard
    ? permissionPresentation({ excerpt: excerptWithRules(menu.excerpt, current?.screen), choices: menu.options.map((option) => ({ value: option.key, label: option.label })) }, agent)
    : null
  useEffect(() => {
    setSlowRequest(false)
    if (!waiting || band) return undefined
    const timer = setTimeout(() => setSlowRequest(true), 8000)
    return () => clearTimeout(timer)
  }, [waiting, band, sessionId])
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
  const sendChoice = async (value) => {
    if (unavailable) return false
    return send(value)
  }
  const sendChoiceRef = useRef(sendChoice)
  sendChoiceRef.current = sendChoice
  // 1 / 2 / 3 answer the card like in the terminal: only in the full view of
  // the session the user is looking at (Board tiles mount several cards),
  // never while typing, and never while a dialog, menu or palette is open.
  const choicesKey = presentation && !answered ? presentation.choices.map((c) => c.value).join('') : ''
  useEffect(() => {
    if (!keyboard || !active || !isActiveSession || !choicesKey || unavailable) return undefined
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      if (!choicesKey.includes(event.key)) return
      const el = document.activeElement
      if (isEditable(el)) {
        // Like the terminal: with nothing typed yet, a digit answers the
        // request even though this session's message box has the cursor.
        const ownEmptyComposer = el.tagName === 'TEXTAREA' && !el.value.trim()
          && el.closest(`[data-session-view="${sessionId}"] form.x-composer`)
        if (!ownEmptyComposer) return
      }
      if (document.querySelector('[role="dialog"], [data-ive-popover], [data-command-palette]')) return
      event.preventDefault()
      sendChoiceRef.current(event.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, active, isActiveSession, choicesKey, unavailable, sessionId])
  if (!active) return null
  const retry = () => { clearError(); refresh() }
  const tile = variant === 'tile' ? ' is-tile' : ''

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

  // Permission card: "Claude wants to run a command", the exact request, the terminal's choices.
  if (showMenu && presentation) {
    const title = answered ? 'Reply sent' : presentation.title
    const detailLines = presentation.detailLines.length
    return (
      <section ref={rootRef} data-session-prompt-actions data-prompt-menu={sessionId} data-prompt-kind="permission" aria-labelledby={`${fieldId}-title`} className={`ive-chat-question${tile}`} data-answered={answered ? '' : undefined} aria-busy={loading || sending}>
        <div className="ive-chat-question-heading">
          <ShieldAlert size={18} aria-hidden="true" />
          <div className="ive-chat-question-titles">
            <h3 id={`${fieldId}-title`}>{title}</h3>
            {!answered && <p className="ive-chat-question-summary">{presentation.summary}</p>}
          </div>
          <button type="button" onClick={retry} disabled={sending} aria-label="Refresh current request" title="Refresh current request" className="ive-chat-icon-button"><RefreshCw size={15} /></button>
        </div>
        {!answered && (
          <div className="ive-chat-question-request">
            <p className="ive-chat-question-description">{presentation.description}</p>
            {detailLines > 0 && <pre className="ive-chat-question-detail" data-long={detailLines > 14 ? '' : undefined}>{presentation.detailLines.map((line, index) => <span key={index}>{line}</span>)}</pre>}
          </div>
        )}
        {!answered && presentation.notice && <p className="ive-chat-question-notice">{presentation.notice}</p>}
        {!answered && <div className="ive-chat-question-choices" data-prompt-menu-focus="" tabIndex={-1}>
          {presentation.choices.map((choice) => <button key={choice.value} type="button" data-choice-kind={choice.kind} onClick={() => sendChoice(choice.value)} disabled={unavailable}>
            {choice.label}
            <kbd aria-hidden="true" title={keyboard ? 'Keyboard shortcut outside text fields' : 'Choice number'}>{choice.value}</kbd>
          </button>)}
        </div>}
        {!answered && <details className="ive-chat-request-details">
          <summary>View exact request</summary>
          <pre>{menu.excerpt || current?.screen}</pre>
          <button type="button" onClick={openTerminal} className="ive-chat-text-button">Open terminal to review</button>
        </details>}
        {hint && <p role="alert" className="ive-chat-question-error">{hint}</p>}
        {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
        {(sending || answered) && <p role="status" className="ive-chat-reply-status">{sending && <Loader2 size={14} className="animate-spin" />}{sending ? 'Sending…' : `${agent} can continue now.`}</p>}
      </section>
    )
  }

  if (showMenu) return (
    <section ref={rootRef} data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className={`ive-chat-question is-prompt-menu${tile}`} aria-busy={loading || sending}>
      <div className="ive-chat-question-heading">
        <MessageCircle size={17} aria-hidden="true" />
        <h3 id={`${fieldId}-title`}>Your answer is needed</h3>
      </div>
      <PromptMenu sessionId={sessionId} menu={menu} variant={variant} onReply={(value) => send(value)} sending={sending} error={error} answered={answered} answeredChoice={answeredChoice} justSent={justSent} disabled={disabled} onOpenTerminal={openTerminal} hint={hint} />
    </section>
  )

  // The dialog is gone after the answer; say so for a moment.
  if (answered && justSent) return (
    <section ref={rootRef} data-session-prompt-actions aria-labelledby={`${fieldId}-title`} className={`ive-chat-question${tile}`} data-answered="">
      <div className="ive-chat-question-heading"><ShieldAlert size={18} aria-hidden="true" /><h3 id={`${fieldId}-title`}>Reply sent</h3></div>
      <p role="status" className="ive-chat-reply-status">Sent, continuing…</p>
    </section>
  )
  if (needsTerminal && !answered) return (
    <section ref={rootRef} data-session-prompt-actions className="ive-chat-request-loading">
      <button type="button" onClick={openTerminal} className="ive-chat-text-button">Open terminal to review</button>
    </section>
  )
  // Waiting is also a normal conversation state. Only a recognised CLI
  // dialog needs controls here; free-text questions use the chat composer.
  return null
}
