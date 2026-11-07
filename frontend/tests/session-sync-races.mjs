import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/session-turn-sync/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const running = { status: 'running', agentState: 'working', pty_alive: true }
async function fixture() {
  const f = await createTourFixture(browser, {
    theme: 'dark', preserveRuntimeOnResume: true,
    settings: { product_tour_version: '2' },
    workspaces: [{ id: 'w', name: 'Example', path: '/isolated/example' }],
    sessions: [{ id: 's', workspace_id: 'w', name: 'Session s', cli_type: 'codex', session_type: 'worker', tags: [], ...running }],
    messages: { s: [{ id: 'm', role: 'assistant', content: 'First visible answer.', created_at: new Date().toISOString() }] },
    storage: {
      'ive.experience-mode.v1': { mode: 'dev', provider: 'codex' },
      'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s'], showHome: false, activeNavGroup: 'work' },
      'ive.grid-session-views': { s: 'chat' }, 'cc-gridColumns': '1',
    },
  })
  f.page.setDefaultTimeout(8000)
  await f.page.goto('http://ive-guide.test/#board')
  await f.page.locator('.ive-session-composer textarea').waitFor()
  await f.page.getByText('Assistant is responding…', { exact: true }).waitFor()
  return f
}

try {
  // A slow reconnect GET captured "working". The newer idle event must win.
  const f = await fixture()
  let release
  try {
    let entered
    const held = new Promise(resolve => { entered = resolve })
    const stale = structuredClone(f.data.sessions)
    await f.context.route('**/api/sessions', async route => {
      entered()
      await new Promise(resolve => { release = resolve })
      await route.fulfill({ json: stale })
    })
    f.controls.disconnect()
    await held
    Object.assign(f.data.sessions[0], { status: 'idle', agentState: 'idle' })
    f.controls.emit({ type: 'session_state', session_id: 's', state: 'idle', source: 'hook' })
    await f.page.getByText('Assistant is responding…', { exact: true }).waitFor({ state: 'hidden' })
    release()
    await f.page.waitForTimeout(1700)
    assert.equal(await f.page.getByText('Assistant is responding…', { exact: true }).count(), 0)
    await f.page.screenshot({ path: `${out}${engine}-late-reconnect-snapshot.png`, fullPage: true })
    assert.deepEqual(f.errors, [])
    console.log(`${engine}: late reconnect snapshot cannot overwrite completed turn`)
  } finally { release?.(); await f.context.close() }

  // No socket event at all: the periodic authoritative snapshot heals status,
  // including a question answered in the terminal while the client missed it.
  const missed = await fixture()
  try {
    Object.assign(missed.data.sessions[0], { status: 'idle', agentState: 'idle', attention: null })
    await missed.page.getByText('Assistant is responding…', { exact: true }).waitFor({ state: 'hidden', timeout: 8000 })
    assert.equal(missed.writes.filter(c => c.path === '/sessions/s/input').length, 0)
    assert.deepEqual(missed.errors, [])
    console.log(`${engine}: missed lifecycle event heals through shared snapshot polling`)
  } finally { await missed.context.close() }

  // Raw terminal Esc is shared with every chat, even while chat is unmounted.
  const g = await fixture()
  try {
    const p = g.page
    const composer = p.locator('.ive-session-composer textarea')
    await composer.fill('Only send after I resume.')
    await composer.press('Enter')
    await p.getByText('Sends when Codex finishes this turn.', { exact: true }).waitFor()
    await composer.fill('Preserve this unsent draft')
    await p.getByTitle('Switch to Terminal View', { exact: true }).click()
    await p.locator('.xterm').waitFor()
    Object.assign(g.data.sessions[0], { status: 'idle', agentState: 'idle' })
    g.controls.emit({ type: 'session_state', session_id: 's', state: 'idle', source: 'codex_transcript_interrupt', interrupted: true })
    await p.waitForTimeout(1800)
    assert.equal(g.writes.filter(c => c.path === '/sessions/s/input').length, 0)
    await p.getByTitle('Switch to Chat View', { exact: true }).click()
    await composer.waitFor()
    assert.equal(await composer.inputValue(), 'Preserve this unsent draft')
    await p.getByText('Paused because you stopped the agent.', { exact: true }).waitFor()
    await p.screenshot({ path: `${out}${engine}-terminal-interrupt-queue-paused.png`, fullPage: true })
    const resumed = p.waitForResponse(r => r.url().endsWith('/sessions/s/input') && r.request().method() === 'POST')
    await p.getByRole('button', { name: 'Send queued now', exact: true }).click()
    await resumed
    assert.equal(g.writes.filter(c => c.path === '/sessions/s/input').length, 1)
    assert.deepEqual(g.errors, [])
    console.log(`${engine}: terminal interrupt pauses chat queue across view changes; draft retained; explicit resume sends once`)
  } finally { await g.context.close() }

  // A re-opened socket must not drain a queue using cached idle state while
  // the backend snapshot is still pending (or its first request fails).
  const h = await fixture()
  let finish
  try {
    const p = h.page
    await p.locator('.ive-session-composer textarea').fill('Send after the fresh snapshot.')
    await p.locator('.ive-session-composer textarea').press('Enter')
    await p.getByText('Sends when Codex finishes this turn.', { exact: true }).waitFor()
    h.controls.setSessionStatus('s', 'idle')
    let entered, attempts = 0
    const held = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { finish = resolve })
    await h.context.route('**/api/sessions', async route => {
      attempts++
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'Temporary snapshot outage' } })
      entered()
      await gate
      await route.fulfill({ json: h.data.sessions })
    })
    h.controls.disconnect()
    await held
    await p.waitForTimeout(1700)
    assert.equal(h.writes.filter(c => c.path === '/sessions/s/input').length, 0)
    const delivered = p.waitForResponse(r => r.url().endsWith('/sessions/s/input') && r.request().method() === 'POST')
    finish()
    try { await delivered } catch (error) {
      console.log(JSON.stringify({ sessions: h.data.sessions, pty: h.data.pty,
        queue: await p.evaluate(() => localStorage.getItem('ive-composer-queue-v1')),
        status: await p.locator('[data-composer-queue]').innerText(), attempts }))
      await p.screenshot({ path: `${out}${engine}-retry-failure.png`, fullPage: true })
      throw error
    }
    assert.equal(h.writes.filter(c => c.path === '/sessions/s/input').length, 1)
    assert.ok(attempts >= 2, 'The failed snapshot was retried without restarting the terminal')
    console.log(`${engine}: reconnect queue waits for snapshot, retries failed snapshot, then sends once`)
  } finally { finish?.(); await h.context.close() }
} finally { await browser.close() }
