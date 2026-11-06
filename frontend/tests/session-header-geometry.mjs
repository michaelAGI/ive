// Real built header, long names, and isolated API/PTY traffic. No provider starts.
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
const output = process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-session-header-geometry')
await mkdir(output, { recursive: true })
const processWrites = f => f.writes.filter(call => /\/sessions(?:\/quick|\/[^/]+\/(?:start|stop|restart|input))?$/.test(call.path))
const longName = 'Weekly operations review for the international customer success and product development teams'

async function inspectHeader(f, tag) {
  const header = f.page.locator('header.ive-header[data-session-header]')
  await header.waitFor({ state: 'visible' })
  const geometry = await header.evaluate(root => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
    const controls = [...root.querySelectorAll('button')].filter(el => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    }).map(el => {
      const r = rect(el)
      const points = [r.x + 3, r.x + r.width / 2, r.right - 3]
      const labels = [...el.querySelectorAll('.ive-header-btn-label')].map(rect).filter(label => label.width > 0 && label.height > 0)
      return { name: el.getAttribute('aria-label') || el.textContent.trim(), ...r,
        labelsFit: labels.every(label => label.x >= r.x - 1 && label.right <= r.right + 1),
        hit: points.every(x => el.contains(document.elementFromPoint(x, r.y + r.height / 2))) }
    })
    return { viewport: innerWidth, header: rect(root), controls, overflow: document.documentElement.scrollWidth > innerWidth }
  })
  await writeFile(join(output, `${tag}.json`), JSON.stringify(geometry, null, 2))
  await f.page.screenshot({ path: join(output, `${tag}.png`) })
  assert.equal(geometry.overflow, false, 'long names do not cause page overflow')
  assert.ok(geometry.controls.some(control => control.name === 'Chat') && geometry.controls.some(control => control.name === 'Dev'), 'both experience choices remain visible')
  for (const control of geometry.controls) {
    assert.ok(control.x >= geometry.header.x - 1 && control.right <= geometry.header.right + 1, `${control.name}: button fits inside the header`)
    assert.ok(control.hit, `${control.name}: left, center and right hit targets reach the intended button`)
    assert.ok(control.labelsFit, `${control.name}: visible label fits inside its clickable button`)
  }
  for (let i = 0; i < geometry.controls.length; i++) for (let j = i + 1; j < geometry.controls.length; j++) {
    const a = geometry.controls[i], b = geometry.controls[j]
    const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x)
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)
    assert.ok(overlapX <= 1 || overlapY <= 1, `${a.name} overlaps ${b.name}`)
  }
}

for (const width of [768, 900, 1280, 1440]) for (const mode of ['chat', 'dev']) {
  test(`${mode} session header keeps all controls clickable with long names at ${width}px`, async () => {
    const f = await createTourFixture(browser, {
      dist: process.env.IVE_QA_DIST || undefined, width, height: 900,
      workspaces: [{ id: 'w', name: `International workspace — ${longName}`, path: '/isolated/header-long-names' }],
      sessions: [{ id: 's', name: longName, workspace_id: 'w', cli_type: 'claude', model: 'sonnet', status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [] }],
      messages: { s: [
        { id: 'u', session_id: 's', role: 'user', content: 'Summarize this weekly report.', created_at: '2025-01-01T00:00:00Z' },
        { id: 'a', session_id: 's', role: 'assistant', content: 'The saved report is ready for review.', created_at: '2025-01-01T00:00:01Z' },
      ] },
      settings: { product_tour_version: '2', owner_name: 'Header QA' },
      storage: {
        'ive.onboarding.v2.owner': 'complete', 'ive.sidebar-visible': 'true',
        'ive.experience-mode.v1': { mode, provider: 'claude' },
        'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s'], showHome: false, sessionFocus: true },
      },
    })
    try {
      await f.page.goto('http://ive-guide.test/#session-s')
      await f.page.locator('[data-session-header-actions]').waitFor({ state: 'visible' })
      const draft = f.page.locator('[data-session-view="s"] .ive-session-composer textarea')
      await draft.fill('Keep this unsent draft while the header changes.')
      await inspectHeader(f, `${engine}-${width}-${mode}-sidebar-open`)
      const header = f.page.locator('header.ive-header')
      assert.equal(await header.getByRole('button', { name: /^(?:Hide|Show) sidebar$/ }).count(), 0, 'the open sidebar owns its hide control; the header shows no second one')
      await f.page.locator('#ive-project-sidebar').getByRole('button', { name: 'Hide sidebar', exact: true }).click()
      await f.page.locator('#ive-project-sidebar').waitFor({ state: 'detached' })
      await inspectHeader(f, `${engine}-${width}-${mode}-sidebar-hidden`)
      await header.getByRole('button', { name: /^(?:Show activity details|Details)$/ }).click()
      assert.equal(await header.getByRole('button', { name: /^(?:Show activity details|Details)$/ }).getAttribute('aria-pressed'), 'true')
      const other = mode === 'chat' ? 'Dev' : 'Chat'
      await header.getByRole('group', { name: 'Experience mode', exact: true }).getByRole('button', { name: other, exact: true }).click()
      await draft.waitFor({ state: 'visible' })
      assert.equal(await draft.inputValue(), 'Keep this unsent draft while the header changes.')
      assert.equal(await header.getByRole('button', { name: other, exact: true }).getAttribute('aria-pressed'), 'true')
      assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('ive.operator-desk')).activeSessionId), 's')
      assert.deepEqual(processWrites(f), [], 'header choices never start, stop, restart or submit to the saved worker')
      assert.deepEqual(f.errors, [])
    } finally { await f.context.close() }
  })
}
