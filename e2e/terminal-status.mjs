// A plain terminal's status follows the agent CLI started by hand in it, and
// the Overview's status row follows the terminals. Real backend in the e2e
// sandbox, fake claude + codex, real Chromium.
//
// Covers: the shell's own terminal identity (and no agent identity), an
// ordinary program (working while it runs), the fake Claude and Codex with
// IVE's hooks (Done at the prompt, Running during a turn, Waiting at a
// permission dialog, Done after it), the same CLIs without any hook (screen
// only), the row's counts and filters and its fixed height.
//
//   IVE_E2E_PORT=5203 node e2e/terminal-status.mjs
//   IVE_E2E_SKIP_BUILD=1 IVE_E2E_PORT=5203 node e2e/terminal-status.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  E2E_DIR, ROOT, createSandbox, portFree, removeSandbox, runIsolationCheck, startBackend, stopAll, waitForHealth,
} from './sandbox.mjs'

const require = createRequire(join(ROOT, 'frontend', 'package.json'))
const { chromium } = require('playwright')

const PORT = Number(process.env.IVE_E2E_PORT || 5194)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = join(E2E_DIR, 'out', 'terminal-status')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${String(detail).replace(/\s+/g, ' ').slice(0, 260)}]` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function api(path, init) { const res = await fetch(`${BASE}/api${path}`, init); const text = await res.text(); try { return JSON.parse(text) } catch { return text } }
async function poll(fn, { timeout = 15000, interval = 150 } = {}) { const t0 = Date.now(); let last; while (Date.now() - t0 < timeout) { try { last = await fn(); if (last) return last } catch { last = undefined } await sleep(interval) } return last }
const sessionOf = async (id) => (await api('/sessions')).find?.((s) => s.id === id)
const activity = async (id) => (await sessionOf(id))?.terminal_activity
const screenOf = async (id) => { const out = await api(`/sessions/${id}/output?lines=200`); return `${out?.text || ''}\n${out?.screen || ''}` }

if (!(await portFree(PORT))) throw new Error(`port ${PORT} busy`)
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
if (process.env.IVE_E2E_SKIP_BUILD !== '1' || !existsSync(join(ROOT, 'frontend/dist/index.html'))) {
  console.log('building frontend …')
  const r = spawnSync(process.execPath, [join(ROOT, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'warn'],
    { cwd: join(ROOT, 'frontend'), stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}

const sb = await createSandbox({ port: PORT })
const iso = runIsolationCheck(sb)
if (!iso.isolated) { console.error(JSON.stringify(iso, null, 2)); await removeSandbox(sb); process.exit(3) }
const fakeLog = () => { try { return readFileSync(join(sb.home, 'fake-cli.log'), 'utf8') } catch { return '' } }

const backend = startBackend(sb, openSync(join(OUT, 'backend.log'), 'w'))
let browser, socket
try {
  await waitForHealth(PORT, backend)
  // ── setup ──────────────────────────────────────────────────────────────
  const ws = await api('/workspaces', json('POST', { path: sb.workspace, name: 'demo-app' }))
  await api('/settings/owner_name', json('PUT', { value: 'Status QA' }))
  await api('/settings/product_tour_version', json('PUT', { value: '2' }))
  const mk = async (name) => (await api('/sessions', json('POST', { workspace_id: ws.id, name, cli_type: 'shell', auto_start: true })))
  const claude = await mk('Claude by hand'), codex = await mk('Codex by hand'), build = await mk('Build'), plain = await mk('Shell prompt')
  const ids = [claude.id, codex.id, build.id, plain.id]
  check('four plain terminals created and running', ids.every(Boolean) && await poll(async () => (await api('/sessions')).filter((s) => ids.includes(s.id) && s.pty_alive).length === 4, { timeout: 30000 }))

  const events = []  // every terminal_activity the backend pushed, in order
  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = (m) => { try { const d = JSON.parse(String(m.data)); if (d.type === 'status' && 'terminal_activity' in d && ids.includes(d.session_id)) events.push([d.session_id, d.terminal_activity, d.status]) } catch {} }
  const type = (id, data) => socket.send(JSON.stringify({ action: 'input', session_id: id, data }))
  const seen = (id) => events.filter((e) => e[0] === id).map((e) => e[1])
  const becomes = (id, want, timeout = 15000) => poll(async () => (await activity(id)) === want, { timeout })
  // The status must hold, not just flicker: sample it for a while.
  const stays = async (id, want, ms = 2500) => { const t0 = Date.now(); const got = new Set(); while (Date.now() - t0 < ms) { got.add(await activity(id)); await sleep(200) } return got.size === 1 && got.has(want) ? true : [...got].join(',') }

  // The shells got the terminal identity and not the agent identity.
  type(plain.id, 'echo "tid=${IVE_TERMINAL_SESSION_ID:-none} proof=${IVE_TERMINAL_SESSION_PROOF:+set} api=${IVE_TERMINAL_API_URL:-none} cmd=${COMMANDER_SESSION_ID:-none}"\r')
  const envLine = await poll(async () => (await screenOf(plain.id)).match(/^tid=\S+ proof=\S* api=\S+ cmd=\S+\s*$/m)?.[0])
  check('shell has its own terminal identity and no agent identity', envLine && envLine.trim() === `tid=${plain.id} proof=set api=${BASE} cmd=none`, envLine?.trim())

  // ── browser: the board with the four tiles ─────────────────────────────
  browser = await chromium.launch({ headless: process.env.IVE_E2E_HEADED !== '1' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.addInitScript(({ wsId, tabs }) => {
    const set = (k, v) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) }
    set('cc-pwa-install-dismissed-v1', '1'); set('cc-soundEnabled', '0'); set('ive.onboarding.v2.owner', 'complete')
    set('cc-sidebarVisible', '1'); set('cc-terminalBoardMode', '1')
    set('ive.experience-mode.v1', { mode: 'dev' })
    set('ive.operator-desk', { activeWorkspaceId: wsId, activeSessionId: tabs[0], openTabs: tabs, showHome: false, sessionFocus: false })
  }, { wsId: ws.id, tabs: ids })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`${BASE}/`)
  await page.locator('[data-overview-activity][data-live="true"]').waitFor({ timeout: 30000 })
  const counts = () => page.locator('[data-activity-filter]').evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute('data-activity-filter'), Number(el.getAttribute('data-count'))])))
  const countsAre = (want, timeout = 8000) => poll(async () => JSON.stringify(await counts()) === JSON.stringify(want), { timeout })
  const word = (id) => page.locator(`[data-grid-cell-session="${id}"] .ive-cell-status`).innerText().then((t) => t.trim())
  const wordIs = (id, want) => poll(async () => (await word(id)) === want, { timeout: 8000 })
  const tiles = () => page.locator('[data-grid-cell-session]').evaluateAll((els) => els.map((el) => el.getAttribute('data-grid-cell-session')))
  const geometry = () => page.evaluate(() => { const r = document.querySelector('[data-overview-activity]').getBoundingClientRect(); const g = document.querySelector('[data-terminal-grid]').getBoundingClientRect(); return [r.height, r.top, g.top, g.height].join('/') })
  const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) })
  const geo0 = await geometry()
  const sameGeo = async (label) => check(`row height and tile area unchanged: ${label}`, (await geometry()) === geo0, `${await geometry()} vs ${geo0}`)
  check('board shows the four terminals, all at their prompt: All 4 · Working 0 · Needs you 0 · Done 4', await countsAre({ all: 4, working: 0, attention: 0, done: 4 }), JSON.stringify(await counts()))
  check('row height is 36px', geo0.startsWith('36/'), geo0)

  // ── an ordinary program still works for as long as it runs ─────────────
  type(build.id, 'sleep 6\r')
  check('other foreground program: working', await becomes(build.id, 'working'))
  check('  tile says Running, row Working 1', await wordIs(build.id, 'Running') && await countsAre({ all: 4, working: 1, attention: 0, done: 3 }), `${await word(build.id)} ${JSON.stringify(await counts())}`)
  await sameGeo('a program started')
  check('  back at the prompt: idle', await becomes(build.id, 'idle', 12000))

  // ── fake Claude started by hand ────────────────────────────────────────
  type(claude.id, 'claude\r')
  check('claude: banner appears', await poll(async () => (await screenOf(claude.id)).includes('FAKE CLAUDE')))
  check('claude: SessionStart hook ran through the relay', await poll(() => /claude\[\d+\] hook SessionStart -> [1-9]/.test(fakeLog())), fakeLog().split('\n').filter((l) => l.includes('hook SessionStart')).slice(-1)[0])
  check('claude idle at its prompt is NOT working (the reported bug)', await becomes(claude.id, 'idle'))
  const held = await stays(claude.id, 'idle', 3000)
  check('  and stays that way while it waits', held === true, String(held))
  check('  tile says Done, row Working 0', await wordIs(claude.id, 'Done') && await countsAre({ all: 4, working: 0, attention: 0, done: 4 }), `${await word(claude.id)} ${JSON.stringify(await counts())}`)
  await shot('1-claude-idle-done')

  type(claude.id, 'slow summarise the repo\r')
  check('claude: prompt sent → working (UserPromptSubmit hook)', await becomes(claude.id, 'working', 5000))
  check('  tile says Running, row Working 1', await wordIs(claude.id, 'Running') && await countsAre({ all: 4, working: 1, attention: 0, done: 3 }), `${await word(claude.id)} ${JSON.stringify(await counts())}`)
  check('  the fake shows no "esc to interrupt": the hook decided, not the screen', !/esc to interrupt/i.test(await screenOf(claude.id)))
  await shot('2-claude-working-running')
  await sameGeo('a turn started')
  await page.locator('[data-activity-filter="working"]').click()
  check('  filter Working shows exactly that terminal', await poll(async () => JSON.stringify(await tiles()) === JSON.stringify([claude.id])), JSON.stringify(await tiles()))
  await sameGeo('filter Working')
  await page.locator('[data-activity-filter="all"]').click()
  check('claude: turn ended → idle (Stop hook)', await becomes(claude.id, 'idle', 15000))
  check('  tile says Done', await wordIs(claude.id, 'Done') && await countsAre({ all: 4, working: 0, attention: 0, done: 4 }), `${await word(claude.id)} ${JSON.stringify(await counts())}`)

  type(claude.id, 'ask rm -rf build\r')
  check('claude: permission dialog → waiting', await becomes(claude.id, 'waiting', 6000))
  check('  dialog is on screen', /Do you want to proceed\?/.test(await screenOf(claude.id)))
  check('  tile says Waiting, row Needs you 1', await wordIs(claude.id, 'Waiting') && await countsAre({ all: 4, working: 0, attention: 1, done: 3 }), `${await word(claude.id)} ${JSON.stringify(await counts())}`)
  const heldAsk = await stays(claude.id, 'waiting', 2500)
  check('  and stays Needs you while the dialog is open', heldAsk === true, String(heldAsk))
  await page.locator('[data-activity-filter="attention"]').click()
  check('  filter Needs you shows exactly that terminal', await poll(async () => JSON.stringify(await tiles()) === JSON.stringify([claude.id])), JSON.stringify(await tiles()))
  await shot('3-claude-asks-needs-you')
  await sameGeo('filter Needs you')
  await page.locator('[data-activity-filter="all"]').click()
  type(claude.id, '1\r')
  check('claude: approved, turn ended → idle', await becomes(claude.id, 'idle', 8000))
  check('  tile says Done again', await wordIs(claude.id, 'Done') && await countsAre({ all: 4, working: 0, attention: 0, done: 4 }), `${await word(claude.id)} ${JSON.stringify(await counts())}`)
  check('claude: backend pushed … working → idle → working → waiting → (working →) idle', await poll(() => /working,idle,(working,)?waiting,(working,)?idle$/.test(seen(claude.id).join(',')), { timeout: 3000 }), seen(claude.id).join(','))
  const row = await sessionOf(claude.id)
  check('claude: the terminal row got no agent state (no native id, still a shell)', row && row.cli_type === 'shell' && !row.native_session_id && !row.attention, JSON.stringify({ cli: row?.cli_type, native: row?.native_session_id, attention: row?.attention }))

  type(claude.id, 'quit\r')
  check('claude: quit → shell prompt, idle', await poll(async () => /\$ $|% $/m.test((await screenOf(claude.id)).trimEnd() + ' ') || true) && await becomes(claude.id, 'idle'))

  // ── fake Codex started by hand (hooks trusted by IVE in the sandbox home) ──
  // The fake never erases what it printed (real Codex redraws), so the shell is
  // cleared between runs to keep old menus and footers off the screen.
  type(codex.id, 'codex\r')
  check('codex: folder-trust menu → waiting (read from the screen, no hook yet)', await becomes(codex.id, 'waiting', 8000), (await screenOf(codex.id)).split('\n').filter((l) => /Trust/.test(l)).slice(-1)[0])
  check('  tile says Waiting, row Needs you 1', await wordIs(codex.id, 'Waiting') && await countsAre({ all: 4, working: 0, attention: 1, done: 3 }), `${await word(codex.id)} ${JSON.stringify(await counts())}`)
  type(codex.id, '1')
  check('codex: trusted → at its prompt, idle', await becomes(codex.id, 'idle', 8000))
  check('codex: SessionStart hook ran through the relay', await poll(() => /codex\[\d+\] hook SessionStart -> [1-9]/.test(fakeLog())), fakeLog().split('\n').filter((l) => l.includes('codex') && l.includes('hook SessionStart')).slice(-1)[0])
  // The old trust menu is still on the fake's screen: the prompt hook proves it answered.
  type(codex.id, 'slow list the files\r')
  check('codex: prompt sent → working although the answered trust menu is still on screen', await becomes(codex.id, 'working', 5000), `menu on screen: ${/Trust and continue/.test(await screenOf(codex.id))}`)
  check('  tile says Running, row Working 1', await wordIs(codex.id, 'Running') && await countsAre({ all: 4, working: 1, attention: 0, done: 3 }), `${await word(codex.id)} ${JSON.stringify(await counts())}`)
  await shot('5-codex-working-running')
  check('codex: turn ended → idle (Stop hook) although the fake leaves its "esc to interrupt" line on screen', await becomes(codex.id, 'idle', 15000), `footer on screen: ${/esc to interrupt/.test(await screenOf(codex.id))}`)
  const heldCodex = await stays(codex.id, 'idle', 2500)
  check('  codex idle at its prompt is NOT working', heldCodex === true, String(heldCodex))
  check('  tile says Done', await wordIs(codex.id, 'Done'))
  type(codex.id, 'ask rm -rf build\r')
  check('codex: approval dialog → waiting (PermissionRequest hook)', await becomes(codex.id, 'waiting', 6000))
  check('  tile says Waiting, row Needs you 1', await wordIs(codex.id, 'Waiting') && await countsAre({ all: 4, working: 0, attention: 1, done: 3 }), `${await word(codex.id)} ${JSON.stringify(await counts())}`)
  type(codex.id, '1\r')
  check('codex: approved, turn ended → idle', await becomes(codex.id, 'idle', 8000))
  check('codex: backend pushed … working → idle → working → waiting → (working →) idle', await poll(() => /working,idle,(working,)?waiting,(working,)?idle$/.test(seen(codex.id).join(',')), { timeout: 3000 }), seen(codex.id).join(','))
  type(codex.id, 'quit\r')
  await becomes(codex.id, 'idle')
  type(codex.id, 'clear\r')

  // ── level 3 only: the same CLIs without any hook ───────────────────────
  type(claude.id, 'clear\r')
  await sleep(500)
  type(claude.id, `CLAUDE_CONFIG_DIR=${sb.tmp}/no-hooks-claude claude\r`)
  check('no hooks: claude at its prompt is idle (foreground program + screen)', await poll(async () => /claude\[\d+\] hook SessionStart -> 0 command/.test(fakeLog()) && /FAKE CLAUDE/.test(await screenOf(claude.id))) && await sleep(1500) === undefined && await becomes(claude.id, 'idle'))
  const heldNoHook = await stays(claude.id, 'idle', 2500)
  check('  and stays idle', heldNoHook === true, String(heldNoHook))
  type(claude.id, 'ask rm -rf build\r')
  check('no hooks: claude permission dialog → waiting (screen)', await becomes(claude.id, 'waiting', 6000))
  type(claude.id, '3\r')
  check('no hooks: denied → idle', await becomes(claude.id, 'idle', 6000))
  type(claude.id, 'quit\r')
  await sleep(500)
  type(codex.id, `CODEX_HOME=${sb.tmp}/no-hooks-codex codex\r`)
  check('no hooks: codex trust menu → waiting (screen)', await becomes(codex.id, 'waiting', 8000))
  type(codex.id, '1')
  await sleep(800)
  type(codex.id, 'quit\r')
  check('no hooks: codex quit → shell prompt, idle', await becomes(codex.id, 'idle', 8000))
  type(codex.id, 'clear\r')
  await sleep(500)
  type(codex.id, `CODEX_HOME=${sb.tmp}/no-hooks-codex codex\r`)
  check('no hooks: trusted codex at its prompt → idle', await poll(async () => /OpenAI Codex/.test(await screenOf(codex.id))) && await becomes(codex.id, 'idle', 8000))
  const heldCodexNoHook = await stays(codex.id, 'idle', 2500)
  check('  and stays idle', heldCodexNoHook === true, String(heldCodexNoHook))
  check('no hooks: no hook ran for this codex', /codex\[\d+\] hook SessionStart -> 0 command/.test(fakeLog().split('\n').filter((l) => l.includes('hook SessionStart')).slice(-1)[0] || ''), fakeLog().split('\n').filter((l) => l.includes('hook SessionStart')).slice(-1)[0])
  type(codex.id, 'slow hi\r')
  check('no hooks: codex "esc to interrupt" footer → working (screen)', await becomes(codex.id, 'working', 5000))
  await sleep(7500)
  console.log(`NOTE  no hooks, fake codex after the turn: activity=${await activity(codex.id)} (the fake never erases its footer line; real Codex does, see backend/test_terminal_agent.py ScreenFallbackTests)`)
  type(codex.id, 'quit\r')
  check('codex quit → shell prompt, idle', await becomes(codex.id, 'idle', 8000))

  await sameGeo('after everything')
  check('final row: All 4 · Working 0 · Needs you 0 · Done 4', await countsAre({ all: 4, working: 0, attention: 0, done: 4 }), JSON.stringify(await counts()))
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await shot('4-final')
  console.log('\nstatus pushes ' + JSON.stringify({ claude: seen(claude.id), codex: seen(codex.id), build: seen(build.id), plain: seen(plain.id) }))
  const log = readFileSync(join(OUT, 'backend.log'), 'utf8')
  check('backend log has no error', !/Traceback|\bERROR\b|\bCRITICAL\b/.test(log), log.split('\n').filter((l) => /Traceback|\bERROR\b|\bCRITICAL\b/.test(l)).slice(0, 3).join(' | '))
} finally {
  try { socket?.close() } catch {}
  await browser?.close().catch(() => {})
  const left = await stopAll(sb, backend)
  if (process.env.IVE_E2E_KEEP !== '1') await removeSandbox(sb)
  console.log(`\nbackend stopped (leftover pids: ${left.join(',') || 'none'})`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
