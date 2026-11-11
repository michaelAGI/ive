// The "Steps" switch of a session (formerly "Details"): it expands every
// intermediate step of the agent, so it only exists once the conversation has
// a step, and it looks pressed while it is on. Checked in the app header
// (full session view) and in the strip of an overview tile. Isolated Vite
// server, mocked API and WebSocket.
//
//   node --test tests/session-steps.mjs
//   IVE_QA_BROWSER=webkit node --test tests/session-steps.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startMockApp } from './mock-app.mjs'

const session = (id, name) => ({
  id, workspace_id: 'ws', name, cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true,
  session_type: 'worker', archived: 0, tags: [],
})
const sessions = [session('steps', 'With steps'), session('empty', 'Empty'), session('talk', 'Only talk'), session('thought', 'Empty thinking')]
const row = (sid, id, role, content, second) => ({ id, session_id: sid, role, content: typeof content === 'string' ? content : JSON.stringify(content), created_at: `2026-01-01T00:00:0${second}Z` })
const messages = {
  steps: [
    row('steps', 'u', 'user', 'Find the weekly report.', 0),
    row('steps', 'a1', 'assistant', [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls reports', description: 'List the reports' } }], 1),
    row('steps', 'r1', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'weekly.md' }], 2),
    row('steps', 'a2', 'assistant', 'The report is weekly.md.', 3),
  ],
  talk: [
    row('talk', 'u', 'user', 'Say hello.', 0),
    row('talk', 'a', 'assistant', 'Hello.', 1),
  ],
  // Thinking without text is not shown, so there is nothing to expand.
  thought: [
    row('thought', 'u', 'user', 'Say hello.', 0),
    row('thought', 'a0', 'assistant', [{ type: 'thinking', thinking: '' }], 1),
    row('thought', 'a', 'assistant', 'Hello.', 2),
  ],
}
const desk = (activeSessionId, sessionFocus = true) => ({ activeWorkspaceId: 'ws', activeSessionId, openTabs: sessions.map((s) => s.id), showHome: false, sessionFocus })
const look = (button) => button.evaluate((el) => { const style = getComputedStyle(el); return `${style.color} on ${style.backgroundColor}` })
// The look once it has left `before` (a style change needs a frame to show).
async function lookAfter(button, before) {
  const el = await button.elementHandle()
  await button.page().waitForFunction(([el, before]) => {
    const style = getComputedStyle(el)
    return `${style.color} on ${style.backgroundColor}` !== before
  }, [el, before], { timeout: 3000 }).catch(() => {})
  return look(button)
}

test('session: the Steps switch', async (t) => {
  const app = await startMockApp(t, { sessions, messages, port: 5195 })

  for (const mode of ['chat', 'dev']) {
    await t.test(`${mode} header: absent without steps`, async () => {
      for (const id of ['empty', 'talk', 'thought']) {
        const { page, errors } = await app.open({ hash: `#session-${id}`, mode, desk: desk(id) })
        const actions = page.locator('[data-session-header-actions]')
        await actions.waitFor()
        await page.locator(`[data-session-view="${id}"] form[data-chat-composer] textarea`).waitFor()
        if (id !== 'empty') await page.locator(`[data-session-view="${id}"]`).getByText('Hello.', { exact: true }).waitFor()
        assert.equal(await actions.getByRole('button', { name: 'Steps', exact: true }).count(), 0, `${id}: nothing to expand, no switch`)
        assert.equal(await page.getByRole('button', { name: /^(Details|Show activity details)$/ }).count(), 0, `${id}: the old name is gone`)
        assert.deepEqual(errors, [])
      }
    })

    await t.test(`${mode} header: present with steps, pressed while on`, async () => {
      const { page, errors } = await app.open({ hash: '#session-steps', mode, desk: desk('steps') })
      const button = page.locator('[data-session-header-actions]').getByRole('button', { name: 'Steps', exact: true })
      await button.waitFor()
      assert.equal(await button.getAttribute('title'), 'Show every step the agent took')
      assert.equal((await button.innerText()).trim(), 'Steps', 'the label is visible at this width')
      assert.equal(await button.getAttribute('aria-pressed'), 'false')
      const view = page.locator('[data-session-view="steps"]')
      assert.equal(await view.locator('.ive-activity-steps').count(), 0, 'steps start collapsed')
      await page.mouse.move(600, 500)
      const off = await look(button)

      await button.click()
      await page.mouse.move(600, 500) // not the hover look
      assert.equal(await button.getAttribute('aria-pressed'), 'true')
      await view.locator('.ive-activity-steps pre').first().waitFor()
      assert.equal(await view.locator('.ive-conversation-activity-toggle').getAttribute('aria-expanded'), 'true')
      const on = await lookAfter(button, off)
      assert.notEqual(on, off, 'pressed looks different')
      assert.doesNotMatch(on, /on rgba\(0, 0, 0, 0\)$/, 'pressed has a filled background')

      await button.click()
      assert.equal(await button.getAttribute('aria-pressed'), 'false')
      await view.locator('.ive-activity-steps').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    })
  }

  await t.test('overview tile: the strip shows Steps only for the session with steps', async () => {
    const { page, errors } = await app.open({
      hash: '#board', mode: 'dev', desk: desk('steps', false),
      initScript: () => {
        localStorage.setItem('ive.grid-session-views', JSON.stringify({ steps: 'chat', empty: 'chat', talk: 'chat', thought: 'chat' }))
        localStorage.setItem('cc-gridColumns', '1')
      },
    })
    const tile = (id) => page.locator(`[data-session-view="${id}"]`)
    for (const id of ['steps', 'empty', 'talk', 'thought']) await tile(id).locator('form[data-chat-composer]').waitFor({ state: 'attached' })
    const button = tile('steps').getByRole('button', { name: 'Steps', exact: true })
    await button.waitFor()
    assert.equal(await button.getAttribute('title'), 'Show every step the agent took')
    for (const id of ['empty', 'talk', 'thought']) {
      assert.equal(await tile(id).getByRole('button', { name: 'Steps', exact: true }).count(), 0, `${id}: no switch`)
      assert.equal(await tile(id).getByRole('button', { name: 'History', exact: true }).count(), 1, `${id}: the strip itself is there`)
    }
    assert.equal(await page.getByRole('button', { name: /^(Details|Show activity details)$/ }).count(), 0)
    await page.mouse.move(5, 5)
    const off = await look(button)
    await button.click()
    await page.mouse.move(5, 5)
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await tile('steps').locator('.ive-activity-steps pre').first().waitFor()
    const on = await lookAfter(button, off)
    assert.notEqual(on, off, 'pressed looks different')
    assert.doesNotMatch(on, /on rgba\(0, 0, 0, 0\)$/, 'pressed has a filled background')
    assert.deepEqual(errors, [])
  })
})
