// The app in a desktop-sized browser against an isolated Vite server with a
// mocked API and WebSocket (same idea as phone-keyboard.mjs). No backend, no
// PTY, no provider. Used by desktop-file-drop.mjs and session-steps.mjs.
//
//   const app = await startMockApp(t, { sessions, messages })
//   const { page, frames } = await app.open({ hash: '#session-s0', mode: 'dev' })
//
// `frames` collects every WebSocket frame the page sends.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { TOUR_VERSION } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
export const workspace = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }

export async function startMockApp(t, { sessions = [], messages = {}, port = 5196 } = {}) {
  const cache = await mkdtemp(join(tmpdir(), 'ive-mock-app-vite-'))
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(cache, 'cache'),
    server: { host: '127.0.0.1', port, strictPort: false, open: false }, logLevel: 'error',
  })
  t.after(async () => { await server.close(); await rm(cache, { recursive: true, force: true }) })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())

  // initScript(arg) runs before the app, e.g. to stand in for the desktop shell.
  async function open({ hash = '#home', mode = 'dev', desk = null, viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1, initScript = null, initArg = null } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: 'reduce', serviceWorkers: 'block' })
    t.after(() => context.close())
    await context.addInitScript(({ mode, desk }) => {
      localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
      localStorage.setItem('ive_client_name', 'Mock app test')
      localStorage.setItem('cc-soundEnabled', '0')
      localStorage.setItem('ive.onboarding.v2.owner', 'complete')
      if (!localStorage.getItem('ive.experience-mode.v1')) localStorage.setItem('ive.experience-mode.v1', JSON.stringify({ mode }))
      if (desk && !localStorage.getItem('ive.operator-desk')) localStorage.setItem('ive.operator-desk', JSON.stringify(desk))
    }, { mode, desk })
    if (initScript) await context.addInitScript(initScript, initArg)
    const frames = []
    await context.routeWebSocket('**/ws', (socket) => socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      frames.push(msg)
      if (!['start_pty', 'resize', 'resume_pty', 'claim_geometry'].includes(msg.action)) return
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: '\x1b[H\x1b[2J' + 'mocked terminal\r\n$ ' })), 30)
    }))
    await context.route('**/api/**', async (route) => {
      const req = route.request(), p = new URL(req.url()).pathname.slice(4), method = req.method()
      const rows = /^\/sessions\/([^/]+)\/messages$/.exec(p)
      let value = []
      if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'Mock app test' }
      else if (p === '/sidechat/options') value = { providers: [{ id: 'claude', label: 'Claude Code', installed: true, models: [] }], accounts: [] }
      else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : null }
      else if (p === '/settings' || p.endsWith('/brainstormer')) value = {}
      else if (p === '/workspaces') value = [workspace]
      else if (p === '/sessions') value = sessions
      else if (rows) value = messages[rows[1]] || []
      else if (p === '/cli-info/features') value = cliFeatures
      else if (p === '/cli-info') value = { available_clis: { claude: true }, version: 'test' }
      else if (p.endsWith('/files')) value = { items: [] }
      else if (p.endsWith('/output')) value = { output: '', screen: '', menu: null }
      else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
      else if (p === '/overview') value = { workspace_total: 1, detail_limit: 5, workspaces: [] }
      else if (method !== 'GET') value = {}
      await route.fulfill({ json: value })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(url + hash)
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    return { page, context, frames, errors }
  }
  return { url, browser, open }
}
