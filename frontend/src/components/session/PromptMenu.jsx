import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { isDigitKey, menuKey, opensTerminal, questionFirst, selectedOption } from '../../lib/promptMenu'
import { choiceTone, promptNotice } from '../../lib/conversationPresentation'

// The terminal dialog, 1:1: request excerpt, the question line, the options
// with the CLI's own words and the cursor on the highlighted one. ↑/↓ move the
// highlight here only, Enter sends it, a digit (or an option's letter) selects
// and sends in one press, Escape never sends anything. The reply itself goes
// through the guarded endpoint (useSessionPromptReply), which moves the real
// cursor against the exact dialog on screen. AskUserQuestion's free-text rows
// ("Type something.", "Chat about this") stay in the list as drawn but open
// the terminal (onOpenTerminal) instead of sending.
//   variant: 'card' (chat composer) | 'tile' (chat tile) | 'compact' (terminal tile band)
//   autoFocus: 'idle' (only when nothing else has the keyboard) | true | false
const EXCERPT_LINES = 8
const FOOT_HINT = '↵ confirm · ↑↓ or 1-9 choose'
const TERMINAL_HINT = 'Opens the terminal · ↑↓ or 1-9 choose'

export default function PromptMenu({
  sessionId, menu, onReply, sending = false, error = '', answered = false, answeredChoice = '', justSent = false,
  variant = 'card', autoFocus = 'idle', onOpenTerminal, hint = '', disabled = false,
}) {
  const baseId = useId()
  const listRef = useRef(null)
  const key = menuKey(menu)
  // Local state is keyed by the question: a new dialog resets the highlight
  // to the CLI's cursor, a poll of the same dialog keeps the local choice.
  const [local, setLocal] = useState(null)
  // After a reply the cursor shows what was sent, however the choice was made.
  const highlight = answered && answeredChoice ? answeredChoice : local?.key === key ? local.highlight : (selectedOption(menu)?.key || '')
  const setHighlight = (value) => setLocal({ key, highlight: value })
  const [expandedKey, setExpandedKey] = useState('')
  const expanded = expandedKey === key
  const answerable = !!menu && menu.answerable !== false
  const interactive = answerable && !answered && !sending && !disabled

  useEffect(() => {
    if (!autoFocus || !answerable || answered) return
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (autoFocus === true || !active || active === document.body) listRef.current?.focus({ preventScroll: true })
  }, [key, autoFocus, answerable, answered])

  if (!menu) return null
  const options = menu.options
  const send = (option) => {
    if (!option || !interactive) return
    setHighlight(option.key)
    if (opensTerminal(option, menu)) { onOpenTerminal?.(); return }
    onReply?.(option.key)
  }
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') { event.currentTarget.blur(); return }
    if (!interactive) return
    const index = Math.max(0, options.findIndex((option) => option.key === highlight))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      setHighlight(options[Math.min(options.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))].key)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      setHighlight(options[event.key === 'Home' ? 0 : options.length - 1].key)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      send(options[index])
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
    const typed = event.key.toLowerCase()
    const option = options.find((candidate) => candidate.key.toLowerCase() === typed)
    if (option && (isDigitKey(typed) || !isDigitKey(option.key))) {
      event.preventDefault()
      event.stopPropagation()
      send(option)
    }
  }
  const excerptLines = menu.excerpt ? menu.excerpt.split('\n') : []
  const collapsible = excerptLines.length > EXCERPT_LINES
  const excerpt = collapsible && !expanded ? excerptLines.slice(0, EXCERPT_LINES).join('\n') : menu.excerpt
  const notice = variant === 'compact' ? '' : promptNotice(menu)
  const activeId = `${baseId}-${options.findIndex((option) => option.key === highlight)}`
  const hintId = `${baseId}-hint`
  const showFoot = answerable && !answered && !sending
  const highlightOpensTerminal = opensTerminal(options.find((option) => option.key === highlight), menu)
  // Terminal order: Claude draws the request (header first) above its
  // question, Codex its question above the request.
  const questionAbove = questionFirst(menu)
  const question = menu.question && <p className="ive-prompt-menu-question">{menu.question}</p>
  const request = excerpt && <div className="ive-prompt-menu-excerpt ive-chat-request-details">
    <pre>{excerpt}{collapsible && !expanded ? '\n…' : ''}</pre>
    {collapsible && <button type="button" className="ive-chat-text-button" aria-expanded={expanded} onClick={() => setExpandedKey(expanded ? '' : key)}>{expanded ? 'Show less' : 'Show full request'}</button>}
  </div>

  return (
    <div className={`ive-prompt-menu is-${variant}`} data-prompt-menu={sessionId} data-prompt-kind={menu.kind} data-answerable={answerable ? 'true' : 'false'}>
      {questionAbove ? question : request}
      {notice && <p className="ive-chat-question-notice">{notice}</p>}
      {questionAbove ? request : question}
      <div
        ref={listRef}
        role="listbox"
        tabIndex={answerable ? 0 : -1}
        aria-label={menu.question || 'Choose an option'}
        aria-activedescendant={answerable ? activeId : undefined}
        aria-describedby={showFoot ? hintId : undefined}
        aria-busy={sending || undefined}
        aria-disabled={!interactive || undefined}
        data-prompt-menu-focus={answerable ? '' : undefined}
        className="ive-prompt-menu-options"
        onKeyDown={onKeyDown}
      >
        {options.map((option, index) => {
          const selected = option.key === highlight
          const terminal = opensTerminal(option, menu)
          return (
            <div
              key={option.key}
              id={`${baseId}-${index}`}
              role="option"
              aria-selected={selected}
              data-choice-kind={choiceTone(option, index, menu)}
              data-opens-terminal={terminal ? '' : undefined}
              className="ive-prompt-menu-option"
              title={terminal ? `${option.label} (opens the terminal)` : option.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => send(option)}
            >
              <span className="ive-prompt-menu-cursor" aria-hidden="true">{selected ? '❯' : ' '}</span>
              <span className="ive-prompt-menu-label">{option.key}. {option.label}</span>
            </div>
          )
        })}
      </div>
      {showFoot && <p id={hintId} className="ive-prompt-menu-foot">{highlightOpensTerminal ? TERMINAL_HINT : FOOT_HINT}</p>}
      {!answerable && <div className="ive-prompt-menu-open">
        <span>This question needs the terminal.</span>
        {onOpenTerminal && <button type="button" data-prompt-menu-focus="" onClick={onOpenTerminal}>Open terminal</button>}
      </div>}
      {hint && <p role="alert" className="ive-chat-question-error">{hint}</p>}
      {error && <p role="alert" className="ive-chat-question-error">{error}</p>}
      {(sending || justSent) && <p role="status" className="ive-chat-reply-status">
        {sending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {sending ? 'Sending…' : 'Sent, continuing…'}
      </p>}
    </div>
  )
}
