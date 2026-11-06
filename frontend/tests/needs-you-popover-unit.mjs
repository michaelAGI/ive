// The "needs you" pop-up as data: the one-line request from tool_input, the
// stack (oldest first, max 3, "+n more"), dismissed identities, and the
// #session-<id>?answer=1 hash that focuses a session's PromptMenu.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { NEEDS_YOU_DEFAULT, NEEDS_YOU_MACOS_BLOCKED, NEEDS_YOU_MACOS_PENDING, NEEDS_YOU_MAX_CARDS, cardIdentity, dismissKey, needsYouModeHelp, normalizeNeedsYouMode, relativePath, requestNeedsYouNotifications, stackCards, wantsLine } from '../src/lib/needsYou.js'
import { formatHash, installRouter, parseHash } from '../src/lib/route.js'
import { parseSessionPermissionPrompt } from '../src/lib/sessionPrompt.js'
import { menuFromPrompt } from '../src/lib/promptMenu.js'
import { BASH_TWO, EDIT_THREE, menuFor } from './fixtures/prompt-dialogs.mjs'

const FIXTURES = new URL('../../backend/fixtures/permission_dialogs/', import.meta.url)
const parsedMenu = (name) => menuFromPrompt(parseSessionPermissionPrompt(fs.readFileSync(new URL(`${name}.screen.txt`, FIXTURES), 'utf8')))

const WS = '/isolated/orbit'
const menu = (question, labels, extra = {}) => ({ kind: 'permission', question, options: labels.map((label, index) => ({ key: String(index + 1), label, selected: index === 0 })), excerpt: '', identity: `id:${question}:${labels.join('|')}`, answerable: true, ...extra })
const attention = (tool_name, tool_input, extra = {}) => ({ kind: 'permission', title: 'Permission needed', message: 'Review the request.', tool_name, tool_input, menu: menu('Do you want to proceed?', ['Yes', 'No']), asked_at: 1760435700, ...extra })

test('what it wants: one line from the tool and its input', () => {
  assert.equal(wantsLine(attention('Bash', { command: 'npm test' }), WS), 'Run: npm test')
  assert.equal(wantsLine(attention('Bash', { command: 'npm test\nnpm run lint' }), WS), 'Run: npm test')
  assert.equal(wantsLine(attention('Edit', { file_path: `${WS}/src/App.jsx` }), WS), 'Edit: src/App.jsx')
  assert.equal(wantsLine(attention('MultiEdit', { file_path: '/elsewhere/lib/x.py' }), WS), 'Edit: /elsewhere/lib/x.py')
  assert.equal(wantsLine(attention('Write', { file_path: `${WS}/notes.txt` }), WS), 'Create: notes.txt')
  assert.equal(wantsLine(attention('Read', { file_path: `${WS}/README.md` }), WS), 'Read: README.md')
  assert.equal(wantsLine(attention('WebFetch', { url: 'https://example.com/docs/page?x=1' }), WS), 'Fetch: example.com')
  assert.equal(wantsLine(attention('WebSearch', { query: 'vite dynamic import' }), WS), 'Search: vite dynamic import')
  assert.equal(wantsLine(attention('AskUserQuestion', { question: 'Which colour?' }), WS), 'Question: Which colour?')
  assert.equal(wantsLine(attention('', null, { menu: menu('Which colour?', ['Red', 'Blue'], { kind: 'question' }) }), WS), 'Question: Which colour?')
  assert.equal(wantsLine(attention('ExitPlanMode', {}), WS), 'Plan ready')
  assert.equal(wantsLine(attention('', null, { menu: menu('Would you like to proceed?', ['Yes, and auto-accept edits', 'No, keep planning'], { kind: 'plan' }) }), WS), 'Plan ready')
  // Long commands are clipped, never wrapped into a paragraph.
  const long = wantsLine(attention('Bash', { command: `python3 -m pytest ${'tests/very_long_module_name_'.repeat(6)}.py -q` }), WS)
  assert.ok(long.startsWith('Run: python3 -m pytest') && long.endsWith('…') && long.length <= 78, long)
})

test('what it wants: the parsers put the header line first, so a terminal-detected menu reads as the request', () => {
  const terminal = (menu) => ({ kind: 'permission', menu })
  assert.equal(wantsLine(terminal(parsedMenu('claude-bash')), WS), 'Run: echo hello-ive > hello.txt')
  assert.equal(wantsLine(terminal(parsedMenu('claude-edit-file')), WS), 'Edit: notes.txt')
  assert.equal(wantsLine(terminal(parsedMenu('claude-create-file')), WS), 'Create: notes.txt')
  assert.equal(wantsLine(terminal(parsedMenu('claude-fetch')), WS), 'Fetch: example.com')
  assert.equal(wantsLine(terminal(menuFor(BASH_TWO)), WS), "Run: ls -d */ Projects/*/ | grep -i 'orbit|traffic'")
  assert.equal(wantsLine(terminal(menuFor(EDIT_THREE)), WS), 'Edit: src/App.jsx')
  // Codex prints no header line: the "$ " line is the command.
  assert.equal(wantsLine(terminal(parsedMenu('codex-command')), WS), 'Run: touch created.txt')
  assert.equal(wantsLine(terminal(parsedMenu('codex-network')), WS), 'Run: curl -sI https://example.com')
  assert.equal(wantsLine(terminal(parsedMenu('codex-patch')), WS), "Run: printf 'hello' > hello.md")
})

test('what it wants: without tool_input the request header above the question is read', () => {
  const bash = attention('', null, { menu: { ...menu('Do you want to proceed?', ['Yes', 'No']), excerpt: 'Bash command\nFind Orbit and traffic projects\n──────────────────────────────\nls -d */ Projects/*/ | grep -i orbit' } })
  assert.equal(wantsLine(bash, WS), 'Run: ls -d */ Projects/*/ | grep -i orbit')
  const edit = attention('', null, { menu: { ...menu('Do you want to proceed?', ['Yes', 'No']), excerpt: `Edit file\n${WS}/src/App.jsx\n──────\n-  a\n+  b` } })
  assert.equal(wantsLine(edit, WS), 'Edit: src/App.jsx')
  const create = attention('', null, { menu: { ...menu('Do you want to proceed?', ['Yes', 'No']), excerpt: `Create file\n${WS}/notes.txt` } })
  assert.equal(wantsLine(create, WS), 'Create: notes.txt')
  const fetch = attention('', null, { menu: { ...menu('Do you want to proceed?', ['Yes', 'No']), excerpt: 'Fetch\nhttps://example.com/x' } })
  assert.equal(wantsLine(fetch, WS), 'Fetch: example.com')
  // Terminal-detected attention carries the screen as context.
  assert.equal(wantsLine({ tool_name: 'command', message: 'Review the request in the terminal.', context: 'Bash command\nList files\n─────\nls -la\nDo you want to proceed?' }, WS), 'Run: ls -la')
  // Nothing recognisable: the CLI's question, then the hook message.
  assert.equal(wantsLine(attention('', null), WS), 'Do you want to proceed?')
  assert.equal(wantsLine({ message: 'The agent is waiting for your input.' }), 'The agent is waiting for your input.')
  assert.equal(wantsLine({}), 'Needs your answer')
  assert.equal(wantsLine(null), '')
  assert.equal(relativePath(`${WS}/a/b.txt`, `${WS}/`), 'a/b.txt')
  assert.equal(relativePath('/other/a.txt', WS), '/other/a.txt')
})

const waiting = (id, asked_at, extra = {}) => ({ id, name: `Session ${id}`, cli_type: 'claude', status: 'waiting', attention: attention('Bash', { command: `cmd ${id}` }, { asked_at, menu: menu(`Proceed with ${id}?`, ['Yes', 'No']) }), ...extra })

test('the stack: oldest question first, at most three, the rest counted', () => {
  const sessions = [waiting('c', 300), waiting('a', 100), waiting('e', 500), waiting('b', 200), waiting('d', 400)]
  const { cards, more } = stackCards(sessions)
  assert.equal(NEEDS_YOU_MAX_CARDS, 3)
  assert.deepEqual(cards.map((card) => card.session.id), ['a', 'b', 'c'])
  assert.equal(more, 2)
  assert.deepEqual(stackCards(sessions, { max: 10 }).cards.map((card) => card.session.id), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(stackCards([]).more, 0)
  // Unknown ages go last; shell sessions and sessions without attention never become cards.
  const mixed = [waiting('x', null), waiting('a', 100), waiting('sh', 50, { cli_type: 'shell' }), { id: 'idle', name: 'Idle', attention: null }]
  assert.deepEqual(stackCards(mixed).cards.map((card) => card.session.id), ['a', 'x'])
})

test('dismissed questions and sessions in front are left out', () => {
  const sessions = [waiting('a', 100), waiting('b', 200), waiting('c', 300), waiting('d', 400)]
  const dismissed = new Set([dismissKey(sessions[0])])
  const stack = stackCards(sessions, { dismissed, inFront: new Set(['c']) })
  assert.deepEqual(stack.cards.map((card) => card.session.id), ['b', 'd'])
  assert.deepEqual(stack.cards.map((card) => card.key), [dismissKey(sessions[1]), dismissKey(sessions[3])])
  assert.equal(stack.more, 0)
  // A dismissal is this request asked at this time: the same request asked again later pops up again.
  assert.equal(dismissKey(sessions[0]), 'id:Proceed with a?:Yes|No|100')
  assert.deepEqual(stackCards([waiting('a', 999)], { dismissed }).cards.map((card) => card.session.id), ['a'])
  assert.deepEqual(stackCards([waiting('a', 100)], { dismissed }).cards, [])
  // The identity is the backend's menu identity; the same question again is the same identity (sounds, notifications).
  assert.equal(cardIdentity(sessions[0]), 'id:Proceed with a?:Yes|No')
  assert.equal(cardIdentity(waiting('a', 999)), cardIdentity(sessions[0]))
  const noIdentity = waiting('n', 1, { attention: attention('Bash', { command: 'x' }, { menu: { ...menu('Q?', ['Yes', 'No']), identity: null } }) })
  assert.equal(cardIdentity(noIdentity), 'Q?\n1. Yes\n2. No\n')
  // Attention without a menu is keyed by session, time and request.
  const plain = { id: 'p', attention: { tool_name: 'Bash', message: 'Run it?', asked_at: 42 } }
  assert.equal(cardIdentity(plain), 'p|42|Bash|Run it?')
  assert.equal(cardIdentity({ id: 'q' }), '')
})

test('the setting has three modes and defaults to pop-up plus macOS notification', () => {
  assert.equal(NEEDS_YOU_DEFAULT, 'popup_macos')
  assert.equal(normalizeNeedsYouMode('off'), 'off')
  assert.equal(normalizeNeedsYouMode('popup'), 'popup')
  assert.equal(normalizeNeedsYouMode('popup_macos'), 'popup_macos')
  assert.equal(normalizeNeedsYouMode(null), 'popup_macos')
  assert.equal(normalizeNeedsYouMode('loud'), 'popup_macos')
})

test('choosing the macOS notification asks the browser once; the shell without Notification says what works', async () => {
  const fakeNotification = (permission, answer = 'granted') => {
    const calls = []
    function Notification() {}
    Notification.permission = permission
    Notification.requestPermission = async () => { calls.push(1); Notification.permission = answer; return answer }
    return { win: { Notification }, calls }
  }
  // Tauri today: no Notification at all. The choice is kept, the help text explains.
  assert.equal(await requestNeedsYouNotifications({}), 'unsupported')
  assert.equal(await requestNeedsYouNotifications(undefined), 'unsupported')
  assert.equal(needsYouModeHelp('popup_macos', {}), NEEDS_YOU_MACOS_PENDING)
  assert.equal(needsYouModeHelp('popup', {}), '')
  assert.equal(needsYouModeHelp('off', {}), '')
  // A browser that has not been asked yet: asked exactly on this choice, once.
  const asked = fakeNotification('default')
  assert.equal(await requestNeedsYouNotifications(asked.win), 'granted')
  assert.equal(asked.calls.length, 1)
  assert.equal(await requestNeedsYouNotifications(asked.win), 'granted')
  assert.equal(asked.calls.length, 1, 'granted is never asked again')
  assert.equal(needsYouModeHelp('popup_macos', asked.win), '')
  // Already decided: no prompt; a refusal is explained.
  const denied = fakeNotification('denied')
  assert.equal(await requestNeedsYouNotifications(denied.win), 'denied')
  assert.equal(denied.calls.length, 0)
  assert.equal(needsYouModeHelp('popup_macos', denied.win), NEEDS_YOU_MACOS_BLOCKED)
  const throwing = fakeNotification('default')
  throwing.win.Notification.requestPermission = async () => { throw new Error('no UI') }
  assert.equal(await requestNeedsYouNotifications(throwing.win), 'denied')
})

test('#session-<id>?answer=1 parses, plain hashes keep working, the written hash never carries it', () => {
  assert.deepEqual(parseHash('#session-abc'), { view: 'session', sessionId: 'abc' })
  assert.deepEqual(parseHash('#session-abc?answer=1'), { view: 'session', sessionId: 'abc', answer: true })
  assert.deepEqual(parseHash('#session-a%20b?answer=1&from=phone'), { view: 'session', sessionId: 'a b', answer: true })
  assert.deepEqual(parseHash('#session-abc?answer=0'), { view: 'session', sessionId: 'abc' })
  assert.deepEqual(parseHash('#session-abc?from=phone'), { view: 'session', sessionId: 'abc' })
  assert.deepEqual(parseHash('#board?answer=1'), { view: 'board' })
  assert.deepEqual(parseHash('#home?x=1'), { view: 'home' })
  assert.equal(parseHash('#session-?answer=1'), null)
  assert.equal(formatHash({ view: 'session', sessionId: 'abc', answer: true }), '#session-abc')
})

// A tiny store with the navigation actions of state/store.js (as in route-unit.mjs).
function fakeStore(initial = {}) {
  let state = { showHome: true, sessionFocus: false, openTabs: [], activeSessionId: null, activeWorkspaceId: null, sessions: {}, workspaces: [], ...initial }
  const listeners = new Set()
  const set = (patch) => { const previous = state; state = { ...state, ...patch }; for (const fn of [...listeners]) fn(state, previous) }
  const actions = {
    goHome: () => set({ showHome: true }),
    goBoard: () => (state.openTabs.length ? set({ showHome: false, sessionFocus: false }) : set({ showHome: true })),
    goSession: (id) => set({ showHome: false, sessionFocus: true, activeSessionId: id || state.activeSessionId }),
    openSession: (id) => set({ openTabs: state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id], activeSessionId: id, showHome: false }),
    setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  }
  return { getState: () => ({ ...state, ...actions }), setState: set, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
}
function fakeWindow(hash = '') {
  const target = new EventTarget()
  const location = { hash }
  const history = { state: null, replaceState: (s, t, url) => { location.hash = url }, pushState: (s, t, url) => { location.hash = url } }
  return { target, location, history }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('answer=1 focuses the session menu after navigation, also on the current session and again on the next click', async () => {
  const store = fakeStore({ showHome: false, openTabs: ['s1'], activeSessionId: 's1', sessionFocus: true, sessions: { s1: { id: 's1', workspace_id: 'w' }, s2: { id: 's2', workspace_id: 'w' } } })
  const win = fakeWindow('#session-s1')
  const answered = []
  const uninstall = installRouter(store, { ...win, onAnswer: (id) => answered.push(id) })
  await flush()
  assert.deepEqual(answered, [])
  // The same session, asked to answer: no view change, but the menu is focused and the query is stripped.
  win.location.hash = '#session-s1?answer=1'
  win.target.dispatchEvent(new Event('hashchange'))
  await flush()
  assert.deepEqual(answered, ['s1'])
  assert.equal(win.location.hash, '#session-s1')
  // Clicking the same link again fires again.
  win.location.hash = '#session-s1?answer=1'
  win.target.dispatchEvent(new Event('hashchange'))
  await flush()
  assert.deepEqual(answered, ['s1', 's1'])
  // Another session: navigate there, then focus.
  win.location.hash = '#session-s2?answer=1'
  win.target.dispatchEvent(new Event('hashchange'))
  await flush()
  assert.equal(store.getState().activeSessionId, 's2')
  assert.equal(store.getState().sessionFocus, true)
  assert.deepEqual(answered, ['s1', 's1', 's2'])
  assert.equal(win.location.hash, '#session-s2')
  // A plain hash still navigates without focusing anything.
  win.location.hash = '#session-s1'
  win.target.dispatchEvent(new Event('hashchange'))
  await flush()
  assert.equal(store.getState().activeSessionId, 's1')
  assert.deepEqual(answered, ['s1', 's1', 's2'])
  uninstall()
})

test('a deep link with answer=1 waits for its session, then focuses once', async () => {
  const store = fakeStore()
  const win = fakeWindow('#session-late?answer=1')
  const answered = []
  const uninstall = installRouter(store, { ...win, onAnswer: (id) => answered.push(id) })
  await flush()
  assert.deepEqual(answered, [])
  store.setState({ sessions: { late: { id: 'late', workspace_id: 'w' } } })
  await flush()
  assert.deepEqual(answered, ['late'])
  assert.equal(store.getState().activeSessionId, 'late')
  assert.equal(win.location.hash, '#session-late')
  store.setState({ activeWorkspaceId: 'w' })
  await flush()
  assert.deepEqual(answered, ['late'])
  uninstall()
})
