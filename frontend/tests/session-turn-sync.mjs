// Real UI/queue/WebSocket reducer; isolated transport, never the user's PTY.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/session-turn-sync/', import.meta.url).pathname
await mkdir(out, { recursive: true })
try {
  for (const view of ['board', 'session-s']) {
    const f = await createTourFixture(browser, {
      theme: 'dark', settings: { product_tour_version: '2' },
      workspaces: [{ id: 'w', name: 'Example', path: '/isolated/example' }],
      sessions: [{ id: 's', workspace_id: 'w', name: 'Session s', cli_type: 'codex',
        status: 'running', agentState: 'working', pty_alive: true, session_type: 'worker', tags: [] }],
      messages: { s: [
        { id: 'user', role: 'user', content: 'hey was geht', created_at: '2026-11-06T22:35:27Z' },
        { id: 'answer', role: 'assistant', content: 'Hey! Alles entspannt, und bei dir?', created_at: '2026-11-06T22:35:32Z' },
      ] },
      storage: {
        'ive.experience-mode.v1': { mode: 'dev', provider: 'codex' },
        'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s'], showHome: false, activeNavGroup: 'work' },
        'ive.grid-session-views': { s: 'chat' }, 'cc-gridColumns': '1',
      },
    })
    try {
      const p = f.page
      await p.goto(`http://ive-guide.test/#${view}`)
      const composer = p.locator('.ive-session-composer textarea')
      await composer.waitFor()
      await p.waitForTimeout(300) // fixture's initial terminal resume
      f.controls.setSessionStatus('s', 'running')
      await p.getByText('Assistant is responding…', { exact: true }).waitFor()
      await composer.fill('Und jetzt die nächste Nachricht.')
      await composer.press('Enter')
      await p.getByText('Sends when Codex finishes this turn.', { exact: true }).waitFor()
      const sends = () => f.writes.filter(c => c.path === '/sessions/s/input')
      await p.waitForTimeout(1500)
      assert.equal(sends().length, 0, 'Visible assistant text alone must not release the queue')
      await p.screenshot({ path: `${out}${engine}-${view}-before.png`, fullPage: true })

      // Exactly the events emitted by the backend's recovered turn boundary.
      Object.assign(f.data.sessions[0], { status: 'idle', agentState: 'idle' })
      const started = Date.now()
      const delivered = p.waitForResponse(r => r.url().endsWith('/sessions/s/input') && r.request().method() === 'POST', { timeout: 5000 })
      f.controls.emit({ type: 'prompt_state', session_id: 's', state: 'idle' })
      f.controls.emit({ type: 'session_state', session_id: 's', state: 'idle', source: 'codex_transcript' })
      assert.equal((await delivered).status(), 200)
      assert(Date.now() - started < 4000, 'Queue releases promptly after the actual turn end')
      assert.equal(sends()[0].body.message, 'Und jetzt die nächste Nachricht.')
      assert.equal(sends()[0].body.prompt_reply, undefined, 'Normal text uses ordinary chat delivery')
      f.controls.reply('s', 'Die nächste Nachricht ist angekommen.')
      await p.locator('[data-chat-message-row]').getByText('Die nächste Nachricht ist angekommen.', { exact: true }).waitFor()
      await p.waitForTimeout(1800)
      assert.equal(sends().length, 1, 'No duplicate delivery on subsequent idle events or transcript refresh')
      assert.equal(await p.getByText('Assistant is responding…', { exact: true }).count(), 0)
      assert.equal(await composer.inputValue(), '')
      await p.getByText('Delivered', { exact: true }).waitFor({ state: 'hidden', timeout: 6000 })
      await p.screenshot({ path: `${out}${engine}-${view}-after.png`, fullPage: true })
      assert.equal(f.errors.length, 0, f.errors.join('\n'))
      console.log(`${engine} ${view}: recovered queue sent once in under 4s, idle after reply`)
    } finally {
      await f.context.close()
    }
  }
} finally {
  await browser.close()
}
