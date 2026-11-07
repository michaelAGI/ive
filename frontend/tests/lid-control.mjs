// The eyelid in the header: shows whether the Mac keeps working with the lid
// closed, opens a popover with the switch and the conditions, remembers the
// conditions, and turns the mode on and off through the real API shape.
// Real built UI on the isolated fixture; no provider starts.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { chromium } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browser = await chromium.launch()
after(() => browser.close())
const shots = process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-lid-control')
await mkdir(shots, { recursive: true })

const PREF_KEY = 'ive:mac-power-options:v1'
const workspace = { id: 'project', name: 'Workflow practice', path: '/isolated/workflow-practice' }
const session = (id) => ({
  id, name: `Conversation ${id}`, workspace_id: workspace.id, cli_type: 'claude', model: 'sonnet',
  status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [],
})

function fixture(options = {}) {
  return createTourFixture(browser, {
    settings: { product_tour_version: '2', owner_name: 'Lid QA' },
    workspaces: [workspace], sessions: [session('first')],
    ...options,
    storage: {
      'ive.onboarding.v2.owner': 'complete',
      'ive.sidebar-visible': 'true',
      'ive.operator-desk': { activeWorkspaceId: workspace.id, activeSessionId: 'first', openTabs: ['first'], showHome: false, sessionFocus: false },
      ...options.storage,
    },
  })
}

const button = (f) => f.page.locator('[data-lid-control] > button')
const dialog = (f) => f.page.getByRole('dialog', { name: 'Lid-closed mode' })
const toggle = (f) => f.page.getByRole('switch', { name: 'Keep working with the lid closed' })
const posts = (f, path) => f.writes.filter((w) => w.method === 'POST' && w.path === path)

test('the eyelid turns the lid-closed mode on and off and keeps the conditions', async () => {
  const f = await fixture()
  try {
    await button(f).waitFor()
    assert.equal(await button(f).getAttribute('aria-pressed'), 'false')
    assert.match(await button(f).getAttribute('title'), /^Off/)
    await button(f).click()
    await dialog(f).waitFor()
    assert.equal(await toggle(f).getAttribute('aria-checked'), 'false')
    await f.page.screenshot({ path: join(shots, 'lid-popover-off.png') })

    await dialog(f).locator('select').selectOption('7200')
    await dialog(f).getByLabel('Also on battery').check()
    const stored = await f.page.evaluate((key) => JSON.parse(localStorage.getItem(key)), PREF_KEY)
    assert.equal(stored.duration_seconds, 7200)
    assert.equal(stored.allow_battery, true)

    await toggle(f).click()
    await f.page.waitForFunction(() => document.querySelector('[data-lid-control] > button')?.getAttribute('aria-pressed') === 'true')
    const start = posts(f, '/mac-power/start')
    assert.equal(start.length, 1)
    assert.equal(start[0].body.duration_seconds, 7200)
    assert.equal(start[0].body.allow_battery, true)
    assert.equal(await toggle(f).getAttribute('aria-checked'), 'true')
    assert.match(await button(f).locator('.ive-lid-btn-label').textContent(), /h|min/)
    assert.match(await dialog(f).getByRole('status').textContent(), /^On until/)
    assert.equal(await dialog(f).locator('select').isDisabled(), true, 'conditions lock while the mode runs')
    await f.page.screenshot({ path: join(shots, 'lid-popover-on.png') })

    await toggle(f).click()
    await f.page.waitForFunction(() => document.querySelector('[data-lid-control] > button')?.getAttribute('aria-pressed') === 'false')
    assert.equal(posts(f, '/mac-power/stop').length, 1)
    assert.equal(await dialog(f).locator('select').isDisabled(), false)

    await f.page.keyboard.press('Escape')
    await dialog(f).waitFor({ state: 'detached' })
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})

test('a battery refusal offers the one-click fix, unavailable disables the switch', async () => {
  const f = await fixture()
  try {
    f.controls.macPowerRefusal = { error: 'The Mac is on battery.', reason: 'battery_not_allowed' }
    f.controls.setMacPower({ on_battery: true, battery_percent: 64 })
    await button(f).click()
    await dialog(f).waitFor()
    await toggle(f).click()
    const alert = dialog(f).getByRole('alert')
    await alert.waitFor()
    assert.match(await alert.textContent(), /on battery/)
    f.controls.macPowerRefusal = null
    await alert.getByRole('button', { name: 'Allow battery use and turn on' }).click()
    await f.page.waitForFunction(() => document.querySelector('[data-lid-control] > button')?.getAttribute('aria-pressed') === 'true')
    const start = posts(f, '/mac-power/start')
    assert.equal(start.at(-1).body.allow_battery, true)
    assert.equal(await dialog(f).getByRole('alert').count(), 0, 'the refusal disappears once the mode runs')
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }

  const g = await fixture({ macPower: { state: 'unavailable' } })
  try {
    await button(g).waitFor()
    assert.match(await button(g).getAttribute('title'), /IVE Mac app/)
    await button(g).click()
    await dialog(g).waitFor()
    assert.equal(await toggle(g).isDisabled(), true)
    assert.deepEqual(g.errors, [])
  } finally { await g.context.close() }
})
