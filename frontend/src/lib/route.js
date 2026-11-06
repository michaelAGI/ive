// Where the user is, as data: the three views (home, board, session) derived
// from the store, the URL hash that mirrors them (#home, #board,
// #session-<id>) and the address shown in the header (ive/demo-app/add-rate-limiting).
// installRouter keeps store and hash in sync in both directions so Back/Forward
// and deep links work; '#workspace-settings-*' and other hashes stay untouched.
// A session hash may carry a query (#session-<id>?answer=1): answer=1 focuses
// that session's PromptMenu once the session is on screen (a notification or
// the iPhone linking into an open question). The written hash never keeps it.

export const VIEWS = ['home', 'board', 'session']

export function viewOf(state) {
  if (!state) return 'home'
  if (state.showHome || !Array.isArray(state.openTabs) || state.openTabs.length === 0) return 'home'
  if (state.sessionFocus && state.activeSessionId) return 'session'
  return 'board'
}

export function routeOf(state) {
  const view = viewOf(state)
  return {
    view,
    sessionId: view === 'session' ? state.activeSessionId || null : null,
    workspaceId: state?.activeWorkspaceId || null,
  }
}

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  const queryAt = raw.indexOf('?')
  const text = queryAt < 0 ? raw : raw.slice(0, queryAt)
  if (text === 'home') return { view: 'home' }
  if (text === 'board') return { view: 'board' }
  const match = text.match(/^session-(.+)$/)
  if (!match) return null
  try {
    const sessionId = decodeURIComponent(match[1])
    if (!sessionId) return null
    const route = { view: 'session', sessionId }
    if (queryAt >= 0 && new URLSearchParams(raw.slice(queryAt + 1)).get('answer') === '1') route.answer = true
    return route
  } catch {
    return null
  }
}

export function formatHash(route) {
  if (!route) return '#home'
  if (route.view === 'session' && route.sessionId) return `#session-${encodeURIComponent(route.sessionId)}`
  if (route.view === 'board') return '#board'
  return '#home'
}

export function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// 'ive/home' | 'ive/board' | 'ive/<project-slug>/<session-slug>'
export function routeLabel(state, workspaces = []) {
  const route = routeOf(state)
  if (route.view !== 'session') return `ive/${route.view}`
  const session = state.sessions?.[route.sessionId]
  const workspace = (workspaces || state.workspaces || []).find((ws) => ws.id === session?.workspace_id)
  const project = slugify(workspace?.name) || (session?.quick ? 'quick' : 'project')
  const name = slugify(session?.name) || String(route.sessionId).slice(0, 8)
  return `ive/${project}/${name}`
}

const actionsOf = (store) => (typeof store?.getState === 'function' ? store.getState() : store)

// Applies a parsed route to the store. Returns false when a session route
// cannot be applied yet because sessions[id] is still missing.
export function applyRoute(store, route) {
  const actions = actionsOf(store)
  if (!actions || !route) return false
  if (route.view === 'home') { actions.goHome?.(); return true }
  if (route.view === 'board') { (actions.goBoard || actions.goOverview)?.(); return true }
  const session = actions.sessions?.[route.sessionId]
  if (!session) return false
  if (session.workspace_id && actions.activeWorkspaceId !== session.workspace_id) actions.setActiveWorkspace?.(session.workspace_id)
  actions.openSession?.(route.sessionId, { autoStart: false, focus: false })
  actions.goSession?.(route.sessionId, { autoStart: false })
  return true
}

// Default for `?answer=1`: the PromptMenu of that session, as soon as it is
// rendered. Loaded lazily so this module stays free of the store for tests.
const focusAnswer = (sessionId) => {
  import('./promptFocus.js').then((mod) => mod.focusPromptMenuWhenRendered(sessionId)).catch(() => {})
}

export function installRouter(store, {
  history = globalThis.window?.history,
  location = globalThis.window?.location,
  target = globalThis.window,
  onAnswer = focusAnswer,
} = {}) {
  let pending = parseHash(location?.hash)
  let lastHash = null
  let applying = false

  const write = (hash) => {
    const first = lastHash === null
    lastHash = hash
    try {
      if (first) history?.replaceState?.(history.state ?? null, '', hash)
      else history?.pushState?.(null, '', hash)
    } catch { /* history can be unavailable (file://, sandboxed webviews) */ }
  }

  // Store → hash. Never while a deep link is still waiting for its session,
  // and never as an echo of a hash we are applying ourselves. A navigation
  // is several synchronous store updates (open tab, activate, focus); they
  // collapse into one history entry by syncing in a microtask.
  let scheduled = false
  let active = true
  const sync = () => {
    if (applying || pending || !active) return
    const hash = formatHash(routeOf(store.getState()))
    if (hash === lastHash) return
    write(hash)
  }
  const scheduleSync = () => {
    if (scheduled) return
    scheduled = true
    Promise.resolve().then(() => { scheduled = false; sync() })
  }

  const apply = (route) => {
    applying = true
    lastHash = formatHash(route)
    try {
      const applied = applyRoute(store, route)
      if (applied && route.answer) {
        // Drop the query so the same link fires a hashchange again next time.
        try { history?.replaceState?.(history.state ?? null, '', lastHash) } catch { /* history unavailable */ }
        onAnswer?.(route.sessionId)
      }
      return applied
    } finally { applying = false }
  }

  const unsubscribe = store.subscribe((state) => {
    if (pending) {
      if (pending.view === 'session' && !state.sessions?.[pending.sessionId]) return
      const route = pending
      pending = null
      apply(route)
      return
    }
    scheduleSync()
  })

  // Hash → store (Back/Forward, a pasted link, scripts setting location.hash).
  const onHashChange = () => {
    const route = parseHash(location?.hash)
    if (!route) return
    // Same view again is a no-op, unless the link asks to answer there.
    if (formatHash(route) === lastHash && !pending && !route.answer) return
    if (!apply(route)) pending = route
  }
  target?.addEventListener?.('hashchange', onHashChange)
  target?.addEventListener?.('popstate', onHashChange)

  if (pending) {
    if (apply(pending)) pending = null
    else lastHash = formatHash(pending)
  } else {
    sync()
  }

  return function uninstall() {
    active = false
    unsubscribe()
    target?.removeEventListener?.('hashchange', onHashChange)
    target?.removeEventListener?.('popstate', onHashChange)
  }
}
