// Overview grid: browser regression with an isolated Vite server and fully
// mocked API + WebSocket (same mocks as terminal-open.mjs). No real backend,
// PTY or session is touched.
//
// Checks (the fit rule at the top of src/components/chat/Terminal.jsx)
//   1. At 1440x900, 1920x1080, 1280x800 and in a manual 3-column grid every
//      board tile holds its whole terminal: no horizontal overflow, the
//      character grid is not wider than the tile, every row is visible, the
//      PTY has exactly xterm's cols x rows, the font is 13px or, only where
//      80x16 would not fit, smaller down to the floor (9px, 8px in tiny
//      tiles). No per-tile status line / prompt box (the opened session has
//      it).
//   2. Board <-> opened session 5x: the PTY only ever gets the two expected
//      sizes (tile, full view), one resize per switch; tiles that were not
//      opened keep their size. The session drawer fits its box as well.
//   3. Custom grid template: a new or newly opened session always lands
//      somewhere visible (first free cell, else Session level + notice).
//   4. Board <-> opened session with a Claude-like TUI (normal buffer, long
//      scrollback, spinner redrawing every 100 ms): the new placement is on
//      screen at its final size in the first frame, the live bottom is
//      shown, xterm and PTY always have the same size, the TUI frame is
//      intact after the redraws, and the wheel scrolls back inside a tile
//      (never sideways).
//
//   node tests/overview-grid.mjs
//   IVE_SHOT_DIR=../review-grid/after node tests/overview-grid.mjs
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
// Seed the current tour version so the first-run tour does not cover the app.
import { TOUR_VERSION, tourStorageKey } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))

const shotDir = resolve(process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-overview-grid'))
const strict = process.env.IVE_STRICT !== '0'
const port = Number(process.env.IVE_TEST_PORT || 5186)
await mkdir(shotDir, { recursive: true })

const testDir = await mkdtemp(join(tmpdir(), 'ive-grid-vite-'))
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: join(testDir, 'node_modules', '.vite'),
  server: { host: '127.0.0.1', port, strictPort: true, open: false },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()

const results = []
const failures = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const mkSession = (i, extra = {}) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [], ...extra,
})

function tuiFrame(name, cols, rows) {
  const inner = Math.max(0, cols - 2)
  const title = ` ${name} · PTY ${cols}x${rows} `.slice(0, inner)
  const top = '╭' + title + '─'.repeat(Math.max(0, inner - title.length)) + '╮'
  const bottom = '╰' + '─'.repeat(inner) + '╯'
  const line = (text = '') => '│' + text.slice(0, inner).padEnd(inner, ' ') + '│'
  const body = []
  for (let r = 0; r < rows - 3; r++) body.push(line(r === 0 ? ' Welcome to the mocked agent.' : r === rows - 4 ? ' last body row' : ''))
  const prompt = '> '.padEnd(cols, ' ').slice(0, cols)
  return '\x1b[?1049h\x1b[H\x1b[2J' + [top, ...body, bottom].join('\r\n') + '\r\n' + prompt + `\x1b[${rows};3H`
}

// Claude Code-like output: no alternate screen, so history lands in xterm's
// scrollback; the prompt box at the bottom is redrawn in place (Ink erases
// its last frame line by line, then writes the new one).
const inkHistory = (name) => {
  let history = ` ${name} · Claude-like TUI\r\n`
  for (let i = 0; i < 400; i++) history += `history line ${i} ${'·'.repeat((i % 7) * 15)}\r\n`
  return history
}
function inkFrame(cols, status) {
  const w = cols - 1
  return '╭' + '─'.repeat(w - 2) + '╮\r\n│ > ' + ' '.repeat(w - 5) + '│\r\n╰' + '─'.repeat(w - 2) + '╯\r\n  ' + status
}
const INK_ERASE_FRAME = '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\r'

async function setup(viewport, { sessions, openTabs = [], theme = 'light', templates = [], activeTemplateId = null, ink = false, gridColumns = 0 }) {
  // The Ink case runs without reduced motion: its global 0.01ms transitions
  // delay every size change by a frame or two, which is not what users see.
  // IVE_DPR=2 emulates a Retina screen. Use it with IVE_QA_BROWSER=webkit
  // when the screenshots matter: under Chromium's emulated scale factor
  // xterm's GPU canvas gets a backing store in CSS pixels and paints the
  // terminal at twice its size (the geometry checks are not affected; a real
  // scale factor, `--force-device-scale-factor=2`, paints correctly).
  const context = await browser.newContext({ viewport, reducedMotion: ink ? 'no-preference' : 'reduce', deviceScaleFactor: Number(process.env.IVE_DPR || 1) })
  await context.addInitScript(({ theme, gridColumns }) => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('ive_client_name', 'Grid QA')
    localStorage.setItem('cc-soundEnabled', '0')
    // The board with terminal tiles only exists in the Dev experience.
    localStorage.setItem('ive.experience-mode.v1', JSON.stringify({ mode: 'dev' }))
    localStorage.setItem('cc-terminalBoardMode', '1')
    localStorage.setItem('ive-theme.v2', theme)
    if (gridColumns) localStorage.setItem('cc-gridColumns', String(gridColumns))
    else localStorage.removeItem('cc-gridColumns')
    localStorage.removeItem('cc-activeGridTemplateIds')
    localStorage.removeItem('ive.terminal-drawer')
  }, { theme, gridColumns })
  const ptyMsgs = []
  const state = { sessions: [...sessions], created: 0, templates: JSON.parse(JSON.stringify(templates)) }
  const ptySize = {}
  const timers = []
  await context.routeWebSocket('**/ws', (socket) => {
    socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!['start_pty', 'resize', 'resume_pty'].includes(msg.action)) return
      ptyMsgs.push({ action: msg.action, id: msg.session_id, cols: msg.cols, rows: msg.rows, t: Date.now() })
      const s = state.sessions.find((x) => x.id === msg.session_id)
      if (!ink) {
        setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: tuiFrame(s?.name || msg.session_id, msg.cols, msg.rows) })), 30)
        return
      }
      // Like the backend: same size is a no-op (no SIGWINCH, no redraw).
      const id = msg.session_id
      const prev = ptySize[id]
      const changed = !prev || prev.cols !== msg.cols || prev.rows !== msg.rows
      ptySize[id] = { cols: msg.cols, rows: msg.rows }
      socket.send(JSON.stringify({ type: 'terminal_geometry', session_id: id, authoritative: true, changed, cols: msg.cols, rows: msg.rows }))
      const out = (data) => socket.send(JSON.stringify({ type: 'output', session_id: id, data }))
      if (!prev) {
        setTimeout(() => out(inkHistory(s?.name) + inkFrame(msg.cols, '? for shortcuts')), 30)
        let tick = 0
        timers.push(setInterval(() => {
          tick++
          out(INK_ERASE_FRAME + (tick % 10 === 0 ? `output line ${tick}\r\n` : '') + inkFrame(ptySize[id].cols, `✻ Working ${tick}`))
        }, 100))
      } else if (changed) {
        // SIGWINCH with another width: like Claude Code, clear the screen and
        // the scrollback and print the transcript again for the new width.
        out('\x1b[2J\x1b[3J\x1b[H' + inkHistory(s?.name) + inkFrame(msg.cols, '? for shortcuts'))
      }
    })
  })
  await context.route('**/api/**', async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.slice(4), method = req.method()
    let value = []
    if (p === '/extensions') value = { edition: 'integrated-dev', extensions: [{ id: 'sandbox' }] }
    else if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'QA' }
    else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : 'qa' }
    else if (p === '/settings') value = {}
    else if (p === '/workspaces') value = [ws]
    else if (p === '/sessions' && method === 'GET') value = state.sessions
    else if (p === '/grid-templates' && method === 'GET') value = state.templates
    else if (p.startsWith('/grid-templates/') && method === 'PUT') {
      const id = p.split('/')[2]
      const t = state.templates.find((x) => x.id === id)
      if (t) Object.assign(t, req.postDataJSON() || {})
      value = t || {}
    }
    else if (p === '/cli-info/features') value = cliFeatures
    else if (p === '/cli-info') value = { available_clis: { claude: true, codex: true }, version: 'QA' }
    else if (p.endsWith('/brainstormer')) value = {}
    else if (p.endsWith('/files')) value = { items: [] }
    else if (p.endsWith('/output')) value = { output: '' }
    else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
    else if (p === '/overview') value = { workspace_total: 1, detail_limit: 5, workspaces: [{ ...ws, sessions: { total: state.sessions.length, by_status: {} }, blocked_sessions: { total: 0, items: [] }, test_queue: { depth: 0, running_total: 0, running: null }, open_tasks: { total: 0, items: [] }, active_research: { total: 0, items: [] } }] }
    else if (method !== 'GET') value = {}
    await route.fulfill({ json: value })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (e) => { errors.push(e.message); if (process.env.IVE_DEBUG) console.log(e.stack) })
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
  await page.waitForTimeout(600)
  if (openTabs.length) {
    await page.evaluate(async ({ sessions, openTabs, templates, activeTemplateId }) => {
      const store = (await import('/src/state/store.js')).default
      const { startedSessions } = await import('/src/lib/terminalWriters.js')
      openTabs.forEach((id) => startedSessions.add(id))
      store.setState({
        sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), openTabs,
        activeSessionId: openTabs[0], activeWorkspaceId: 'ws', showHome: false, sessionFocus: false,
        gridLayout: 'equal', gridTemplates: templates, activeGridTemplateId: activeTemplateId,
      })
    }, { sessions, openTabs, templates, activeTemplateId })
    await page.waitForTimeout(1500)
  }
  return { context, page, ptyMsgs, errors, state, stopOutput: () => timers.forEach(clearInterval) }
}

// Everything that decides whether a box (tile, drawer, full view) holds its
// whole terminal. `pty` is the size the client last sent for the session.
async function tileGeometry(page, id, ptyMsgs = null) {
  const g = await page.evaluate(async (id) => {
    const { terminalControls } = await import('/src/lib/terminalWriters.js')
    const cell = document.querySelector(`[data-session-view="${id}"], [data-grid-cell-session="${id}"]`)
    if (!cell) return { mounted: false }
    const r = cell.getBoundingClientRect()
    const screen = cell.querySelector('.xterm-screen')
    const xterm = cell.querySelector('.xterm')
    const host = xterm?.parentElement
    const wrapper = host?.parentElement
    const grid = cell.parentElement
    const size = terminalControls.get(id)?.getSize?.()
    const wr = wrapper?.getBoundingClientRect()
    const sr = screen?.getBoundingClientRect()
    const gr = grid.getBoundingClientRect()
    const cellW = sr && size ? sr.width / size.cols : 0
    const visibleCols = sr && wr && cellW ? Math.floor((Math.min(sr.right, wr.right, gr.right, innerWidth) - Math.max(sr.left, wr.left)) / cellW + 0.01) : 0
    const rowH = sr && size ? sr.height / size.rows : 0
    const visibleRows = sr && wr && rowH ? Math.floor((Math.min(sr.bottom, wr.bottom) - Math.max(sr.top, wr.top)) / rowH + 0.01) : 0
    return {
      mounted: true,
      visible: r.width > 50 && r.height > 50 && getComputedStyle(cell).display !== 'none' && !!wrapper,
      cell: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      box: wrapper ? { w: wrapper.clientWidth, h: wrapper.clientHeight } : null,
      size,
      fontSize: terminalControls.get(id)?.getFontSize?.() ?? null,
      visibleCols,
      visibleRows,
      // The wrapper cannot be scrolled sideways and has nothing to scroll to.
      overflowX: wrapper ? getComputedStyle(wrapper).overflowX : null,
      scrollW: wrapper ? wrapper.scrollWidth : null,
      clientW: wrapper ? wrapper.clientWidth : null,
      hostScrollW: host ? host.scrollWidth : null,
      hostClientW: host ? host.clientWidth : null,
      scrollLeft: wrapper ? wrapper.scrollLeft + host.scrollLeft : null,
      // The character grid lies inside the wrapper on every side.
      screenW: sr ? Math.round(sr.width * 10) / 10 : null,
      hClip: !!(sr && wr && (sr.right > wr.right + 0.5 || sr.left < wr.left - 0.5 || sr.right > gr.right + 1)),
      vClip: !!(sr && wr && (sr.bottom > wr.bottom + 1 || sr.top < wr.top - 1)),
      vScroll: wrapper ? wrapper.scrollHeight > wrapper.clientHeight + 2 : null,
      unusedCols: wr && sr && cellW ? Math.floor((wr.right - sr.right) / cellW) : null,
      unusedRows: wr && sr && rowH ? Math.floor((wr.bottom - sr.bottom) / rowH) : null,
      preview: !!host?.classList.contains('is-overview-preview'),
      composerShown: (() => { const c = cell.querySelector('[data-terminal-composer]'); return !!c && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0 })(),
      gridHScroll: grid.scrollWidth > grid.clientWidth + 2,
    }
  }, id)
  if (ptyMsgs) {
    const last = ptyMsgs.filter((m) => m.id === id).at(-1)
    g.pty = last ? { cols: last.cols, rows: last.rows } : null
  }
  return g
}
const dims = (g) => `${g.size?.cols}x${g.size?.rows} at ${g.fontSize}px in ${g.box?.w}x${g.box?.h}px`
// The fit rule, checked on one box. `tile`: board tile (8px floor when tiny, no prompt box).
function checkFits(tag, g, { tile = true } = {}) {
  const floor = tile && (g.box?.w < 360 || g.box?.h < 160) ? 8 : 9
  check(`${tag}: no horizontal overflow, cannot scroll sideways`, g.visible && g.overflowX === 'hidden' && g.scrollW <= g.clientW && g.hostScrollW <= g.hostClientW && g.scrollLeft === 0,
    `wrapper ${g.scrollW}/${g.clientW}px, host ${g.hostScrollW}/${g.hostClientW}px, overflow-x ${g.overflowX}`)
  check(`${tag}: character grid not wider than the box, every column visible`, g.visible && !g.hClip && g.screenW <= g.clientW && g.visibleCols === g.size.cols, `grid ${g.screenW}px of ${g.clientW}px, ${g.visibleCols} of ${g.size?.cols} columns visible`)
  check(`${tag}: every row visible, no vertical scrollbar`, g.visible && !g.vClip && !g.vScroll && g.visibleRows === g.size.rows, `${g.visibleRows} of ${g.size?.rows} rows visible`)
  check(`${tag}: PTY has xterm's cols x rows`, !!g.pty && g.pty.cols === g.size.cols && g.pty.rows === g.size.rows, `PTY ${g.pty?.cols}x${g.pty?.rows}, xterm ${dims(g)}`)
  check(`${tag}: font 13px, smaller only where 80x16 would not fit, never below ${floor}px`,
    g.fontSize <= 13 && g.fontSize >= floor && (g.fontSize === 13 || g.fontSize === floor || (g.size.cols >= 80 && g.size.rows >= 16 && (g.size.cols <= 81 || g.size.rows <= 17))), dims(g))
  check(`${tag}: at least 80x16 unless the font is at its ${floor}px floor`, g.fontSize === floor || (g.size.cols >= 80 && g.size.rows >= 16), dims(g))
  check(`${tag}: the box is used (at most 2 columns / 1 row spare)`, g.unusedCols <= 2 && g.unusedRows <= 1, `spare ${g.unusedCols} columns, ${g.unusedRows} rows`)
  if (tile) check(`${tag}: no status line / prompt box in the tile`, !g.composerShown)
}
// Lazy tiles adopt their terminal once they are near the viewport. Returns
// whether the tile showed it on its own. A tile that did not (TerminalSlot's
// lazy adoption, not a sizing question) is selected, which always adopts the
// terminal, so that the sizing checks run on every tile.
async function showTile(page, id) {
  const has = () => page.evaluate((id) => !!document.querySelector(`[data-grid-cell-session="${id}"] .xterm`), id)
  await page.evaluate((id) => document.querySelector(`[data-grid-cell-session="${id}"]`)?.scrollIntoView({ block: 'nearest' }), id)
  await page.waitForTimeout(900)
  const shown = await has()
  if (!shown) {
    await store(page, (s, id) => s.getState().setActiveSession(id), id)
    await page.waitForTimeout(1200)
  }
  return shown
}

const shot = (page, name) => page.screenshot({ path: join(shotDir, `${name}.png`) })
const sizesOf = (msgs, id, from = 0) => msgs.filter((m) => m.id === id).slice(from).map((m) => `${m.cols}x${m.rows}`)
// Number of times consecutive messages for a session carry another size.
const sizeChanges = (msgs, id, from = 0) => {
  const all = msgs.filter((m) => m.id === id)
  let prev = null, changes = 0
  all.forEach((m, i) => {
    const key = `${m.cols}x${m.rows}`
    if (i >= from && prev && key !== prev) changes++
    prev = key
  })
  return changes
}
const store = (page, fn, arg) => page.evaluate(async ({ src, arg }) => {
  const s = (await import('/src/state/store.js')).default
  // eslint-disable-next-line no-new-func
  return new Function('store', 'arg', `return (${src})(store, arg)`)(s, arg)
}, { src: fn.toString(), arg })

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1280x800', width: 1280, height: 800 },
]
const four = [0, 1, 2, 3].map((i) => mkSession(i))
const six = [0, 1, 2, 3, 4, 5].map((i) => mkSession(i))
const sizesSeen = []

try {
  // 1. Every board tile holds its whole terminal.
  for (const vp of viewports) {
    for (const theme of ['light', 'dark']) {
      const { context, page, errors, ptyMsgs } = await setup(vp, { sessions: four, openTabs: four.map((s) => s.id), theme })
      await shot(page, `${vp.name}-overview-${theme}`)
      if (theme === 'light') {
        for (const [i, s] of four.entries()) {
          check(`${vp.name} tile ${i + 1}: shows its terminal without being selected first`, await showTile(page, s.id))
          const g = await tileGeometry(page, s.id, ptyMsgs)
          sizesSeen.push(`${vp.name}: ${dims(g)}`)
          checkFits(`${vp.name} tile ${i + 1}`, g)
        }
        check(`${vp.name}: the grid itself does not scroll sideways`, !(await tileGeometry(page, 's0')).gridHScroll)
      }
      check(`${vp.name} ${theme}: no page errors`, errors.length === 0, errors.join(' | '))
      await context.close()
    }
  }
  // 1b. Manual 3-column grid: narrow tiles, where 80 columns need the font
  //     floor. Whatever fits is taken; the terminal is never wider than its tile.
  for (const vp of [viewports[0], viewports[2]]) {
    const { context, page, errors, ptyMsgs } = await setup(vp, { sessions: six, openTabs: six.map((s) => s.id), gridColumns: 3 })
    await shot(page, `${vp.name}-3-columns`)
    const columns = await page.evaluate(() => new Set([...document.querySelectorAll('[data-terminal-grid] > [data-grid-cell-session]')].map((c) => Math.round(c.getBoundingClientRect().left))).size)
    check(`${vp.name} 3 columns: the grid has 3 columns`, columns === 3, `${columns}`)
    for (const [i, s] of six.entries()) {
      check(`${vp.name} 3 columns tile ${i + 1}: shows its terminal without being selected first`, await showTile(page, s.id))
      const g = await tileGeometry(page, s.id, ptyMsgs)
      sizesSeen.push(`${vp.name} 3 columns: ${dims(g)}`)
      checkFits(`${vp.name} 3 columns tile ${i + 1}`, g)
    }
    check(`${vp.name} 3 columns: no page errors`, errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // 2. Board <-> opened session: one resize per switch, two sizes in total.
  {
    const { context, page, ptyMsgs, errors } = await setup({ width: 1440, height: 900 }, { sessions: four, openTabs: four.map((s) => s.id) })
    // The opened session shows its terminal full size (the drawer's expand button).
    await store(page, (s) => s.getState().setTerminalExpanded('s1', true))
    await page.waitForTimeout(400)
    const startIdx = Object.fromEntries(four.map((s) => [s.id, ptyMsgs.filter((m) => m.id === s.id).length]))
    const tileBefore = await tileGeometry(page, 's1', ptyMsgs)
    const tileSize = `${tileBefore.size.cols}x${tileBefore.size.rows}`
    let fullSize = null
    for (let i = 0; i < 5; i++) {
      await store(page, (s) => s.getState().goSession('s1'))
      await page.waitForTimeout(900)
      if (i === 0) {
        await shot(page, 'toggle-session-level')
        const sg = await tileGeometry(page, 's1', ptyMsgs)
        fullSize = `${sg.size.cols}x${sg.size.rows}`
        sizesSeen.push(`1440x900 full view: ${dims(sg)}`)
        checkFits('opened session, full view', sg, { tile: false })
        check('opened session, full view: status line + prompt box shown, base font', sg.composerShown && sg.fontSize === 13 && !sg.preview, `font ${sg.fontSize}px`)
      }
      await store(page, (s) => s.getState().goOverview())
      await page.waitForTimeout(900)
    }
    await shot(page, 'toggle-back-in-overview')
    const seen = sizesOf(ptyMsgs, 's1', startIdx.s1)
    const focusedChanges = sizeChanges(ptyMsgs, 's1', startIdx.s1)
    const otherChanges = four.filter((s) => s.id !== 's1').map((s) => sizeChanges(ptyMsgs, s.id, startIdx[s.id]))
    console.log(`     s1 during 5 round trips: ${seen.length} size messages, ${focusedChanges} size changes, sizes ${[...new Set(seen)].join(' / ')}; others ${otherChanges.join(',')}`)
    check('toggle 5x: tile and full view are different sizes', fullSize && fullSize !== tileSize, `tile ${tileSize}, full ${fullSize}`)
    check('toggle 5x: the PTY only ever gets the two expected sizes', seen.every((k) => k === tileSize || k === fullSize), [...new Set(seen)].join(' / '))
    check('toggle 5x: one PTY size change per switch', focusedChanges === 10, `${focusedChanges} changes in 10 switches`)
    check('toggle 5x: tiles that were not opened keep their PTY size', otherChanges.every((n) => n === 0), otherChanges.join(','))
    checkFits('toggle 5x: tile back on the board', await tileGeometry(page, 's1', ptyMsgs))
    // The drawer (terminal under the chat) is a third, smaller box.
    await store(page, (s) => { s.getState().setTerminalExpanded('s1', false); s.getState().goSession('s1') })
    await page.waitForTimeout(900)
    await shot(page, 'session-drawer')
    {
      const dg = await tileGeometry(page, 's1', ptyMsgs)
      sizesSeen.push(`1440x900 drawer: ${dims(dg)}`)
      checkFits('opened session, drawer', dg, { tile: false })
    }
    check('toggle: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }

  // 3. Custom grid template: new / newly opened sessions stay visible.
  {
    const templates = [{
      id: 't1', workspace_id: 'ws', name: 'Pair', cols: 2,
      cells: [
        { id: 'c1', col: 1, row: 1, colSpan: 1, rowSpan: 1 },
        { id: 'c2', col: 2, row: 1, colSpan: 1, rowSpan: 1 },
        { id: 'c3', col: 1, row: 2, colSpan: 2, rowSpan: 1 },
      ],
      cell_assignments: { c1: 's0', c2: 's1' },
    }]
    const sessions = [...four.slice(0, 2), mkSession(4)]
    const { context, page, errors, state } = await setup({ width: 1440, height: 900 }, { sessions, openTabs: ['s0', 's1'], templates, activeTemplateId: 't1' })
    await shot(page, 'template-before')
    const visibleCell = (id) => page.evaluate((id) => {
      const el = document.querySelector(`[data-grid-cell-session="${id}"]`)
      if (!el) return false
      const r = el.getBoundingClientRect()
      return getComputedStyle(el).display !== 'none' && r.width > 50 && r.height > 50 && !!el.querySelector('.xterm')
    }, id)
    // New session (what NewSessionDialog does after the API call).
    await page.evaluate(async () => {
      const store = (await import('/src/state/store.js')).default
      store.getState().addSession({ id: 's100', workspace_id: 'ws', name: 'New agent', cli_type: 'claude', model: 'sonnet', status: 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }, { autoStart: false })
    })
    await page.waitForTimeout(1200)
    await shot(page, 'template-new-session')
    check('template: new session visible', await visibleCell('s100'))
    const assigned = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().gridTemplates[0].cell_assignments)
    check('template: new session lands in the first free cell', assigned.c3 === 's100', JSON.stringify(assigned))
    check('template: assignment saved to the server', state.templates[0].cell_assignments?.c3 === 's100')
    // Back to the overview: all three cells filled, now open an existing session.
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goOverview())
    await page.waitForTimeout(600)
    await shot(page, 'template-overview-full')
    for (const id of ['s0', 's1', 's100']) {
      const g = await tileGeometry(page, id)
      check(`template overview: ${id} tile holds its whole terminal`, g.visible && g.fontSize >= 9 && !g.hClip && !g.vClip && g.scrollW <= g.clientW && g.visibleCols === g.size.cols && g.visibleRows === g.size.rows && !g.composerShown, `${dims(g)}, visible ${g.visibleCols}x${g.visibleRows}`)
    }
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().openSession('s4', { autoStart: false }))
    await page.waitForTimeout(1200)
    await shot(page, 'template-full-open-existing')
    const level = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().sessionFocus)
    check('template full: opened session visible', await visibleCell('s4'))
    check('template full: shown at Session level', level === true)
    const notice = await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().notifications.map((n) => n.message).join(' | '))
    check('template full: notice shown', /cell/i.test(notice) && /Agent 5/.test(notice), notice)
    // Back to the overview: the session must not vanish silently.
    await page.evaluate(async () => (await import('/src/state/store.js')).default.getState().goOverview())
    await page.waitForTimeout(600)
    await shot(page, 'template-full-back-to-overview')
    {
      const g = await tileGeometry(page, 's100')
      check('template overview after Session level: tile holds its whole terminal', g.visible && g.fontSize >= 9 && !g.hClip && !g.vClip && g.scrollW <= g.clientW && g.visibleCols === g.size?.cols && g.visibleRows === g.size?.rows, `${dims(g)}, visible ${g.visibleCols}x${g.visibleRows}`)
    }
    check('template: no page errors', errors.length === 0, errors.join(' | '))
    await context.close()
  }
  // 4. Board <-> opened session with a Claude-like TUI: the new placement is
  //    on screen at its final size in the first frame, at the live bottom,
  //    xterm and PTY agree, and the TUI frame is intact after the redraws.
  {
    const { context, page, ptyMsgs, errors, stopOutput } = await setup({ width: 1512, height: 945 }, { sessions: four, openTabs: four.map((s) => s.id), ink: true })
    await store(page, (s) => s.getState().setTerminalExpanded('s0', true))
    await page.waitForTimeout(600)
    const startIdx = ptyMsgs.filter((m) => m.id === 's0').length
    // Switch inside the page and measure the first two animation frames in
    // which the terminal is shown, i.e. what the user sees after the click.
    // (A terminal that changes its place stays transparent until it has
    // rendered at the size of its new box.)
    const switchAndSample = (action) => page.evaluate(async (action) => {
      const store = (await import('/src/state/store.js')).default
      const { terminalControls } = await import('/src/lib/terminalWriters.js')
      const sample = () => {
        const cell = document.querySelector('[data-session-view="s0"]')
        const xterm = cell.querySelector('.xterm')
        const host = xterm.parentElement
        const wrapper = host.parentElement
        const sr = xterm.querySelector('.xterm-screen').getBoundingClientRect()
        const wr = wrapper.getBoundingClientRect()
        const c = terminalControls.get('s0')
        const v = c.getViewport()
        return {
          hidden: getComputedStyle(host).opacity === '0',
          font: c.getFontSize(), size: c.getSize(), preview: host.classList.contains('is-overview-preview'),
          blankAbove: Math.round(sr.top - wr.top), blankBelow: Math.round(wr.bottom - sr.bottom), blankRight: Math.round(wr.right - sr.right),
          rowH: sr.height / c.getSize().rows, colW: sr.width / c.getSize().cols,
          atBottom: v.viewportY === v.baseY,
        }
      }
      store.getState()[action]('s0')
      // Let React commit first: a frame is painted only after the commit.
      await new Promise((r) => setTimeout(r, 0))
      const frames = []
      for (let i = 1; i <= 40 && frames.length < 2; i++) {
        await new Promise((r) => requestAnimationFrame(r))
        const f = sample()
        if (!f.hidden) frames.push({ ...f, frame: i })
      }
      return frames
    }, action)
    // The visible TUI rows after the last line of history output.
    const tail = () => page.evaluate(async () => {
      const { terminalControls } = await import('/src/lib/terminalWriters.js')
      return terminalControls.get('s0').getBufferLines().map((l) => l.text.trimEnd()).filter(Boolean).slice(-6)
    })
    const liveBottom = () => page.evaluate(async () => {
      const { terminalControls } = await import('/src/lib/terminalWriters.js')
      const v = terminalControls.get('s0').getViewport()
      return { ok: v.viewportY === v.baseY, detail: `viewport row ${v.viewportY} of ${v.baseY}` }
    })
    const lastPty = () => { const m = ptyMsgs.filter((x) => x.id === 's0').at(-1); return m ? `${m.cols}x${m.rows}` : null }
    const key = (f) => `${f.size.cols}x${f.size.rows}`
    const fmt = (f) => `frame ${f.frame}, font ${f.font}px, blank above ${f.blankAbove}px / below ${f.blankBelow}px / right ${f.blankRight}px, ${key(f)}${f.preview ? ', tile' : ''}${f.atBottom ? '' : ', scrolled up'}`
    // Fitted to its box: starts at the top, less than one row and three columns spare, nothing cut off.
    const fitted = (f) => f.blankAbove >= 0 && f.blankAbove <= 8 && f.blankBelow >= 0 && f.blankBelow <= f.rowH + 8 && f.blankRight >= 0 && f.blankRight <= f.colW * 3
    const tileSize = key((await switchAndSample('goOverview'))[0])
    let sessionSize = null
    for (let i = 0; i < 3; i++) {
      const s = await switchAndSample('goSession')
      sessionSize ||= key(s[0])
      check(`ink round ${i + 1}: opened session is shown promptly`, s.length === 2 && s[0].frame <= 8, `first shown in frame ${s[0]?.frame}`)
      s.forEach((f, n) => check(`ink round ${i + 1}: opened session in shown frame ${n + 1} (final size, base font, fitted, live bottom)`,
        key(f) === sessionSize && f.font === 13 && !f.preview && fitted(f) && f.atBottom, fmt(f)))
      await page.waitForTimeout(700)
      check(`ink round ${i + 1}: opened session, PTY has xterm's size`, lastPty() === sessionSize, `PTY ${lastPty()}, xterm ${sessionSize}`)
      { const b = await liveBottom(); check(`ink round ${i + 1}: opened session still follows the live output`, b.ok, b.detail) }
      if (i === 0) await shot(page, 'ink-session-level')
      const o = await switchAndSample('goOverview')
      check(`ink round ${i + 1}: board tile is shown promptly`, o.length === 2 && o[0].frame <= 8, `first shown in frame ${o[0]?.frame}`)
      o.forEach((f, n) => check(`ink round ${i + 1}: board tile in shown frame ${n + 1} (final size, fitted, live bottom)`,
        key(f) === tileSize && f.font <= 13 && f.font >= 8 && f.preview && fitted(f) && f.atBottom, fmt(f)))
      await page.waitForTimeout(700)
      check(`ink round ${i + 1}: board tile, PTY has xterm's size`, lastPty() === tileSize, `PTY ${lastPty()}, xterm ${tileSize}`)
      { const b = await liveBottom(); check(`ink round ${i + 1}: board tile still follows the live output`, b.ok, b.detail) }
    }
    await shot(page, 'ink-overview')
    check('ink: tile and opened session are different sizes', sessionSize !== tileSize, `tile ${tileSize}, opened ${sessionSize}`)
    {
      const rows = await tail()
      const boxTops = rows.filter((r) => r.startsWith('╭')).length
      check('ink: TUI frame intact in the tile after 3 round trips (one prompt box, status line last)', boxTops === 1 && /✻ Working \d+$/.test(rows.at(-1)), rows.map((r) => r.slice(0, 40)).join(' | '))
    }
    // The wheel scrolls the scrollback inside a tile, and never sideways.
    {
      const box = await page.locator('[data-session-view="s0"] .xterm-screen').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -600)
      await page.waitForTimeout(300)
      const back = await liveBottom()
      check('tile: the wheel scrolls back through the scrollback', !back.ok, back.detail)
      await page.mouse.wheel(900, 0)
      await page.waitForTimeout(200)
      const side = await tileGeometry(page, 's0')
      check('tile: a sideways wheel moves nothing', side.scrollLeft === 0 && !side.hClip, `scrollLeft ${side.scrollLeft}`)
      await page.mouse.wheel(0, 200000)
      await page.waitForTimeout(300)
      const live = await liveBottom()
      check('tile: the wheel returns to the live output', live.ok, live.detail)
    }
    await switchAndSample('goSession')
    await page.waitForTimeout(700)
    const rows = await tail()
    const boxTops = rows.filter((r) => r.startsWith('╭')).length
    check('ink: TUI frame intact in the opened session (one prompt box, status line last)', boxTops === 1 && /✻ Working \d+$/.test(rows.at(-1)), rows.map((r) => r.slice(0, 40)).join(' | '))
    const seen = sizesOf(ptyMsgs, 's0', startIdx)
    const changes = sizeChanges(ptyMsgs, 's0', startIdx)
    // 3 round trips and the last opening: 7 switches.
    check('ink: the PTY only ever got the two sizes, one change per switch', seen.every((k) => k === tileSize || k === sessionSize) && changes === 7 && lastPty() === sessionSize,
      `${changes} changes in 7 switches, sizes ${[...new Set(seen)].join(' / ')}, PTY ${lastPty()}`)
    check('ink: no page errors', errors.length === 0, errors.join(' | '))
    stopOutput()
    await context.close()
  }
} finally {
  await writeFile(join(shotDir, 'results.json'), JSON.stringify(results, null, 2))
  await browser.close()
  await server.close()
  await rm(testDir, { recursive: true, force: true })
}
console.log(`\nTerminal sizes:\n  ${[...new Set(sizesSeen)].join('\n  ')}`)
console.log(`${results.length - failures.length}/${results.length} checks passed. Screenshots: ${shotDir}`)
if (failures.length && strict) process.exitCode = 1
