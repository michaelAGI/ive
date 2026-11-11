// Desktop app: a file dragged from Finder ends up as a path in the terminal
// or message field under the pointer (lib/desktopFileDrop.js). Isolated Vite
// server, mocked API and WebSocket, and a stand-in for the Tauri shell.
//
// What is real here: the app, its store and components, the real
// @tauri-apps/api/event module (listen -> invoke -> transformCallback) and
// the element lookup in a real browser layout. What is faked: the shell side.
// The stand-in follows tauri 2.12 (scripts/core.js, src/event/mod.rs): a
// listener is registered with `plugin:event|listen`, and an event reaches the
// page as runCallback(handlerId, { event, id, payload }). No native window,
// no AppKit drag session and no real drop position are involved, so the unit
// of the position (points on macOS) is taken from the wry source, not measured.
//
//   node --test tests/desktop-file-drop.mjs
//   IVE_QA_BROWSER=webkit node --test tests/desktop-file-drop.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startMockApp } from './mock-app.mjs'

const session = (id, name, extra = {}) => ({
  id, workspace_id: 'ws', name, cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true,
  session_type: 'worker', archived: 0, tags: [], ...extra,
})
const sessions = [
  session('chat', 'Chat session'),
  session('shell', 'Plain terminal', { cli_type: 'shell', status: 'running' }),
]
const messages = { chat: [
  { id: 'u', session_id: 'chat', role: 'user', content: 'Which clips are on the Desktop?', created_at: '2026-01-01T00:00:00Z' },
  { id: 'a', session_id: 'chat', role: 'assistant', content: 'Drop one here and I will look at it.', created_at: '2026-01-01T00:00:01Z' },
] }
const desk = (activeSessionId, showHome = false) => ({ activeWorkspaceId: 'ws', activeSessionId, openTabs: ['chat', 'shell'], showHome, sessionFocus: !showHome })

// Runs in the page before the app: the shell's side of the Tauri IPC.
function fakeShell({ platform }) {
  Object.defineProperty(navigator, 'platform', { get: () => platform })
  const callbacks = new Map()
  const listeners = {} // event -> { eventId: { target, handlerId } }
  const invoked = []
  let eventIds = 0
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    callbacks,
    transformCallback(callback, once = false) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0]
      callbacks.set(id, (data) => { if (once) callbacks.delete(id); return callback && callback(data) })
      return id
    },
    unregisterCallback(id) { callbacks.delete(id) },
    runCallback(id, data) { callbacks.get(id)?.(data) },
    async invoke(cmd, args = {}) {
      invoked.push(cmd)
      if (cmd === 'plugin:event|listen') {
        const id = ++eventIds
        ;(listeners[args.event] ||= {})[id] = { target: args.target, handlerId: args.handler }
        return id
      }
      if (cmd === 'plugin:event|unlisten') { delete listeners[args.event]?.[args.eventId]; return null }
      if (cmd === 'desktop_update_status') return { currentVersion: '0.0.0-test', automatic: false, version: null, downloaded: false }
      if (cmd === 'window_is_focused') return true
      return null
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, eventId) {
      const listener = listeners[event]?.[eventId]
      if (listener) callbacks.delete(listener.handlerId)
    },
  }
  window.__fakeShell = {
    invoked, listeners,
    // tauri emit_js: every listener of the event gets { event, id, payload }.
    emit(event, payload) {
      for (const [id, listener] of Object.entries(listeners[event] || {})) {
        window.__TAURI_INTERNALS__.runCallback(listener.handlerId, { event, id: Number(id), payload })
      }
    },
  }
}

// Wait for something the test process observes (WebSocket frames).
async function until(check, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)) }
  assert.fail(`not reached within ${timeout} ms: ${check}`)
}

const CLIP = '/Users/max/Desktop/My Clip (final).mp4'
const NOTES = '/Users/max/Desktop/notes.txt'

test('desktop app: files dropped from Finder', async (t) => {
  const app = await startMockApp(t, { sessions, messages })

  async function desktop(options, { platform = 'MacIntel', scale = 1 } = {}) {
    const opened = await app.open({ mode: 'dev', deviceScaleFactor: 2, initScript: fakeShell, initArg: { platform }, ...options })
    const { page } = opened
    await page.waitForFunction(() => ['tauri://drag-enter', 'tauri://drag-over', 'tauri://drag-drop', 'tauri://drag-leave']
      .every((name) => Object.keys(window.__fakeShell.listeners[name] || {}).length === 1))
    const emit = (event, payload) => page.evaluate(([event, payload]) => window.__fakeShell.emit(event, payload), [event, payload])
    // The centre of an element, as the shell reports it (`scale` 2: physical pixels at 2x).
    const at = async (locator, dx = 0.5, dy = 0.5) => {
      const box = await locator.boundingBox()
      return { x: (box.x + box.width * dx) * scale, y: (box.y + box.height * dy) * scale }
    }
    const dropOn = async (position, paths = [CLIP]) => {
      await emit('tauri://drag-enter', { paths, position })
      await emit('tauri://drag-over', { position })
      await emit('tauri://drag-drop', { paths, position })
    }
    const inputs = () => opened.frames.filter((frame) => frame.action === 'input')
    const focused = () => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}.${a.className}` : '' })
    return { ...opened, emit, at, dropOn, inputs, focused }
  }
  const settle = (page) => page.waitForTimeout(400)

  await t.test('the module listens through the real Tauri event API with the default target', async () => {
    const { page } = await desktop({ hash: '#home', desk: desk('chat', true) })
    const targets = await page.evaluate(() => ['tauri://drag-enter', 'tauri://drag-over', 'tauri://drag-drop', 'tauri://drag-leave']
      .map((name) => Object.values(window.__fakeShell.listeners[name])[0].target))
    assert.deepEqual(targets, Array(4).fill({ kind: 'Any' }), 'like the ive://open-panel listener: every target, so the main window\'s events arrive')
    assert.equal(await page.evaluate(() => window.devicePixelRatio), 2, 'a Retina-like display')
  })

  await t.test('(a) on a terminal: the quoted paths are typed into that session', async () => {
    const { page, at, dropOn, inputs, focused } = await desktop({ hash: '#session-shell', desk: desk('shell') })
    const screen = page.locator('[data-session-view="shell"] .xterm-screen')
    await page.waitForFunction(() => document.querySelector('[data-session-view="shell"] .xterm-screen')?.getBoundingClientRect().height > 100)
    await page.evaluate(() => document.activeElement?.blur())
    // Lower right of the terminal: half these coordinates would be another place.
    await dropOn(await at(screen, 0.8, 0.8), [CLIP, NOTES])
    await until(() => inputs().length > 0)
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
    assert.deepEqual(inputs(), [{ action: 'input', session_id: 'shell', data: `'${CLIP}' ${NOTES} ` }])
    assert.match(await focused(), /xterm-helper-textarea/, 'the keyboard is in the terminal that got the paths')
  })

  await t.test('(a) on the terminal drawer of a chat session: asked for an open question first, then typed', async () => {
    const { page, context, at, dropOn, inputs } = await desktop({ hash: '#session-chat', desk: desk('chat') })
    const asked = []
    await context.route('**/api/sessions/chat/output**', (route) => { asked.push(route.request().url()); return route.fulfill({ json: { output: '', screen: '', menu: null } }) })
    await page.locator('header').getByRole('button', { name: /^Terminal/ }).click()
    await page.waitForFunction(() => document.querySelector('[data-session-view="chat"] .xterm-screen')?.getBoundingClientRect().height > 40)
    await dropOn(await at(page.locator('[data-session-view="chat"] .xterm-screen')))
    await until(() => inputs().length > 0)
    assert.deepEqual(inputs(), [{ action: 'input', session_id: 'chat', data: `'${CLIP}' ` }])
    assert.ok(asked.some((url) => url.includes('permission_view=1')), 'the open-question check of typeInTerminalUnlessQuestion ran')
    assert.equal(await page.locator('[data-session-view="chat"] form[data-chat-composer] textarea').inputValue(), '', 'the chat draft is untouched')
  })

  await t.test('(a) overview: the tile under the pointer gets the paths, not its neighbour', async () => {
    const { page, at, dropOn, inputs } = await desktop({ hash: '#board', desk: { ...desk('chat'), sessionFocus: false } })
    const terminal = page.locator('[data-session-view="shell"] [data-terminal-session="shell"]').first()
    await page.waitForFunction(() => document.querySelector('[data-session-view="shell"] [data-terminal-session="shell"]')?.getBoundingClientRect().height > 100)
    const tile = await page.locator('[data-session-view="shell"]').boundingBox()
    const neighbour = await page.locator('[data-session-view="chat"]').boundingBox()
    assert.ok(tile.x >= neighbour.x + neighbour.width, 'the shell tile is to the right of the chat tile')
    // Half these coordinates (a position wrongly divided by the pixel ratio) is inside the neighbour.
    const position = await at(terminal, 0.5, 0.5)
    assert.ok(position.x / 2 > neighbour.x && position.x / 2 < neighbour.x + neighbour.width && position.y / 2 > neighbour.y && position.y / 2 < neighbour.y + neighbour.height)
    await dropOn(position)
    await until(() => inputs().length > 0)
    assert.deepEqual(inputs(), [{ action: 'input', session_id: 'shell', data: `'${CLIP}' ` }])
    // The tile's header belongs to its terminal.
    await dropOn({ x: tile.x + tile.width * 0.3, y: tile.y + 12 }, [NOTES])
    await until(() => inputs().length > 1)
    assert.deepEqual(inputs()[1], { action: 'input', session_id: 'shell', data: `${NOTES} ` })
  })

  await t.test('(b) on a chat: the paths are appended to its draft, the field has the cursor', async () => {
    const { page, emit, at, dropOn, inputs, focused } = await desktop({ hash: '#session-chat', desk: desk('chat') })
    const field = page.locator('[data-session-view="chat"] form[data-chat-composer] textarea')
    await field.fill('What is in')
    await page.evaluate(() => document.activeElement?.blur())
    const overTranscript = await at(page.locator('[data-session-view="chat"] .ive-conversation-transcript'))

    // While the file hovers, the chat shows where it will go.
    const overlay = page.locator('[data-session-view="chat"] [data-drop-overlay="path"]')
    await emit('tauri://drag-enter', { paths: [CLIP], position: { x: 20, y: 600 } })
    assert.equal(await overlay.count(), 0, 'over the sidebar nothing is marked')
    await emit('tauri://drag-over', { position: overTranscript })
    await overlay.waitFor()
    assert.equal((await overlay.innerText()).trim(), 'Drop to add the file path to your message')
    await emit('tauri://drag-leave', null)
    await overlay.waitFor({ state: 'detached' })
    assert.equal(await field.inputValue(), 'What is in', 'leaving without a drop changes nothing')

    await dropOn(overTranscript)
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
    assert.equal(await field.inputValue(), `What is in "${CLIP}" `)
    assert.equal(await overlay.count(), 0, 'the mark is gone after the drop')
    assert.match(await focused(), /^textarea/)
    assert.deepEqual(await field.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length]), Array(3).fill(`What is in "${CLIP}" `.length), 'cursor behind the path')

    // A second file, dropped on the message box itself.
    await dropOn(await at(field), [NOTES])
    await page.waitForFunction((want) => document.querySelector('[data-session-view="chat"] form[data-chat-composer] textarea').value === want, `What is in "${CLIP}" ${NOTES} `)
    assert.deepEqual(inputs(), [], 'a chat drop types nothing into a terminal')
  })

  await t.test('(c) on the Home message box: the paths are appended to the Home draft', async () => {
    const { page, at, dropOn, inputs, focused } = await desktop({ hash: '#home', desk: desk('chat', true) })
    const field = page.locator('[data-home-composer]')
    await field.fill('Summarize')
    await page.evaluate(() => document.activeElement?.blur())
    await dropOn(await at(field), [CLIP, NOTES])
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-home-composer'))
    assert.equal(await field.inputValue(), `Summarize "${CLIP}" ${NOTES} `)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ive.experience-mode.v1')).homeDraft), `Summarize "${CLIP}" ${NOTES} `, 'it is the stored Home draft')
    assert.match(await focused(), /^textarea/)
    assert.deepEqual(inputs(), [])
  })

  await t.test('(d) anywhere else: the drop is ignored', async () => {
    const { page, at, dropOn, inputs, errors } = await desktop({ hash: '#session-chat', desk: desk('chat') })
    const field = page.locator('[data-session-view="chat"] form[data-chat-composer] textarea')
    await field.fill('Keep me')
    for (const position of [await at(page.locator('#ive-project-sidebar'), 0.5, 0.75), await at(page.locator('header.ive-header'), 0.3, 0.5), { x: 5000, y: 5000 }]) {
      await dropOn(position)
    }
    // Events without files or without a position are not a file drop.
    await dropOn(await at(field), [])
    await page.evaluate(() => window.__fakeShell.emit('tauri://drag-drop', { paths: ['/a'] }))
    await page.evaluate(() => window.__fakeShell.emit('tauri://drag-drop', null))
    await settle(page)
    assert.equal(await field.inputValue(), 'Keep me')
    assert.deepEqual(inputs(), [])
    assert.equal(await page.locator('[data-drop-overlay]').count(), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ive.experience-mode.v1')).homeDraft || ''), '')
    assert.deepEqual(errors, [])
  })

  await t.test('Home: next to the message box is "anywhere else"', async () => {
    const { page, at, dropOn } = await desktop({ hash: '#home', desk: desk('chat', true) })
    const field = page.locator('[data-home-composer]')
    const box = await field.boundingBox()
    await dropOn({ x: box.x + box.width / 2, y: box.y - 40 })
    await dropOn(await at(page.locator('[data-home-screen]'), 0.98, 0.95))
    await settle(page)
    assert.equal(await field.inputValue(), '')
  })

  await t.test('Windows reports physical pixels: the position is divided by the pixel ratio', async () => {
    const { page, at, dropOn } = await desktop({ hash: '#home', desk: desk('chat', true) }, { platform: 'Win32', scale: 2 })
    const field = page.locator('[data-home-composer]')
    await dropOn(await at(field))
    await page.waitForFunction((want) => document.querySelector('[data-home-composer]').value === want, `"${CLIP}" `)
  })

  await t.test('a browser without the shell registers nothing and keeps its own drop', async () => {
    const { page, errors } = await app.open({ hash: '#session-chat', mode: 'dev', desk: desk('chat') })
    await page.locator('[data-session-view="chat"] form[data-chat-composer] textarea').waitFor()
    assert.equal(await page.evaluate(() => '__TAURI_INTERNALS__' in window || '__fakeShell' in window), false)
    // The HTML5 drag still raises the upload overlay of the chat.
    await page.locator('[data-session-view="chat"] .ive-conversation-transcript').dispatchEvent('dragover', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) })
    await page.locator('[data-session-view="chat"] [data-drop-overlay="upload"]').waitFor()
    assert.deepEqual(errors, [])
  })
})
