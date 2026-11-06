// Keyboard access to the open questions: ⌘⇧Y ("Answer next question")
// walks every waiting session oldest question first, pressing again moves
// on. Each question is reached where it is on screen: its "needs you" card
// when one shows, else its PromptMenu or band on the Overview or session
// screen, else by opening the session.
import useStore from '../state/store'
import { selectWaitingSessions } from '../state/selectors'
import { isShown } from './sessionInputFocus'
import { nextPromptStop, orderWaitingSessions } from './promptMenu'

let lastFocusedId = null
const escapeAttr = (value) => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'))
const shownIn = (root, selector) => (root?.querySelectorAll ? [...root.querySelectorAll(selector)].find(isShown) || null : null)

/** The focusable part of a session's PromptMenu that is on screen, if any (a pop-up card counts too). */
export function promptMenuTarget(sessionId, root = globalThis.document) {
  if (!sessionId) return null
  return shownIn(root, `[data-prompt-menu="${escapeAttr(sessionId)}"] [data-prompt-menu-focus]`)
}

/** The session's pop-up card menu, when the pop-up shows one. */
export function cardMenuTarget(sessionId, root = globalThis.document) {
  if (!sessionId) return null
  return shownIn(root, `[data-needs-you-card="${escapeAttr(sessionId)}"] [data-prompt-menu-focus]`)
}

/** Where ⌘⇧Y lands for a session: its card first, else its on-screen menu. */
export function promptTarget(sessionId, root = globalThis.document) {
  return cardMenuTarget(sessionId, root) || promptMenuTarget(sessionId, root)
}

function focusTarget(target, sessionId) {
  target.scrollIntoView?.({ block: 'nearest' })
  target.focus({ preventScroll: true })
  lastFocusedId = sessionId
  return true
}

export function focusPromptMenu(sessionId) {
  const target = promptMenuTarget(sessionId)
  return target ? focusTarget(target, sessionId) : false
}

/** Focus the session's PromptMenu once it is rendered (after goSession or a deep link). */
export function focusPromptMenuWhenRendered(sessionId, attempts = 30) {
  if (focusPromptMenu(sessionId) || attempts <= 0) return
  globalThis.requestAnimationFrame?.(() => focusPromptMenuWhenRendered(sessionId, attempts - 1))
}

/** The session whose menu has the keyboard right now, else the last one ⌘⇧Y landed on. */
function currentFocusedId(root = globalThis.document) {
  const active = root?.activeElement
  return active?.closest?.('[data-prompt-menu]')?.getAttribute('data-prompt-menu') || lastFocusedId
}

export function focusNextPromptMenu(store = useStore.getState(), root = globalThis.document) {
  const stop = nextPromptStop(orderWaitingSessions(selectWaitingSessions(store)), currentFocusedId(root), (id) => promptTarget(id, root))
  if (!stop) return null
  lastFocusedId = stop.id
  if (stop.target) return (focusTarget(stop.target, stop.id), stop.id)
  // Not on screen (Home, another session, a closed tab): open the session
  // and take the menu as soon as it is rendered.
  store.goSession(stop.id)
  focusPromptMenuWhenRendered(stop.id, 30)
  return stop.id
}

export function resetPromptFocusCycle() { lastFocusedId = null }
