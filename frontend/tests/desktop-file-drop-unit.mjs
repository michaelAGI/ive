// Files dropped from Finder in the desktop app (lib/desktopFileDrop.js): the
// shell reports paths and a position, the page puts the paths into the
// terminal or message field under the pointer. Loads the real module, store
// and terminal helpers through Vite's SSR loader with a fake document and a
// fake socket; no browser, backend or Tauri shell involved.
//
//   node --test tests/desktop-file-drop-unit.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' } })
globalThis.CustomEvent = globalThis.CustomEvent || class extends Event { constructor(t, o) { super(t); this.detail = o?.detail } }
globalThis.WebSocket = globalThis.WebSocket || { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }

let server, drop, useStore, useExperienceMode, api
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error',
  })
  useStore = (await server.ssrLoadModule('/src/state/store.js')).default
  useExperienceMode = (await server.ssrLoadModule('/src/state/experienceMode.js')).default
  ;({ api } = await server.ssrLoadModule('/src/lib/api.js'))
  drop = await server.ssrLoadModule('/src/lib/desktopFileDrop.js')
})
after(async () => { await server?.close() })

// ── A fake document: just enough of closest/querySelectorAll for the module.
const matchesSimple = (el, simple) => {
  const m = simple.match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/)
  if (!m) throw new Error(`fake DOM cannot match "${simple}"`)
  const [, tag, classes, attrs] = m
  if (tag && el.tag !== tag) return false
  if ((classes.match(/\.[\w-]+/g) || []).some((c) => !el.classes.includes(c.slice(1)))) return false
  return (attrs.match(/\[[\w-]+\]/g) || []).every((a) => a.slice(1, -1) in el.attrs)
}
const matchesOne = (el, selector) => {
  const parts = selector.trim().split(/\s+/)
  if (!matchesSimple(el, parts.pop())) return false
  let node = el.parent
  while (parts.length) {
    const want = parts.pop()
    while (node && !matchesSimple(node, want)) node = node.parent
    if (!node) return false
    node = node.parent
  }
  return true
}
const matches = (el, selector) => selector.split(',').some((part) => matchesOne(el, part))
const camel = (name) => name.replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())
function node(tag, attrs = {}, children = [], extra = {}) {
  const el = {
    tag, attrs, parent: null, children, classes: (attrs.class || '').split(' ').filter(Boolean),
    isConnected: true, clientWidth: 400, clientHeight: 200, value: '', focused: 0, selection: null,
    dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [camel(k), v])),
    closest(selector) { for (let n = el; n; n = n.parent) if (matches(n, selector)) return n; return null },
    querySelectorAll(selector) {
      const found = []
      const walk = (n) => n.children.forEach((child) => { if (matches(child, selector)) found.push(child); walk(child) })
      walk(el)
      return found
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null },
    focus() { el.focused += 1 },
    setSelectionRange(start, end) { el.selection = [start, end] },
    ...extra,
  }
  children.forEach((child) => { child.parent = el })
  return el
}

// One app page: sidebar, Home, a chat session with its terminal drawer, an
// agent's terminal view with the composer under it, a plain shell, an
// overview tile that only shows a terminal (its composer is display:none)
// and a parked terminal. As in the app, the node around a terminal view
// (terminalSlots.js) and the terminal screen inside it both carry the marker.
function terminalView(id, { field = true, shown = true } = {}) {
  const size = shown ? {} : { clientWidth: 0, clientHeight: 0 }
  const helper = node('textarea', { class: 'xterm-helper-textarea' })
  const screen = node('div', { class: 'xterm-screen' })
  const wrapper = node('div', { 'data-terminal-session': id }, [screen, helper])
  const input = field ? node('input', {}, [], size) : null
  const status = node('div', { class: 'status-row' }, [], size)
  const composer = node('div', { 'data-terminal-composer': '' }, [status, ...(input ? [node('form', { class: 'x-composer' }, [input], size)] : [])], size)
  const portal = node('div', { class: 'ive-terminal-portal', 'data-terminal-session': id }, [wrapper, composer])
  return { portal, wrapper, screen, helper, composer, status, input }
}
function page() {
  const el = {}
  el.sidebar = node('aside', { class: 'ive-sidebar' })
  el.homeField = node('textarea', { 'data-home-composer': '' })
  el.homeRow = node('div', { class: 'ive-home-composer-row' })
  el.homeForm = node('form', { class: 'x-composer ive-home-composer' }, [el.homeField, el.homeRow])
  el.homeHint = node('p', { class: 'ive-chat-home-hint' })
  el.home = node('div', { 'data-home-screen': '' }, [el.homeForm, el.homeHint])

  el.chatField = node('textarea')
  el.chatTranscript = node('div', { class: 'ive-conversation-transcript' })
  el.chatForm = node('form', { class: 'x-composer ive-session-composer', 'data-chat-composer': '' }, [el.chatField])
  el.drawer = terminalView('chat', { field: false })
  el.drawerBar = node('div', { class: 'perms-bar' })
  el.drawer.portal.children.unshift(el.drawerBar)
  el.drawerBar.parent = el.drawer.portal
  el.chatView = node('div', { 'data-session-view': 'chat', 'data-grid-cell-session': 'chat' }, [el.chatTranscript, el.chatForm, el.drawer.portal])

  el.term = terminalView('term')
  el.termHeader = node('div', { class: 'ive-tile-header' })
  el.termView = node('div', { 'data-session-view': 'term' }, [el.termHeader, el.term.portal])

  el.shell = terminalView('shell', { field: false })
  el.shellView = node('div', { 'data-session-view': 'shell' }, [el.shell.portal])

  el.tile = terminalView('tile', { shown: false })
  el.tileHeader = node('div', { class: 'ive-tile-header' })
  el.tileView = node('div', { 'data-grid-cell-session': 'tile' }, [el.tileHeader, el.tile.portal])

  el.parked = terminalView('parked')
  for (const part of [el.parked.portal, el.parked.wrapper]) Object.assign(part, { clientWidth: 1, clientHeight: 1 })
  el.emptyTile = node('div', { 'data-grid-cell-session': 'gone' }, [node('div', { class: 'ive-tile-header' })])
  el.root = node('div', { id: 'root' }, [el.sidebar, el.home, el.chatView, el.termView, el.shellView, el.tileView, el.emptyTile, el.parked.portal])
  return el
}
// A document whose elementFromPoint answers from a list of [x, y, element].
function docAt(spots) {
  const asked = []
  return { asked, elementFromPoint(x, y) { asked.push([x, y]); return spots.find(([sx, sy]) => sx === x && sy === y)?.[2] || null } }
}
const mac = { devicePixelRatio: 2, navigator: { platform: 'MacIntel' }, dispatchEvent() {} }
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

let sent
const session = (id, extra = {}) => ({ id, workspace_id: 'w', name: id, cli_type: 'shell', status: 'running', pty_alive: true, ...extra })
beforeEach(() => {
  sent = []
  useStore.setState({
    ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
    sessions: { chat: session('chat', { cli_type: 'claude' }), term: session('term'), shell: session('shell'), tile: session('tile') },
    sessionInputs: {}, notifications: [],
  })
  useExperienceMode.getState().setHomeDraft('')
  api.getSessionOutput = async () => ({ screen: '', menu: null })
})

// ── Shell quoting ────────────────────────────────────────────────────────
const CASES = [
  ['/Users/max/Desktop/clip.mp4', '/Users/max/Desktop/clip.mp4'],
  ['/Users/max/Desktop/My Clip (final).mp4', "'/Users/max/Desktop/My Clip (final).mp4'"],
  ["/Users/max/it's here.txt", "'/Users/max/it'\\''s here.txt'"],
  ['/tmp/say "hi" $HOME `id` \\ * ? ! # ; & | < > ~ {a,b} [x].txt', "'/tmp/say \"hi\" $HOME `id` \\ * ? ! # ; & | < > ~ {a,b} [x].txt'"],
  ['/Users/max/Bücher/Größe übersicht.pdf', "'/Users/max/Bücher/Größe übersicht.pdf'"],
  ['/Users/max/Bücher/日本語 🎬.mov', "'/Users/max/Bücher/日本語 🎬.mov'"],
  ['-rf', './-rf'],
  ['--force my file', "'./--force my file'"],
  ['/tmp/a=b', "'/tmp/a=b'"],
  ['', "''"],
]
test('shellQuote: plain paths stay bare, everything else becomes one quoted word', () => {
  for (const [path, quoted] of CASES) assert.equal(drop.shellQuote(path), quoted, path)
  // The decomposed umlaut (as Finder reports it) is passed on byte for byte.
  assert.ok(drop.shellQuote('/Users/max/Bücher').includes('ü'))
})
test('shellQuote: a newline or escape byte never reaches the terminal raw', () => {
  const quoted = drop.shellQuote("/tmp/two\nlines\x1b[31m it's\ttabbed\\.txt")
  assert.equal(quoted, "$'/tmp/two\\nlines\\x1b[31m it\\'s\\ttabbed\\\\.txt'")
  assert.doesNotMatch(quoted, /[\u0000-\u001f\u007f]/)
})
test('shellQuote: real shells read the word back as the original path', () => {
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(existsSync)
  assert.ok(shells.length > 0, 'at least one shell to check against')
  const paths = CASES.map(([path]) => path).filter(Boolean)
  for (const shell of shells) {
    const script = `printf '%s\\0' ${paths.map(drop.shellQuote).join(' ')}`
    const read = execFileSync(shell, ['-c', script], { encoding: 'utf8' }).split('\0').slice(0, -1)
    assert.deepEqual(read, paths.map((path) => (path.startsWith('-') ? `./${path}` : path)), shell)
  }
  // $'…' is a bash/zsh form (macOS /bin/sh is bash).
  for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
    const path = "/tmp/two\nlines\x1b[31m it's\ttabbed\\.txt"
    assert.equal(execFileSync(shell, ['-c', `printf '%s' ${drop.shellQuote(path)}`], { encoding: 'utf8' }), path, shell)
  }
})
test('terminalDropText: quoted paths joined by spaces, one space at the end', () => {
  assert.equal(drop.terminalDropText(['/a/b.txt', '/a/my clip.mp4']), "/a/b.txt '/a/my clip.mp4' ")
  assert.equal(drop.terminalDropText(['/a/b.txt']), '/a/b.txt ')
  assert.equal(drop.terminalDropText([]), '')
  assert.equal(drop.terminalDropText(undefined), '')
  assert.equal(drop.terminalDropText(['', null, '/a']), '/a ')
})

// ── Draft text ───────────────────────────────────────────────────────────
test('draftPath: only a path with whitespace is quoted', () => {
  assert.equal(drop.draftPath('/Users/max/clip.mp4'), '/Users/max/clip.mp4')
  assert.equal(drop.draftPath('/Users/max/My Clip.mp4'), '"/Users/max/My Clip.mp4"')
  assert.equal(drop.draftPath('/Users/max/Bücher/日本語.txt'), '/Users/max/Bücher/日本語.txt')
  assert.equal(drop.draftPath('/tmp/a "b" c'), "'/tmp/a \"b\" c'")
  assert.equal(drop.draftPath(`/tmp/a "b" it's`), `"/tmp/a \\"b\\" it's"`)
})
test('appendPathsToDraft: a space separates the paths from the text before them', () => {
  assert.equal(drop.appendPathsToDraft('', ['/a/b.mp4']), '/a/b.mp4 ')
  assert.equal(drop.appendPathsToDraft('Look at', ['/a/b.mp4']), 'Look at /a/b.mp4 ')
  assert.equal(drop.appendPathsToDraft('Look at ', ['/a/b.mp4']), 'Look at /a/b.mp4 ')
  assert.equal(drop.appendPathsToDraft('Look at\n', ['/a/my clip.mp4', '/c']), 'Look at\n"/a/my clip.mp4" /c ')
  assert.equal(drop.appendPathsToDraft(undefined, ['/a']), '/a ')
  assert.equal(drop.appendPathsToDraft('Keep', []), 'Keep')
  // A second drop does not double the space.
  assert.equal(drop.appendPathsToDraft(drop.appendPathsToDraft('', ['/a']), ['/b']), '/a /b ')
})

// ── Position ─────────────────────────────────────────────────────────────
test('dropPointToCss: macOS points are CSS pixels, Windows pixels are divided', () => {
  assert.deepEqual(drop.dropPointToCss({ x: 800, y: 600 }, { dpr: 2, physical: false }), { x: 800, y: 600 })
  assert.deepEqual(drop.dropPointToCss({ x: 800, y: 600 }, { dpr: 2, physical: true }), { x: 400, y: 300 })
  assert.deepEqual(drop.dropPointToCss({ x: 300, y: 150 }, { dpr: 1.5, physical: true }), { x: 200, y: 100 })
  assert.deepEqual(drop.dropPointToCss({ x: 10.5, y: 0 }), { x: 10.5, y: 0 })
  assert.deepEqual(drop.dropPointToCss({ x: 10, y: 20 }, { dpr: 0, physical: true }), { x: 10, y: 20 })
  for (const bad of [null, undefined, {}, { x: 1 }, { x: 'a', y: 2 }, { x: NaN, y: 1 }]) assert.equal(drop.dropPointToCss(bad, { dpr: 2 }), null)
})
test('reportsPhysicalPixels: only Windows', () => {
  assert.equal(drop.reportsPhysicalPixels({ platform: 'MacIntel' }), false)
  assert.equal(drop.reportsPhysicalPixels({ platform: 'Win32' }), true)
  assert.equal(drop.reportsPhysicalPixels({ platform: 'Linux x86_64' }), false)
  assert.equal(drop.reportsPhysicalPixels({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), true)
  assert.equal(drop.reportsPhysicalPixels(undefined), false)
})

// ── Target ───────────────────────────────────────────────────────────────
test('resolveDropTarget: terminal, message field, Home field or nothing', () => {
  const el = page()
  const kind = (target) => target && [target.kind, target.sessionId].filter(Boolean).join(':')
  // A terminal wins over the session view around it (chat with open drawer).
  assert.equal(kind(drop.resolveDropTarget(el.drawer.screen)), 'terminal:chat')
  assert.equal(drop.resolveDropTarget(el.drawer.screen).element, el.drawer.wrapper)
  assert.equal(kind(drop.resolveDropTarget(el.drawerBar)), 'terminal:chat', 'the bar above the drawer terminal belongs to it')
  assert.equal(kind(drop.resolveDropTarget(el.term.screen)), 'terminal:term')
  // Anywhere else in a chat view: its composer.
  assert.equal(kind(drop.resolveDropTarget(el.chatTranscript)), 'draft:chat')
  assert.equal(drop.resolveDropTarget(el.chatTranscript).field, el.chatField)
  assert.equal(drop.resolveDropTarget(el.chatField).field, el.chatField)
  // The composer under an agent's terminal edits the same draft.
  assert.equal(kind(drop.resolveDropTarget(el.term.status)), 'draft:term')
  assert.equal(drop.resolveDropTarget(el.term.input).field, el.term.input)
  assert.equal(kind(drop.resolveDropTarget(el.termHeader)), 'draft:term')
  // A plain shell has no message field: its status row is the terminal.
  assert.equal(kind(drop.resolveDropTarget(el.shell.status)), 'terminal:shell')
  assert.equal(drop.resolveDropTarget(el.shell.status).element, el.shell.portal)
  // A tile that shows only its terminal: the header counts as that terminal.
  assert.equal(kind(drop.resolveDropTarget(el.tile.screen)), 'terminal:tile')
  assert.equal(kind(drop.resolveDropTarget(el.tileHeader)), 'terminal:tile')
  // Home: the message box, not the rest of the page.
  assert.equal(kind(drop.resolveDropTarget(el.homeField)), 'home')
  assert.equal(drop.resolveDropTarget(el.homeRow).field, el.homeField)
  assert.equal(drop.resolveDropTarget(el.homeHint), null)
  assert.equal(drop.resolveDropTarget(el.home), null)
  // Empty space, a tile without field or terminal, no element at all.
  assert.equal(drop.resolveDropTarget(el.sidebar), null)
  assert.equal(drop.resolveDropTarget(el.root), null)
  assert.equal(drop.resolveDropTarget(el.emptyTile.children[0]), null)
  assert.equal(drop.resolveDropTarget(null), null)
  assert.equal(drop.resolveDropTarget({}), null)
})
test('resolveDropTarget: a terminal that is not on screen does not take the drop', () => {
  const el = page()
  assert.equal(drop.resolveDropTarget(el.parked.screen), null, 'parked, 1 px')
  for (const part of [el.tile.portal, el.tile.wrapper]) Object.assign(part, { clientWidth: 1, clientHeight: 1 })
  assert.equal(drop.resolveDropTarget(el.tileHeader), null)
})

// ── The drop itself ──────────────────────────────────────────────────────
test('drop on a terminal types the quoted paths into that session', async () => {
  const el = page()
  const doc = docAt([[800, 600, el.term.screen]])
  const result = await drop.handleFileDrop({ paths: ['/Users/max/Desktop/My Clip.mp4', '/Users/max/a.txt'], position: { x: 800, y: 600 } }, { doc, win: mac })
  assert.equal(result, 'terminal')
  assert.deepEqual(sent, [{ action: 'input', session_id: 'term', data: "'/Users/max/Desktop/My Clip.mp4' /Users/max/a.txt " }])
  assert.equal(el.term.helper.focused, 1, 'the keyboard follows the path into the terminal')
  // macOS: the position is used as it comes, also on a Retina display.
  assert.deepEqual(doc.asked, [[800, 600]])
})
test('drop on Windows converts physical pixels first', async () => {
  const el = page()
  const doc = docAt([[400, 300, el.term.screen]])
  const win = { devicePixelRatio: 2, navigator: { platform: 'Win32' } }
  assert.equal(await drop.handleFileDrop({ paths: ['/a'], position: { x: 800, y: 600 } }, { doc, win }), 'terminal')
  assert.deepEqual(doc.asked, [[400, 300]])
})
test('a read-only terminal refuses the drop and says why', async () => {
  const el = page()
  useStore.setState((s) => ({ sessions: { ...s.sessions, term: { ...s.sessions.term, read_only: 1, annotation_target_session_id: 'chat' } } }))
  const result = await drop.handleFileDrop({ paths: ['/a/b.mp4'], position: { x: 5, y: 5 } }, { doc: docAt([[5, 5, el.term.screen]]), win: mac })
  assert.equal(result, 'read-only')
  assert.deepEqual(sent, [], 'nothing is typed, not even into the note target')
  assert.equal(el.term.helper.focused, 0)
  const [notice] = useStore.getState().notifications
  assert.equal(notice.sessionId, 'term')
  assert.match(notice.message, /read-only/)
})
test('a terminal with an open question keeps the path out', async () => {
  const el = page()
  useStore.setState((s) => ({ sessions: { ...s.sessions, term: { ...s.sessions.term, cli_type: 'claude', attention: { kind: 'permission' } } } }))
  const result = await drop.handleFileDrop({ paths: ['/a/clip 1.mp4'], position: { x: 5, y: 5 } }, { doc: docAt([[5, 5, el.term.screen]]), win: mac })
  assert.equal(result, 'question-open')
  assert.deepEqual(sent, [], 'the digits of a path must not answer the dialog')
  assert.equal(useStore.getState().notifications.length, 1)
})
test('an agent terminal is asked for an open dialog before the path is typed', async () => {
  const el = page()
  const asked = []
  api.getSessionOutput = async (id) => { asked.push(id); return { screen: '', menu: null } }
  const result = await drop.handleFileDrop({ paths: ['/a/b.mp4'], position: { x: 5, y: 5 } }, { doc: docAt([[5, 5, el.drawer.screen]]), win: mac })
  assert.equal(result, 'terminal')
  assert.deepEqual(asked, ['chat'])
  assert.deepEqual(sent, [{ action: 'input', session_id: 'chat', data: '/a/b.mp4 ' }])
})
test('drop on a chat appends the paths to its draft and focuses the field', async () => {
  const el = page()
  useStore.getState().setSessionInput('chat', 'What is in')
  const result = await drop.handleFileDrop({ paths: ['/Users/max/Desktop/My Clip.mp4'], position: { x: 40, y: 50 } }, { doc: docAt([[40, 50, el.chatTranscript]]), win: mac })
  assert.equal(result, 'draft')
  assert.equal(useStore.getState().sessionInputs.chat, 'What is in "/Users/max/Desktop/My Clip.mp4" ')
  assert.deepEqual(sent, [], 'a chat drop sends nothing')
  el.chatField.value = useStore.getState().sessionInputs.chat
  await tick()
  assert.equal(el.chatField.focused, 1)
  assert.deepEqual(el.chatField.selection, [el.chatField.value.length, el.chatField.value.length])
})
test('a read-only chat still takes the path into its note draft', async () => {
  const el = page()
  useStore.setState((s) => ({ sessions: { ...s.sessions, chat: { ...s.sessions.chat, read_only: 1 } } }))
  assert.equal(await drop.handleFileDrop({ paths: ['/a'], position: { x: 1, y: 1 } }, { doc: docAt([[1, 1, el.chatField]]), win: mac }), 'draft')
  assert.equal(useStore.getState().sessionInputs.chat, '/a ')
})
test('drop on the composer under a terminal fills that session\'s draft', async () => {
  const el = page()
  assert.equal(await drop.handleFileDrop({ paths: ['/a/b.txt'], position: { x: 1, y: 1 } }, { doc: docAt([[1, 1, el.term.input]]), win: mac }), 'draft')
  assert.equal(useStore.getState().sessionInputs.term, '/a/b.txt ')
  assert.deepEqual(sent, [])
})
test('drop on the Home message box appends to the Home draft', async () => {
  const el = page()
  useExperienceMode.getState().setHomeDraft('Summarize')
  const result = await drop.handleFileDrop({ paths: ['/Users/max/a b.pdf', '/Users/max/c.pdf'], position: { x: 9, y: 9 } }, { doc: docAt([[9, 9, el.homeField]]), win: mac })
  assert.equal(result, 'home')
  assert.equal(useExperienceMode.getState().homeDraft, 'Summarize "/Users/max/a b.pdf" /Users/max/c.pdf ')
  await tick()
  assert.equal(el.homeField.focused, 1)
})
test('a drop anywhere else, without paths or without a position changes nothing', async () => {
  const el = page()
  const doc = docAt([[1, 1, el.sidebar], [2, 2, el.chatTranscript], [3, 3, el.emptyTile.children[0]]])
  assert.equal(await drop.handleFileDrop({ paths: ['/a'], position: { x: 1, y: 1 } }, { doc, win: mac }), 'ignored')
  assert.equal(await drop.handleFileDrop({ paths: ['/a'], position: { x: 77, y: 77 } }, { doc, win: mac }), 'ignored', 'no element under the pointer')
  assert.equal(await drop.handleFileDrop({ paths: [], position: { x: 2, y: 2 } }, { doc, win: mac }), 'ignored')
  assert.equal(await drop.handleFileDrop({ position: { x: 2, y: 2 } }, { doc, win: mac }), 'ignored')
  assert.equal(await drop.handleFileDrop({ paths: ['/a'] }, { doc, win: mac }), 'ignored')
  assert.equal(await drop.handleFileDrop({ paths: ['/a'], position: { x: 3, y: 3 } }, { doc, win: mac }), 'ignored', 'the session of that tile is gone')
  assert.equal(await drop.handleFileDrop(undefined, { doc, win: mac }), 'ignored')
  assert.deepEqual(sent, [])
  assert.deepEqual(useStore.getState().sessionInputs, {})
  assert.equal(useExperienceMode.getState().homeDraft, '')
  assert.deepEqual(useStore.getState().notifications, [])
})

// ── Listening ────────────────────────────────────────────────────────────
function fakeShell() {
  const handlers = new Map()
  let removed = 0
  return {
    handlers,
    get removed() { return removed },
    listen: async (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name); removed += 1 } },
    emit: (name, payload) => handlers.get(name)?.({ event: name, id: 1, payload }),
  }
}
test('install: listens to the four drag events and removes them again', async () => {
  const shell = fakeShell()
  const uninstall = drop.installDesktopFileDrop({ listen: shell.listen, doc: docAt([]), win: mac })
  await tick()
  assert.deepEqual([...shell.handlers.keys()].sort(), ['tauri://drag-drop', 'tauri://drag-enter', 'tauri://drag-leave', 'tauri://drag-over'])
  assert.deepEqual(drop.DRAG_EVENTS, { enter: 'tauri://drag-enter', over: 'tauri://drag-over', drop: 'tauri://drag-drop', leave: 'tauri://drag-leave' })
  uninstall()
  assert.equal(shell.handlers.size, 0)
  assert.equal(shell.removed, 4)
})
test('install: removed before the listeners are ready still cleans up', async () => {
  const shell = fakeShell()
  drop.installDesktopFileDrop({ listen: shell.listen, doc: docAt([]), win: mac })()
  await tick()
  assert.equal(shell.handlers.size, 0)
  assert.equal(shell.removed, 4)
})
test('install: a browser without the shell installs nothing', () => {
  assert.equal(typeof drop.installDesktopFileDrop(), 'function')
  drop.installDesktopFileDrop()()
})
test('install: a drop event delivers the paths; hovering marks the chat under the pointer', async () => {
  const el = page()
  const shell = fakeShell()
  const marks = []
  const win = { ...mac, dispatchEvent: (event) => marks.push(event.detail.sessionId) }
  const doc = docAt([[10, 10, el.chatTranscript], [20, 20, el.term.screen], [30, 30, el.sidebar], [40, 40, el.homeField]])
  const uninstall = drop.installDesktopFileDrop({ listen: shell.listen, doc, win })
  await tick()

  // Something that is not a file (dragged text) never marks a session.
  shell.emit('tauri://drag-enter', { paths: [], position: { x: 10, y: 10 } })
  shell.emit('tauri://drag-over', { position: { x: 10, y: 10 } })
  assert.deepEqual(marks, [])
  shell.emit('tauri://drag-leave', undefined)

  shell.emit('tauri://drag-enter', { paths: ['/a/b.mp4'], position: { x: 30, y: 30 } })
  shell.emit('tauri://drag-over', { position: { x: 10, y: 10 } })
  shell.emit('tauri://drag-over', { position: { x: 10, y: 10 } })
  shell.emit('tauri://drag-over', { position: { x: 20, y: 20 } }) // a terminal has no overlay
  shell.emit('tauri://drag-over', { position: { x: 40, y: 40 } })
  shell.emit('tauri://drag-over', { position: { x: 10, y: 10 } })
  shell.emit('tauri://drag-leave', undefined)
  assert.deepEqual(marks, ['chat', null, 'chat', null], 'one event per change, cleared when the drag leaves')

  shell.emit('tauri://drag-enter', { paths: ['/a/b.mp4'], position: { x: 10, y: 10 } })
  shell.emit('tauri://drag-drop', { paths: ['/a/b.mp4'], position: { x: 10, y: 10 } })
  await tick()
  assert.deepEqual(marks.slice(4), ['chat', null], 'the mark goes away with the drop')
  assert.equal(useStore.getState().sessionInputs.chat, '/a/b.mp4 ')

  shell.emit('tauri://drag-drop', { paths: ['/a/b.mp4'], position: { x: 20, y: 20 } })
  await tick()
  assert.deepEqual(sent, [{ action: 'input', session_id: 'term', data: '/a/b.mp4 ' }])
  uninstall()
})
