// Files dragged from Finder into the desktop app.
//
// The Tauri shell handles file drops natively, so the page's own HTML5 drop
// handlers (ChatPanel, Terminal) never fire inside the app. That is kept on
// purpose: the native handler reports where the files really are, while an
// HTML5 drop only hands over copies of their content, and the composer turns
// binaries such as videos away. This module listens for the shell's drag
// events and puts the paths where the pointer is:
//
//   a terminal                  -> typed into it, shell-quoted, like Terminal.app
//   a chat or the Home message  -> appended to the draft of that message field
//   anywhere else               -> ignored
//
// The browser version is untouched and keeps its HTML5 drop.
import useStore from '../state/store'
import useExperienceMode from '../state/experienceMode'
import { typeInTerminalUnlessQuestion } from './terminal'
import { isTauri } from './platform'
import { isShown } from './sessionInputFocus'

// Event names of @tauri-apps/api (TauriEvent.DRAG_*). Payload of enter and
// drop: { paths: string[], position: { x, y } }; over: { position }; leave: none.
export const DRAG_EVENTS = Object.freeze({
  enter: 'tauri://drag-enter',
  over: 'tauri://drag-over',
  drop: 'tauri://drag-drop',
  leave: 'tauri://drag-leave',
})

// ChatPanel shows its drop overlay while this names its session (null clears).
export const FILE_DRAG_EVENT = 'ive-file-drag'

const SHELL_SAFE = /^[A-Za-z0-9_@%+:,./-]+$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const ANSI_C_ESCAPES = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' }

const cleanPaths = (paths) => (Array.isArray(paths) ? paths : []).filter((path) => typeof path === 'string' && path)

/** One path as a single shell word (POSIX sh, bash, zsh). */
export function shellQuote(path) {
  let text = String(path ?? '')
  if (!text) return "''"
  // A leading dash would be read as an option by the command that gets it.
  if (text.startsWith('-')) text = `./${text}`
  if (SHELL_SAFE.test(text)) return text
  // A raw newline or escape byte would act as a key press in the terminal.
  if (CONTROL_CHARS.test(text)) {
    const escaped = text.replace(/[\\'\u0000-\u001f\u007f]/g, (char) => ANSI_C_ESCAPES[char]
      || `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    return `$'${escaped}'`
  }
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** What a drop types into a terminal: every path quoted, then one space. */
export function terminalDropText(paths) {
  const words = cleanPaths(paths).map(shellQuote)
  return words.length ? `${words.join(' ')} ` : ''
}

/** A path inside a message: quoted only when it contains whitespace. */
export function draftPath(path) {
  const text = String(path ?? '')
  if (!/\s/.test(text)) return text
  if (!text.includes('"')) return `"${text}"`
  if (!text.includes("'")) return `'${text}'`
  return `"${text.replace(/"/g, '\\"')}"`
}

/** The draft with the paths added after the existing text, ready to type on. */
export function appendPathsToDraft(draft, paths) {
  const text = String(draft || '')
  const added = cleanPaths(paths).map(draftPath).join(' ')
  if (!added) return text
  return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${added} `
}

/**
 * Tauri types the drop position as physical pixels on every platform, but
 * only Windows reports physical pixels. On macOS wry passes on AppKit's
 * draggingLocation, which is in points, and one point is one CSS pixel
 * (wry 0.57 wkwebview/drag_drop.rs; tauri-runtime-wry 2.12 relabels the
 * values as PhysicalPosition without scaling). Dividing by devicePixelRatio
 * there would halve every coordinate on a Retina display.
 */
export function reportsPhysicalPixels(nav = globalThis.navigator) {
  return /Win/.test(nav?.platform || nav?.userAgent || '')
}

/** The drop position in CSS pixels, relative to the top-left of the page. */
export function dropPointToCss(position, { dpr = 1, physical = false } = {}) {
  const x = Number(position?.x)
  const y = Number(position?.y)
  if (!position || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const scale = physical && dpr > 0 ? dpr : 1
  return { x: x / scale, y: y / scale }
}

const SESSION_VIEW = '[data-session-view], [data-grid-cell-session]'
// A session's message field: the chat composer, or the composer under a
// terminal. Both edit the same draft (sessionInputs[sessionId]).
const TERMINAL_FIELD = 'form.x-composer input'
const DRAFT_FIELD = `form[data-chat-composer] textarea, [data-terminal-composer] ${TERMINAL_FIELD}`
const hasSize = (el) => el?.isConnected !== false && el?.clientWidth > 0 && el?.clientHeight > 0

/**
 * Where a drop on this element goes:
 *   { kind: 'terminal', sessionId, element }  the terminal under the pointer
 *   { kind: 'draft', sessionId, field }       the message field of that session
 *   { kind: 'home', field }                   the Home message field
 *   null                                      nowhere
 */
export function resolveDropTarget(el) {
  if (!el?.closest) return null
  // Terminal.jsx marks its screen, terminalSlots.js the node around the whole
  // terminal view. Parked terminals (1 px, off screen) are not a target.
  const terminal = el.closest('[data-terminal-session]')
  if (terminal?.dataset?.terminalSession && isShown(terminal)) {
    const sessionId = terminal.dataset.terminalSession
    // The composer under the terminal is part of that node (agents only).
    const composer = el.closest('[data-terminal-composer]')
    const field = composer && [...composer.querySelectorAll(TERMINAL_FIELD)].find(hasSize)
    return field ? { kind: 'draft', sessionId, field } : { kind: 'terminal', sessionId, element: terminal }
  }
  const home = el.closest('[data-home-composer]') || el.closest('form')?.querySelector?.('[data-home-composer]')
  if (home) return { kind: 'home', field: home }
  const view = el.closest(SESSION_VIEW)
  const sessionId = view?.dataset?.sessionView || view?.dataset?.gridCellSession
  if (!sessionId) return null
  const field = [...view.querySelectorAll(DRAFT_FIELD)].find(hasSize)
  if (field) return { kind: 'draft', sessionId, field }
  // A tile that shows only its terminal (header above it, no message field).
  const shown = [...view.querySelectorAll('[data-terminal-session]')]
    .find((node) => node.dataset?.terminalSession === sessionId && isShown(node))
  return shown ? { kind: 'terminal', sessionId, element: shown } : null
}

function targetAt(position, doc, win) {
  const point = dropPointToCss(position, { dpr: win?.devicePixelRatio || 1, physical: reportsPhysicalPixels(win?.navigator) })
  if (!point || !doc?.elementFromPoint) return null
  return resolveDropTarget(doc.elementFromPoint(point.x, point.y))
}

// After the store update has reached the field: cursor behind the new text.
function focusAtEnd(field) {
  setTimeout(() => {
    if (!field || field.isConnected === false || field.disabled) return
    field.focus({ preventScroll: true })
    const end = field.value?.length || 0
    try { field.setSelectionRange?.(end, end) } catch { /* not a text field */ }
    field.scrollTop = field.scrollHeight
  }, 0)
}

/**
 * Deliver dropped paths. Resolves to 'terminal', 'draft', 'home' or, when
 * nothing was written, 'ignored', 'read-only' or 'question-open'.
 */
export async function handleFileDrop(payload, { doc = globalThis.document, win = globalThis.window } = {}) {
  const paths = cleanPaths(payload?.paths)
  if (!paths.length) return 'ignored'
  const target = targetAt(payload?.position, doc, win)
  if (!target) return 'ignored'

  if (target.kind === 'home') {
    const experience = useExperienceMode.getState()
    experience.setHomeDraft(appendPathsToDraft(experience.homeDraft, paths))
    focusAtEnd(target.field)
    return 'home'
  }

  const store = useStore.getState()
  const session = store.sessions[target.sessionId]
  if (!session) return 'ignored'

  if (target.kind === 'draft') {
    store.setSessionInput(target.sessionId, appendPathsToDraft(store.sessionInputs[target.sessionId], paths))
    focusAtEnd(target.field)
    return 'draft'
  }

  // Same rule as typing: a read-only terminal takes no input.
  if (session.read_only) {
    store.addNotification?.({ type: 'warning', sessionId: target.sessionId, message: 'This terminal is read-only. Drop the file onto a session you can type in.' })
    return 'read-only'
  }
  // While the CLI shows a question, the digits of a path would pick an answer.
  if (!await typeInTerminalUnlessQuestion(target.sessionId, terminalDropText(paths))) return 'question-open'
  target.element.querySelector?.('.xterm-helper-textarea')?.focus({ preventScroll: true })
  return 'terminal'
}

/**
 * Listen for the shell's drag events. Does nothing in a browser. Returns the
 * function that removes the listeners again.
 */
export function installDesktopFileDrop({ listen, doc = globalThis.document, win = globalThis.window } = {}) {
  if (!listen && !isTauri()) return () => {}
  let cancelled = false
  let unlisten = []
  let hasFiles = false
  let highlighted = null
  const highlight = (sessionId) => {
    if (sessionId === highlighted) return
    highlighted = sessionId
    win?.dispatchEvent?.(new CustomEvent(FILE_DRAG_EVENT, { detail: { sessionId } }))
  }
  const hover = (payload) => {
    const target = hasFiles ? targetAt(payload?.position, doc, win) : null
    highlight(target?.kind === 'draft' ? target.sessionId : null)
  }
  // @vite-ignore: only resolved inside the shell, like the listener in App.jsx.
  const ready = listen ? Promise.resolve(listen) : import(/* @vite-ignore */ '@tauri-apps/api/event').then((api) => api.listen)
  ready
    .then((on) => Promise.all([
      on(DRAG_EVENTS.enter, (event) => { hasFiles = cleanPaths(event.payload?.paths).length > 0; hover(event.payload) }),
      on(DRAG_EVENTS.over, (event) => hover(event.payload)),
      on(DRAG_EVENTS.leave, () => { hasFiles = false; highlight(null) }),
      on(DRAG_EVENTS.drop, (event) => {
        hasFiles = false
        highlight(null)
        handleFileDrop(event.payload, { doc, win }).catch(() => { /* the drop is lost, the app keeps running */ })
      }),
    ]))
    .then((fns) => { if (cancelled) fns.forEach((fn) => fn()); else unlisten = fns })
    .catch(() => { /* not inside the desktop shell */ })
  return () => {
    cancelled = true
    unlisten.forEach((fn) => fn())
    unlisten = []
    highlight(null)
  }
}
