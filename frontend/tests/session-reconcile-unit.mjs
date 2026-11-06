// Real store tests via Vite SSR: no browser, server API, or user data.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { notificationSessionReady, restoreOperatorDesk } from '../src/lib/operatorDesk.js'

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}
globalThis.window = Object.assign(new EventTarget(), {
  location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' },
})
let vite, store, snapshots
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' })
  store = (await vite.ssrLoadModule('/src/state/store.js')).default
  snapshots = await vite.ssrLoadModule('/src/lib/sessionSnapshots.js')
})
after(async () => { await vite?.close() })
beforeEach(() => {
  store.setState({ sessions: {}, sessionSnapshotIds: null, openTabs: [], activeSessionId: null,
    notifications: [], planWaiting: {}, gridTemplates: [], sessionFocus: false,
    terminalFocusRequest: null, sessionStarted: {}, sessionPtyStartedAt: {}, sessionWorkStartedAt: {} })
})
const session = (id) => ({ id, name: id, workspace_id: 'w', cli_type: 'claude', status: 'idle', pty_alive: true })
const notice = (sessionId) => ({ id: `notice-${sessionId}`, sessionId, type: 'auth_failed', timestamp: 1 })
const template = { id: 'layout', cell_assignments: { first: 'deleted', second: 'valid' } }

test('authoritative startup snapshot removes deleted saved tabs and auth notices, retaining valid unloaded ones', () => {
  restoreOperatorDesk(store, { getItem: () => JSON.stringify({ openTabs: ['deleted', 'valid'],
    activeSessionId: 'deleted', notifications: [notice('deleted'), notice('valid')],
    planWaiting: { deleted: true, valid: true } }) })
  store.setState({ gridTemplates: [template], sessionFocus: true, terminalFocusRequest: { id: 'deleted' } })
  assert.deepEqual(store.getState().openTabs, ['deleted', 'valid'], 'restoration waits for authoritative data')
  assert.equal(notificationSessionReady(notice('valid'), store.getState().sessions), false, 'no recovery fetch while data is missing')
  store.getState().resyncSessions([session('valid'), session('unopened')], { knownSessionIdsAtRequest: [] })
  const current = store.getState()
  assert.deepEqual(current.openTabs, ['valid'])
  assert.equal(current.activeSessionId, 'valid')
  assert.equal(current.sessionFocus, false)
  assert.equal(current.terminalFocusRequest, null)
  assert.deepEqual(current.planWaiting, { valid: true })
  assert.deepEqual(current.notifications, [notice('valid')])
  assert.deepEqual(current.gridTemplates[0].cell_assignments, { second: 'valid' })
  assert.equal(current.sessions.valid.name, 'valid')
  assert.equal(current.sessions.unopened, undefined)
  assert.equal(notificationSessionReady(current.notifications[0], current.sessions), true)
  assert.equal(notificationSessionReady(notice('deleted'), current.sessions), false)
})

test('a reload lands on the same level: sessionFocus is restored and dropped only when the session is gone', () => {
  restoreOperatorDesk(store, { getItem: () => JSON.stringify({ openTabs: ['valid'], activeSessionId: 'valid', sessionFocus: true, showHome: false }) })
  assert.equal(store.getState().sessionFocus, true)
  store.getState().resyncSessions([session('valid')], { knownSessionIdsAtRequest: [] })
  assert.equal(store.getState().sessionFocus, true)
  assert.equal(store.getState().activeSessionId, 'valid')
  restoreOperatorDesk(store, { getItem: () => JSON.stringify({ openTabs: ['gone'], activeSessionId: 'gone', sessionFocus: true, showHome: false }) })
  store.getState().resyncSessions([session('valid')], { knownSessionIdsAtRequest: [] })
  assert.equal(store.getState().sessionFocus, false)
})

test('the snapshot carries what the agent did last; helper sessions stay out of the tabs', () => {
  store.setState({ openTabs: ['valid'], activeSessionId: 'valid' })
  store.getState().resyncSessions([{ ...session('valid'), last_activity: { tool_name: 'Edit', summary: 'src/x.ts', at: 1760270400 } },
    { ...session('helper'), session_type: 'commander' }], { knownSessionIdsAtRequest: [] })
  assert.deepEqual(store.getState().sessionLastTool.valid, { tool_name: 'Edit', summary: 'src/x.ts', input: null, at: 1760270400000 })
  assert.deepEqual(store.getState().openTabs, ['valid'])
  store.getState().setSessionLastTool('valid', { tool_name: 'Bash', summary: 'npm test', at: 5 })
  store.getState().resyncSessions([{ ...session('valid'), last_activity: { tool_name: 'Edit', summary: 'src/x.ts', at: 1760270400 } }])
  assert.equal(store.getState().sessionLastTool.valid.tool_name, 'Bash', 'live events beat the snapshot')
  store.getState().resyncSessions([])
  assert.deepEqual(store.getState().sessionLastTool, {})
})

test('partial workspace loads preserve cached references that await another workspace', () => {
  store.setState({ openTabs: ['valid'], activeSessionId: 'valid', notifications: [notice('valid')], gridTemplates: [template] })
  store.getState().loadSessions([session('other-workspace')])
  assert.deepEqual(store.getState().openTabs, ['valid'])
  assert.deepEqual(store.getState().notifications, [notice('valid')])
  assert.equal(store.getState().sessionSnapshotIds, null)
  store.getState().setGridTemplates([template])
  assert.deepEqual(store.getState().gridTemplates[0].cell_assignments, template.cell_assignments)
})

test('new sessions created during the full snapshot request survive an older response', () => {
  store.setState({ sessions: { old: session('old') }, openTabs: ['old'] })
  const knownSessionIdsAtRequest = Object.keys(store.getState().sessions)
  store.getState().addSession(session('new'), { autoStart: false })
  store.getState().resyncSessions([session('old')], { knownSessionIdsAtRequest })
  assert.ok(store.getState().sessions.new)
  assert.deepEqual(store.getState().openTabs, ['old', 'new'])
  assert.equal(store.getState().activeSessionId, 'new')
})

test('reconnect removes a deletion missed while offline and sanitizes templates arriving later', () => {
  store.setState({ sessions: { deleted: session('deleted'), valid: session('valid') },
    openTabs: ['deleted', 'valid'], notifications: [notice('deleted')],
    sessionStarted: { deleted: true }, sessionPtyStartedAt: { deleted: 1 }, sessionWorkStartedAt: { deleted: 1 } })
  store.getState().resyncSessions([session('valid')])
  store.getState().setGridTemplates([template])
  const current = store.getState()
  assert.equal(current.sessions.deleted, undefined)
  assert.deepEqual(current.notifications, [])
  assert.equal(current.sessionStarted.deleted, undefined)
  assert.equal(current.sessionPtyStartedAt.deleted, undefined)
  assert.equal(current.sessionWorkStartedAt.deleted, undefined)
  assert.deepEqual(current.gridTemplates[0].cell_assignments, { second: 'valid' })
})

test('explicit deletion removes its notices and layout references without pruning other unloaded sessions', () => {
  store.setState({ openTabs: ['deleted', 'awaiting'], notifications: [notice('deleted'), notice('awaiting'), { id: 'general', type: 'error' }],
    planWaiting: { deleted: true, awaiting: true }, gridTemplates: [template], sessionSnapshotIds: ['deleted', 'valid'] })
  store.getState().removeSession('deleted')
  const current = store.getState()
  assert.deepEqual(current.openTabs, ['awaiting'])
  assert.deepEqual(current.notifications.map((n) => n.id), ['notice-awaiting', 'general'])
  assert.deepEqual(current.planWaiting, { awaiting: true })
  assert.deepEqual(current.gridTemplates[0].cell_assignments, { second: 'valid' })
  store.getState().setGridTemplates([template])
  assert.deepEqual(store.getState().gridTemplates[0].cell_assignments, { second: 'valid' })
})

test('an empty authoritative list clears ghost focus and all session-bound notices, including legacy keys', () => {
  store.setState({ openTabs: ['deleted'], activeSessionId: 'deleted', sessionFocus: true,
    notifications: [{ id: 1, type: 'auth_failed', session_id: 'deleted' }, { id: 2, type: 'error' }] })
  store.getState().resyncSessions([])
  assert.deepEqual(store.getState().openTabs, [])
  assert.equal(store.getState().activeSessionId, null)
  assert.equal(store.getState().sessionFocus, false)
  assert.deepEqual(store.getState().notifications, [{ id: 2, type: 'error' }])
})

const response = (stamp, rows) => snapshots.tagSessionSnapshot(rows, stamp)
test('a delayed reconnect snapshot cannot undo a new idle event, including a repeated event', () => {
  store.getState().loadSessions([{ ...session('s'), status: 'running', agentState: 'working' }])
  const stamp = snapshots.beginSessionSnapshot()
  store.getState().setSessionStatus('s', 'idle')
  store.getState().setSessionStatus('s', 'idle')
  store.getState().resyncSessions(response(stamp, [{ ...session('s'), status: 'running', agentState: 'working' }]))
  assert.equal(store.getState().sessions.s.status, 'idle')
  assert.equal(store.getState().sessions.s.agentState, 'idle')
})

test('a delayed workspace list cannot clear a new approval or resurrect a deleted session', () => {
  store.getState().loadSessions([session('s'), session('deleted')])
  const stamp = snapshots.beginSessionSnapshot()
  store.getState().setSessionAttention('s', { kind: 'permission', message: 'Approve this command' })
  store.getState().removeSession('deleted')
  store.getState().loadSessions(response(stamp, [{ ...session('s'), attention: null }, session('deleted')]))
  assert.equal(store.getState().sessions.s.status, 'waiting')
  assert.equal(store.getState().sessions.s.attention.message, 'Approve this command')
  assert.equal(store.getState().sessions.deleted, undefined)
})

test('fresh snapshots correct missed events, while older concurrent responses cannot roll them back', () => {
  store.getState().loadSessions([session('s')])
  const old = snapshots.beginSessionSnapshot()
  const fresh = snapshots.beginSessionSnapshot()
  store.getState().resyncSessions(response(fresh, [{ ...session('s'), status: 'running', agentState: 'working' }]))
  store.getState().loadSessions(response(old, [session('s')]))
  assert.equal(store.getState().sessions.s.status, 'running')
  const end = snapshots.beginSessionSnapshot()
  store.getState().resyncSessions(response(end, [session('s')]))
  assert.equal(store.getState().sessions.s.status, 'idle')
})

test('old empty snapshots do not remove sessions updated since the request', () => {
  store.getState().loadSessions([session('s')])
  const stamp = snapshots.beginSessionSnapshot()
  store.getState().setSessionStatus('s', 'running')
  store.getState().resyncSessions(response(stamp, []), { knownSessionIdsAtRequest: ['s'] })
  assert.equal(store.getState().sessions.s.status, 'running')
})

test('a newer deletion snapshot prevents resurrection by an older workspace response', () => {
  store.getState().loadSessions([session('s')])
  const old = snapshots.beginSessionSnapshot()
  const fresh = snapshots.beginSessionSnapshot()
  store.getState().resyncSessions(response(fresh, []))
  store.getState().loadSessions(response(old, [session('s')]))
  assert.equal(store.getState().sessions.s, undefined)
})

test('a fresh reconnect snapshot clears a plan answered in the terminal while offline', () => {
  store.getState().loadSessions([session('s')])
  store.getState().setSessionAttention('s', { kind: 'plan', menu: { kind: 'plan' } })
  const stamp = snapshots.beginSessionSnapshot()
  store.getState().resyncSessions(response(stamp, [{ ...session('s'), attention: null }]))
  assert.equal(store.getState().sessions.s.attention, null)
  assert.equal(store.getState().planWaiting.s, false)
  assert.equal(store.getState().sessions.s.status, 'idle')
})
