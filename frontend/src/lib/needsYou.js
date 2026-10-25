// The "needs you" pop-up as data: which waiting sessions become cards, the
// one-line request derived from the hook's tool_name/tool_input, and the
// identity a dismissal or a sound is remembered by. No DOM here; the
// component (components/layout/NeedsYouPopover.jsx) adds the on-screen check.
import { menuKey, normalizeMenu, orderWaitingSessions } from './promptMenu.js'
import { isShellSession } from './sessionStatus.js'

export const NEEDS_YOU_MODES = ['off', 'popup', 'popup_macos']
export const NEEDS_YOU_DEFAULT = 'popup_macos'
export const NEEDS_YOU_MAX_CARDS = 3
const LINE_MAX = 72

export function normalizeNeedsYouMode(value) {
  return NEEDS_YOU_MODES.includes(value) ? value : NEEDS_YOU_DEFAULT
}

/** What a sound or notification is keyed by: the backend's menu identity when there is one. */
export function cardIdentity(session) {
  const attention = session?.attention
  if (!attention) return ''
  const menu = normalizeMenu(attention.menu)
  if (menu) return menu.identity || menuKey(menu)
  return [session.id, attention.asked_at ?? '', attention.tool_name || '', attention.message || attention.title || ''].join('|')
}

/** What a dismissal is remembered by: the question and when it was asked, so the same request later pops up again. */
export function dismissKey(session) {
  const identity = cardIdentity(session)
  return identity ? `${identity}|${session.attention?.asked_at ?? ''}` : ''
}

/** The macOS notification needs the browser's permission once; the Tauri shell has no Notification yet. */
export async function requestNeedsYouNotifications(win = globalThis.window) {
  const Notification = win?.Notification
  if (typeof Notification !== 'function') return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try { return await Notification.requestPermission() } catch { return 'denied' }
}

export const NEEDS_YOU_MACOS_PENDING = 'macOS notifications arrive with the next IVE app update. The pop-up works now.'
export const NEEDS_YOU_MACOS_BLOCKED = 'Notifications are blocked for IVE in this browser. Allow them in its site settings, or keep the pop-up.'

/** What to say under the setting for the chosen mode, or '' when nothing needs saying. */
export function needsYouModeHelp(mode, win = globalThis.window) {
  if (mode !== 'popup_macos') return ''
  if (typeof win?.Notification !== 'function') return NEEDS_YOU_MACOS_PENDING
  return win.Notification.permission === 'denied' ? NEEDS_YOU_MACOS_BLOCKED : ''
}

const clip = (text, max = LINE_MAX) => {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function relativePath(path, workspacePath = '') {
  let text = String(path || '').trim()
  if (!text) return ''
  const root = String(workspacePath || '').replace(/\/+$/, '')
  if (root && (text === root || text.startsWith(`${root}/`))) text = text.slice(root.length + 1) || '.'
  return text.length > LINE_MAX ? `…${text.slice(-(LINE_MAX - 1))}` : text
}

const hostOf = (url) => {
  try { return new URL(String(url)).host || String(url) } catch { return clip(url) }
}

const RUN = new Set(['bash', 'execute', 'shell', 'command', 'run', 'exec'])
const EDIT = new Set(['edit', 'edit_file', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor'])
const CREATE = new Set(['write', 'write_file', 'create', 'create_file'])
const READ = new Set(['read', 'read_file'])
const FETCH = new Set(['webfetch', 'web_fetch', 'fetch'])
const SEARCH = new Set(['websearch', 'web_search', 'grep', 'glob', 'search', 'find_files'])

// The request header the CLI prints above its question, for attention that
// came without tool_input (terminal detection, older backends).
const HEADERS = [
  [/^(bash command|run command|shell command)$/i, 'Run', 'command'],
  [/^(edit file|notebook)$/i, 'Edit', 'path'],
  [/^(create file|write file)$/i, 'Create', 'path'],
  [/^read file$/i, 'Read', 'path'],
  [/^fetch$/i, 'Fetch', 'url'],
  [/^web search$/i, 'Search', 'text'],
]
const RULE = /^[─—=-]{3,}$/
const NOTICE = /^(?:Tip:|Safety check|│)/

// The parsers' excerpt: the header line, then the request without rule lines.
function fromExcerpt(excerpt, workspacePath) {
  const lines = String(excerpt || '').split('\n').map((line) => line.trim())
  const index = lines.findIndex((line) => HEADERS.some(([re]) => re.test(line)))
  if (index < 0) {
    // Codex prints no header: its command approval shows the command as a "$ " line.
    const command = lines.find((line) => /^\$\s+\S/.test(line))
    return command ? `Run: ${clip(command.replace(/^\$\s+/, ''))}` : ''
  }
  const [, verb, kind] = HEADERS.find(([re]) => re.test(lines[index]))
  const after = lines.slice(index + 1).filter(Boolean)
  const ruleAt = after.findIndex((line) => RULE.test(line))
  const body = after.filter((line) => !RULE.test(line))
  // Files print the path first. Bash prints a tip, the description, a rule,
  // the command, a rule and hook notices: with the rules gone the command is
  // the last line that is no notice; a context that kept its rule, the line after it.
  let target = body[0]
  if (kind === 'command') target = ruleAt >= 0 ? after[ruleAt + 1] : body.filter((line) => !NOTICE.test(line)).at(-1)
  if (kind === 'url') target = body.map((line) => line.replace(/^url:\s*/i, '')).find((line) => /:\/\//.test(line)) || body[0]
  if (!target) return verb === 'Run' ? 'Run a command' : ''
  if (kind === 'path') return `${verb}: ${relativePath(target, workspacePath)}`
  if (kind === 'url') return `${verb}: ${hostOf(target)}`
  return `${verb}: ${clip(target)}`
}

/** One line "what it wants": "Run: npm test", "Edit: src/App.jsx", "Fetch: example.com", "Question: …", "Plan ready". */
export function wantsLine(attention, workspacePath = '') {
  if (!attention) return ''
  const menu = normalizeMenu(attention.menu)
  const tool = String(attention.tool_name || '').toLowerCase()
  const input = attention.tool_input && typeof attention.tool_input === 'object' ? attention.tool_input : {}
  const str = (...keys) => { for (const key of keys) if (input[key] != null && String(input[key]).trim()) return String(input[key]); return '' }
  if (menu?.kind === 'plan' || tool === 'exitplanmode') return 'Plan ready'
  if (tool === 'askuserquestion' || menu?.kind === 'question') {
    const question = str('question') || menu?.question || attention.question || attention.message
    return question ? `Question: ${clip(question)}` : 'Question'
  }
  // Without tool_input (terminal detection, older backends) the request header on screen fills in.
  const parsed = fromExcerpt(menu?.excerpt || attention.context, workspacePath)
  if (RUN.has(tool)) { const command = str('command', 'cmd'); return command ? `Run: ${clip(command.split('\n')[0])}` : parsed || 'Run a command' }
  if (EDIT.has(tool)) { const path = str('file_path', 'notebook_path', 'path'); return path ? `Edit: ${relativePath(path, workspacePath)}` : parsed || 'Edit a file' }
  if (CREATE.has(tool)) { const path = str('file_path', 'path'); return path ? `Create: ${relativePath(path, workspacePath)}` : parsed || 'Create a file' }
  if (READ.has(tool)) { const path = str('file_path', 'path'); return path ? `Read: ${relativePath(path, workspacePath)}` : parsed || 'Read a file' }
  if (FETCH.has(tool)) { const url = str('url'); return url ? `Fetch: ${hostOf(url)}` : parsed || 'Fetch a page' }
  if (SEARCH.has(tool)) { const query = str('query', 'pattern'); return query ? `Search: ${clip(query)}` : parsed || 'Search' }
  if (tool === 'agent' || tool === 'task') { const text = str('description', 'prompt'); return text ? `Agent: ${clip(text)}` : 'Start an agent' }
  if (parsed) return parsed
  if (menu?.question) return clip(menu.question)
  if (tool) return `${attention.tool_name}: ${clip(str('command', 'file_path', 'path', 'url', 'query', 'pattern', 'prompt', 'description')) || 'needs approval'}`
  return clip(attention.message || attention.title) || 'Needs your answer'
}

/**
 * The stack: oldest question first, at most `max` cards, the rest counted.
 * `dismissed` holds the dismiss keys (question + asked_at) the user closed;
 * `inFront` the session ids whose terminal/chat is on screen (no card for those).
 */
export function stackCards(sessions, { dismissed = new Set(), inFront = new Set(), max = NEEDS_YOU_MAX_CARDS } = {}) {
  const ordered = orderWaitingSessions((sessions || []).filter((session) => session?.attention && !isShellSession(session)))
  const due = []
  for (const session of ordered) {
    const identity = cardIdentity(session)
    const key = dismissKey(session)
    if (!identity || dismissed.has(key) || inFront.has(session.id)) continue
    due.push({ session, identity, key })
  }
  return { cards: due.slice(0, max), more: Math.max(0, due.length - max) }
}
