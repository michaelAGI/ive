// Phone: nothing raises the soft keyboard on its own. Opening a session (chat
// view or the remembered terminal view) and "New chat" leave every text field
// unfocused; a tap on the field focuses it. Isolated Vite server, mocked API
// and WebSocket, no backend.
//
//   node --test tests/phone-keyboard.mjs
//   IVE_QA_BROWSER=webkit node --test tests/phone-keyboard.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { TOUR_VERSION } from '../src/lib/onboarding.js'

const cliFeatures = JSON.parse(await readFile(new URL('./fixtures/cli-profiles.json', import.meta.url), 'utf8'))
const ws = { id: 'ws', name: 'IVE product', path: '/isolated/project', color: '#1647ff' }
const sessions = [0, 1].map((i) => ({
  id: `s${i}`, workspace_id: 'ws', name: `Agent ${i + 1}`, cli_type: 'claude', model: 'sonnet',
  status: i === 1 ? 'waiting' : 'running', pty_alive: true, session_type: 'worker', archived: 0, tags: [],
}))

test('phone: no automatic keyboard', async (t) => {
  const cache = await mkdtemp(join(tmpdir(), 'ive-phone-keyboard-vite-'))
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), cacheDir: join(cache, 'cache'),
    server: { host: '127.0.0.1', port: 5198, strictPort: false, open: false }, logLevel: 'error',
  })
  t.after(async () => { await server.close(); await rm(cache, { recursive: true, force: true }) })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  const browser = await (process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium).launch()
  t.after(() => browser.close())

  async function setup(mode) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
    t.after(() => context.close())
    await context.addInitScript((mode) => {
      localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
      localStorage.setItem('ive_client_name', 'Phone keyboard test')
      localStorage.setItem('cc-soundEnabled', '0')
      localStorage.setItem('ive.experience-mode.v1', JSON.stringify({ mode }))
    }, mode)
    await context.routeWebSocket('**/ws', (socket) => socket.onMessage((raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!['start_pty', 'resize', 'resume_pty', 'claim_geometry'].includes(msg.action)) return
      setTimeout(() => socket.send(JSON.stringify({ type: 'output', session_id: msg.session_id, data: '\x1b[H\x1b[2J' + 'mocked agent\r\n> ' })), 30)
    }))
    await context.route('**/api/**', async (route) => {
      const req = route.request(), p = new URL(req.url()).pathname.slice(4), method = req.method()
      let value = []
      if (p === '/whoami') value = { actor_kind: 'localhost', mode: 'full', label: 'Phone keyboard test' }
      else if (p === '/sidechat/options') value = { providers: [{ id: 'claude', label: 'Claude Code', installed: true, models: [] }], accounts: [] }
      else if (p.startsWith('/settings/')) value = { value: p.endsWith('/product_tour_version') ? String(TOUR_VERSION) : null }
      else if (p === '/settings' || p.endsWith('/brainstormer')) value = {}
      else if (p === '/workspaces') value = [ws]
      else if (p === '/sessions') value = sessions
      else if (p === '/cli-info/features') value = cliFeatures
      else if (p === '/cli-info') value = { available_clis: { claude: true }, version: 'test' }
      else if (p.endsWith('/files')) value = { items: [] }
      else if (p.endsWith('/output')) value = { output: '' }
      else if (p === '/runtime/status') value = { multiplayer: { enabled: false }, tunnel: { running: false } }
      else if (p === '/overview') value = { workspace_total: 1, detail_limit: 5, workspaces: [] }
      else if (method !== 'GET') value = {}
      await route.fulfill({ json: value })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    assert.equal(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), true, 'the test device must count as touch-only')
    return page
  }

  // A focused text field is what raises the soft keyboard.
  const typingField = (page) => page.evaluate(() => {
    const a = document.activeElement
    if (!a) return null
    const text = a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit'].includes(a.type))
    return text ? `${a.tagName}.${a.className}` : null
  })
  const settled = async (page, label) => {
    await page.waitForTimeout(700) // past the delayed focus requests (120 ms, two frames, start_pty)
    assert.equal(await typingField(page), null, `${label}: a text field took the focus`)
  }

  await t.test('Chat: opening a chat and New chat', async () => {
    const page = await setup('chat')
    await settled(page, 'after load')
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
    await page.getByRole('dialog', { name: 'Sidebar' }).getByRole('button', { name: /new chat/i }).first().tap()
    await settled(page, 'New chat')
    const sidebar = page.getByRole('dialog', { name: 'Sidebar' })
    const sidebarOpen = () => sidebar.evaluate((el) => el.getBoundingClientRect().right > 1).catch(() => false)
    // Already on Home the drawer stays open: close it on its backdrop.
    if (await sidebarOpen()) await page.touchscreen.tap(380, 600)
    await page.waitForFunction(() => { const el = document.querySelector('[role="dialog"][aria-label="Sidebar"]'); return !el || el.getBoundingClientRect().right <= 1 })
    // The field still works the moment the user taps it.
    await page.locator('[data-home-composer]').tap()
    assert.match(await typingField(page) || '', /^TEXTAREA/, 'a tap on the message field focuses it')
    await page.evaluate(() => document.activeElement?.blur())
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
    await sidebar.getByText('Agent 1', { exact: true }).first().tap()
    await page.waitForFunction(() => { const el = document.querySelector('[data-session-view="s0"]'); return el && getComputedStyle(el).opacity === '1' })
    await settled(page, 'opened a chat from the sidebar')
  })

  await t.test('Dev: session list, chat view and the remembered terminal view', async () => {
    const page = await setup('dev')
    await page.locator('[data-phone-overview]').waitFor()
    await page.locator('[data-phone-session="s0"]').tap()
    await settled(page, 'opened a session in chat view')
    await page.getByRole('button', { name: 'Terminal view' }).tap()
    await settled(page, 'switched to the terminal view')
    await page.getByRole('button', { name: 'Back to sessions' }).tap()
    await page.locator('[data-phone-session="s1"]').tap()
    await page.waitForFunction(() => document.querySelector('.ive-terminal-drawer .xterm-screen')?.getBoundingClientRect().height > 0)
    await settled(page, 'opened a session with the terminal view remembered')
  })
})
