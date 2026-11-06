// Mobile composer regression: built UI, isolated HTTP and PTY fixtures only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const browser = await ({ chromium, webkit }[engine]).launch()
after(() => browser.close())
const output = process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-session-composer-mobile')
await mkdir(output, { recursive: true })

for (const [width, height, theme] of [[390, 844, 'light'], [320, 640, 'dark']]) {
  test(`mobile composer stays at least 16px with usable geometry at ${width}px in ${theme}`, async () => {
    const f = await createTourFixture(browser, {
      width, height, theme, touch: true,
      settings: { product_tour_version: '2', owner_name: 'Mobile composer QA' },
      workspaces: [{ id: 'w', name: 'Composer practice', path: '/isolated/composer' }],
      sessions: [{ id: 's', name: 'Weekly report', workspace_id: 'w', cli_type: 'claude', model: 'sonnet', status: 'idle', agentState: 'idle', pty_alive: true, session_type: 'worker', archived: 0, tags: [] }],
      messages: { s: [{ id: 'message', session_id: 's', role: 'assistant', content: 'Which files should the weekly report include?', created_at: '2025-01-01T00:00:00Z' }] },
      storage: {
        'ive.onboarding.v2.owner': 'complete',
        'ive.experience-mode.v1': { mode: 'chat', provider: 'claude' },
        'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s'], showHome: false, sessionFocus: true },
      },
    })
    try {
      const composer = f.page.locator('[data-session-view="s"] .ive-session-composer')
      const input = composer.locator('textarea')
      await input.waitFor({ state: 'visible' })
      await input.fill('Summarize the selected reports.\nInclude the key changes.')
      const geometry = await composer.evaluate(form => {
        const input = form.querySelector('textarea')
        const send = form.querySelector('[aria-label="Send message"]')
        const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
        return { font: parseFloat(getComputedStyle(input).fontSize), input: box(input), form: box(form), send: send && box(send), viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth }
      })
      const tag = `${engine}-${width}-${theme}`
      await writeFile(join(output, `${tag}.json`), JSON.stringify(geometry, null, 2))
      await f.page.screenshot({ path: join(output, `${tag}.png`) })
      assert.ok(geometry.font >= 16, `mobile text is ${geometry.font}px, below the existing 16px focus-size requirement`)
      assert.equal(geometry.overflow, false, 'no horizontal page overflow')
      assert.ok(geometry.input.x >= 0 && geometry.input.right <= width + 1, 'text field fits the phone width')
      assert.ok(geometry.form.bottom <= height + 1, 'composer stays within the viewport')
      assert.ok(geometry.send && geometry.send.width >= 40 && geometry.send.height >= 40, 'send remains a usable touch target')
      assert.deepEqual(f.errors, [])
      assert.equal(f.writes.some(call => call.path.endsWith('/input')), false, 'typing the draft does not submit it')
      assert.equal(await composer.getByRole('button', { name: 'Terminal', exact: true }).count(), 0, 'Chat has no inactive terminal toggle')
      const mode = f.page.getByRole('group', { name: 'Experience mode', exact: true }).filter({ visible: true }).first()
      await mode.getByRole('button', { name: 'Dev', exact: true }).click()
      await composer.getByRole('button', { name: 'Terminal', exact: true }).waitFor({ state: 'visible' })
      await mode.getByRole('button', { name: 'Chat', exact: true }).click()
      await composer.getByRole('button', { name: 'Terminal', exact: true }).waitFor({ state: 'detached' })
      assert.equal(await input.inputValue(), 'Summarize the selected reports.\nInclude the key changes.', 'mode switches preserve the phone draft')
    } finally { await f.context.close() }
  })
}
