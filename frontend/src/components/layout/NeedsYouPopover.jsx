import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import useStore from '../../state/store'
import { selectNeedsYouSessions, selectView } from '../../state/selectors'
import useSessionPromptReply from '../../hooks/useSessionPromptReply'
import PromptMenu from '../session/PromptMenu'
import { normalizeMenu } from '../../lib/promptMenu'
import { cardIdentity, stackCards, wantsLine } from '../../lib/needsYou'
import { focusPromptMenuWhenRendered } from '../../lib/promptFocus'
import { isShown } from '../../lib/sessionInputFocus'
import { SOUNDS } from '../../lib/sounds'

// The small stack top right that says which agent needs you while its
// terminal or chat is not in front of you: another session's screen, Home,
// or a tile outside the viewport. Each card: session, project, one line
// "what it wants", the compact PromptMenu with the CLI's own options (the
// request excerpt behind "Show request") and "Open session". Replies go
// through the same guarded endpoint as the tiles. Dismissing (x) is local
// and never sends anything; a dismissed question (this request, asked at
// this time) stays dismissed, the same request asked again later shows up.
// An answered card leaves when its attention clears. Keys: digits send,
// Enter confirms the highlighted option, arrows move, Escape only leaves the
// pop-up; ⌘⇧Y (promptFocus) walks all waiting questions oldest first.
const EMPTY = []
const dismissedKeys = new Set()
const lastIdentityBySession = new Map()
const notifiedIdentities = new Set()
const escapeAttr = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'))
const cellsOf = (id) => [...document.querySelectorAll(`[data-session-view="${escapeAttr(id)}"], [data-grid-cell-session="${escapeAttr(id)}"]`)]

// Laid out and not faded out: the phone keeps inactive sessions mounted at opacity 0.
function isVisible(el) {
  if (!isShown(el)) return false
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05
}
// Synchronous seed for the IntersectionObserver so a card never flashes for a tile that is in front.
function mostlyInViewport(el) {
  const rect = el.getBoundingClientRect()
  const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
  const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
  return width > 0 && height > 0 && width * height >= 0.5 * rect.width * rect.height
}
const sameSet = (a, b) => a.size === b.size && [...a].every((value) => b.has(value))

// Which of these sessions have their terminal/chat on screen right now.
// Returns null until the first measurement for the current ids has run.
function useSessionsInFront(ids) {
  const key = ids.join('\n')
  const view = useStore(selectView)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const openTabs = useStore((s) => s.openTabs)
  const [state, setState] = useState({ key: null, inFront: new Set() })
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const wanted = key ? key.split('\n') : []
    const targets = new Map()
    const intersecting = new Map()
    let observer = null
    const publish = () => {
      const inFront = new Set()
      for (const [el, id] of targets) if (intersecting.get(el) && isVisible(el)) inFront.add(id)
      setState((prev) => (prev.key === key && sameSet(prev.inFront, inFront) ? prev : { key, inFront }))
    }
    const attach = () => {
      observer?.disconnect()
      targets.clear()
      intersecting.clear()
      observer = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          for (const entry of entries) intersecting.set(entry.target, entry.isIntersecting && entry.intersectionRatio >= 0.5)
          publish()
        }, { threshold: [0, 0.5, 1] })
        : null
      for (const id of wanted) for (const el of cellsOf(id)) {
        targets.set(el, id)
        intersecting.set(el, mostlyInViewport(el))
        observer?.observe(el)
      }
      publish()
    }
    attach()
    window.addEventListener('cc-terminal-refit', attach)
    window.addEventListener('resize', attach)
    // Grid cells come and go without an event of their own (templates, scope, drag).
    const timer = wanted.length ? setInterval(attach, 3000) : null
    return () => {
      observer?.disconnect()
      window.removeEventListener('cc-terminal-refit', attach)
      window.removeEventListener('resize', attach)
      if (timer) clearInterval(timer)
    }
  }, [key, view, activeSessionId, openTabs])
  return state.key === key ? state.inFront : null
}

// Below the toasts (same corner) and left of an open side chat.
function useRegionOffset(active, sideChatOpen) {
  const notificationCount = useStore((s) => s.notifications.length)
  const [style, setStyle] = useState(undefined)
  useLayoutEffect(() => {
    if (!active || typeof document === 'undefined') return undefined
    const update = () => {
      const toasts = document.querySelector('.ive-notification-region')
      const toastHeight = toasts ? toasts.getBoundingClientRect().height : 0
      const chat = sideChatOpen ? document.getElementById('ive-sidechat') : null
      const chatLeft = chat && isShown(chat) ? chat.getBoundingClientRect().left : 0
      const right = chatLeft > 0 && window.innerWidth > 600 ? window.innerWidth - chatLeft + 12 : 0
      const base = window.innerWidth <= 600 ? 64 : 72
      setStyle({
        ...(toastHeight ? { top: Math.min(base + toastHeight + 10, window.innerHeight * 0.4) } : {}),
        ...(right ? { right, maxWidth: `min(360px, calc(100vw - ${right + 12}px))` } : {}),
      })
    }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    for (const el of [document.querySelector('.ive-notification-region'), document.getElementById('ive-sidechat')]) if (el) observer?.observe(el)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [active, sideChatOpen, notificationCount])
  return active ? style : undefined
}

function notifyOutsideWindow(session, line) {
  if (typeof window === 'undefined' || typeof window.Notification !== 'function' || window.Notification.permission !== 'granted') return
  if (document.hasFocus?.()) return
  try {
    const note = new window.Notification(`${session.name || 'A session'} needs you`, { body: line, tag: `ive-needs-you-${session.id}`, silent: true })
    note.onclick = () => {
      window.focus()
      useStore.getState().goSession(session.id)
      focusPromptMenuWhenRendered(session.id)
    }
  } catch { /* notifications unavailable in this window */ }
}

// Sound and the (browser) notification, once per question identity. The
// transition into waiting already knocks (useWebSocket); a question that
// changes while the session keeps waiting is this pop-up's turn.
function useNeedsYouSignals(waiting, mode, workspaces) {
  useEffect(() => {
    const store = useStore.getState()
    const current = new Set()
    for (const session of waiting) {
      const identity = cardIdentity(session)
      if (!identity) continue
      current.add(session.id)
      const previous = lastIdentityBySession.get(session.id)
      lastIdentityBySession.set(session.id, identity)
      if (previous === identity) continue
      if (previous && store.soundEnabled && store.soundOnInputNeeded) SOUNDS.soundOnInputNeeded?.(store.soundVolume / 100)
      if (mode === 'popup_macos' && !notifiedIdentities.has(identity)) {
        notifiedIdentities.add(identity)
        const workspace = workspaces.find((item) => item.id === session.workspace_id)
        notifyOutsideWindow(session, wantsLine(session.attention, workspace?.path))
      }
    }
    for (const id of [...lastIdentityBySession.keys()]) if (!current.has(id)) lastIdentityBySession.delete(id)
  }, [waiting, mode, workspaces])
}

function NeedsYouCard({ session, dismissKey, workspace, onDismiss, autoFocus }) {
  const sessionId = session.id
  const { menu: liveMenu, sending, error, answered, answeredChoice, justSent, reply } = useSessionPromptReply(sessionId)
  const pushed = useMemo(() => normalizeMenu(session.attention?.menu), [session.attention?.menu])
  const menu = liveMenu || pushed
  const [showRequest, setShowRequest] = useState(false)
  const line = wantsLine(session.attention, workspace?.path)
  const name = session.name || sessionId.slice(0, 8)
  const openSession = () => {
    const store = useStore.getState()
    store.goSession(sessionId)
    store.toggleTerminalDrawer(sessionId, true)
  }
  return (
    <article className="ive-nyp-card" data-needs-you-card={sessionId} aria-label={`${name} needs you`} aria-busy={sending || undefined}>
      <header className="ive-nyp-head">
        <div className="ive-nyp-title">
          <strong title={name}>{name}</strong>
          {workspace?.name && <span className="ive-nyp-project" title={workspace.name}>{workspace.name}</span>}
        </div>
        <button type="button" className="ive-nyp-close" aria-label={`Dismiss ${name}`} title="Dismiss (sends nothing)" onClick={() => onDismiss(dismissKey)}><X size={14} aria-hidden="true" /></button>
      </header>
      {line && <p className="ive-nyp-wants">{line}</p>}
      {menu && <PromptMenu
        sessionId={sessionId}
        menu={menu.excerpt ? { ...menu, excerpt: '' } : menu}
        variant="compact"
        autoFocus={autoFocus ? 'idle' : false}
        onReply={(value) => reply(value)}
        sending={sending}
        error={error}
        answered={answered}
        answeredChoice={answeredChoice}
        justSent={justSent}
        disabled={!liveMenu}
        onOpenTerminal={openSession}
      />}
      {showRequest && menu?.excerpt && <pre className="ive-nyp-request">{menu.excerpt}</pre>}
      <footer className="ive-nyp-foot">
        {menu?.excerpt
          ? <button type="button" className="ive-chat-text-button" aria-expanded={showRequest} onClick={() => setShowRequest(!showRequest)}>{showRequest ? 'Hide request' : 'Show request'}</button>
          : <span />}
        <button type="button" className="ive-nyp-link" onClick={openSession}>Open session</button>
      </footer>
    </article>
  )
}

export default function NeedsYouPopover({ sideChatOpen = false }) {
  const mode = useStore((s) => s.needsYouAlert)
  const waiting = useStore(selectNeedsYouSessions)
  const workspaces = useStore((s) => s.workspaces)
  const [, setVersion] = useState(0)
  const [focusWithin, setFocusWithin] = useState(false)
  const ids = useMemo(() => (mode === 'off' ? EMPTY : waiting.map((session) => session.id)), [mode, waiting])
  const inFront = useSessionsInFront(ids)
  useNeedsYouSignals(waiting, mode, workspaces)
  const dismiss = useCallback((key) => {
    if (!key || dismissedKeys.has(key)) return
    dismissedKeys.add(key)
    setVersion((value) => value + 1)
  }, [])
  const { cards, more } = useMemo(() => (mode === 'off' || !inFront
    ? { cards: EMPTY, more: 0 }
    : stackCards(waiting, { dismissed: dismissedKeys, inFront })), [mode, waiting, inFront, dismissedKeys.size])
  const style = useRegionOffset(cards.length > 0, sideChatOpen)
  if (!cards.length) return null
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return
    // Escape only leaves the pop-up; it never sends and never closes a panel.
    event.preventDefault()
    event.stopPropagation()
    document.activeElement?.blur?.()
  }
  return (
    <section
      className="ive-nyp-region"
      aria-label="Agents that need you"
      data-needs-you-popover=""
      data-ive-popover={focusWithin ? '' : undefined}
      style={style}
      onKeyDown={onKeyDown}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false) }}
    >
      {cards.map(({ session, key }, index) => (
        <NeedsYouCard
          key={key}
          session={session}
          dismissKey={key}
          workspace={workspaces.find((item) => item.id === session.workspace_id)}
          onDismiss={dismiss}
          autoFocus={index === 0}
        />
      ))}
      {more > 0 && <div className="ive-nyp-more" data-needs-you-more={more}>+{more} more</div>}
    </section>
  )
}
