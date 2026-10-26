// Plain terminal sessions (cli_type "shell"): the user's login shell in a
// project folder, like a Mac Terminal window. No agent, no chat view, no
// model / permission / effort, status is just Running or Exited.
import useStore from '../state/store'
import { api } from './api'
import { lastOutputAt } from './terminalWriters'

export { SHELL_CLI, SHELL_LABEL, isShellSession, isShellCli, getShellStatusMeta } from './sessionStatus.js'
import { SHELL_CLI, SHELL_LABEL } from './sessionStatus.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Type one line into a shell once its prompt has been drawn. */
export async function typeIntoShellWhenReady(sessionId, line, { quietMs = 400, maxWaitMs = 15000 } = {}) {
  const text = String(line || '').trim()
  if (!sessionId || !text) return false
  try { await useStore.getState().ensureSessionRunning?.(sessionId) } catch { /* retried below */ }
  const begin = Date.now()
  while (Date.now() - begin < maxWaitMs) {
    const last = lastOutputAt.get(sessionId)
    if (last && Date.now() - last >= quietMs) break
    await sleep(100)
  }
  const ws = useStore.getState().ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data: `${text}\r` }))
  return true
}

function openShell(session) {
  const store = useStore.getState()
  store.addSession(session)
  if (store.tabScope === 'workspace' && session.workspace_id) store.setActiveWorkspace(session.workspace_id)
  store.goSession(session.id)
  return session
}

function nextTerminalName() {
  const names = new Set(Object.values(useStore.getState().sessions).filter((s) => !s.archived).map((s) => s.name))
  if (!names.has(SHELL_LABEL)) return SHELL_LABEL
  let number = 2
  while (names.has(`${SHELL_LABEL} ${number}`)) number++
  return `${SHELL_LABEL} ${number}`
}

/** New terminal in a project (workspace) folder. */
export async function createTerminalSession(workspaceId, { name } = {}) {
  const session = await api.createSession(workspaceId, { cli_type: SHELL_CLI, name: name || nextTerminalName() })
  if (!session?.id) throw new Error('The terminal could not be created.')
  return openShell(session)
}

/**
 * ⌘N with "Terminal": a shell in the chosen project (workspaceId) or the
 * quick start folder; text runs as a command.
 */
export async function startQuickTerminal({ text = '', workspaceId } = {}) {
  if (workspaceId) {
    const shell = await createTerminalSession(workspaceId)
    if (String(text || '').trim()) setTimeout(() => { typeIntoShellWhenReady(shell.id, text) }, 0)
    return shell
  }
  const session = await api.quickSession({ cli_type: SHELL_CLI, name: nextTerminalName() })
  if (!session?.id) throw new Error('The terminal could not be created.')
  const quick = { ...session, quick: session.quick !== false }
  const store = useStore.getState()
  if (quick.workspace_id && store.quickStart?.workspace_id !== quick.workspace_id) {
    store.setQuickStart({ ...(store.quickStart || {}), workspace_id: quick.workspace_id })
  }
  openShell(quick)
  if (String(text || '').trim()) setTimeout(() => { typeIntoShellWhenReady(quick.id, text) }, 0)
  return quick
}

/** New tab alongside the current session, in its project or the start folder. */
export async function newTerminal() {
  const store = useStore.getState()
  const candidate = (!store.showHome && store.sessions[store.activeSessionId]?.workspace_id) || store.activeWorkspaceId
  const workspaceId = candidate && store.workspaces.some((w) => w.id === candidate)
    ? candidate
    : null
  return workspaceId ? createTerminalSession(workspaceId) : startQuickTerminal()
}

// Share one pending request across buttons and shortcuts so a held key or
// double click cannot leave unwanted shells behind a slow API response.
let openingTerminal = null
export function openNewTerminal() {
  if (openingTerminal) return openingTerminal
  openingTerminal = newTerminal().catch((error) => {
    useStore.getState().addNotification({ type: 'error', message: error?.message || 'The terminal could not be opened.' })
    return null
  }).finally(() => { openingTerminal = null })
  return openingTerminal
}
