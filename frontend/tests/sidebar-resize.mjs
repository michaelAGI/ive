// The sidebar's right edge drags like a Finder sidebar: live width while the
// pointer moves, the value kept in localStorage, keyboard steps, double-click
// back to the default, and terminals re-fit through the shared event. Real
// built UI on the isolated fixture; no provider starts.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { chromium } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const browser = await chromium.launch()
after(() => browser.close())
const shots = process.env.IVE_SHOT_DIR || join(tmpdir(), 'ive-sidebar-resize')
await mkdir(shots, { recursive: true })

const KEY = 'ive.sidebar-width.v1'
const workspace = { id: 'project', name: 'Workflow practice', path: '/isolated/workflow-practice' }
const session = (id) => ({
  id, name: `Conversation ${id}`, workspace_id: workspace.id, cli_type: 'claude', model: 'sonnet',
  status: 'idle', agentState: 'idle', pty_alive: false, session_type: 'worker', archived: 0, tags: [],
})

function fixture(options = {}) {
  return createTourFixture(browser, {
    settings: { product_tour_version: '2', owner_name: 'Sidebar QA' },
    workspaces: [workspace], sessions: [session('first'), session('second'), session('third')],
    ...options,
    storage: {
      'ive.onboarding.v2.owner': 'complete',
      'ive.sidebar-visible': 'true',
      'ive.operator-desk': { activeWorkspaceId: workspace.id, activeSessionId: 'first', openTabs: ['first'], showHome: false, sessionFocus: false },
      ...options.storage,
    },
  })
}

const width = async (locator) => Math.round((await locator.boundingBox()).width)
// Pointer moves arrive frame-aligned, and the fixture's reduced-motion setting turns
// every change into a 0.01 ms transition that headless Chromium only settles on its
// next compositor tick; read the width until the layout shows the value.
async function untilWidth(locator, expected, message) {
  const deadline = Date.now() + 3000
  let seen = await width(locator)
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    seen = await width(locator)
  }
  assert.equal(seen, expected, message)
}
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), KEY)
// A session view moves focus into its composer right after mount; take the
// handle once it keeps focus.
async function focusHandle(page, handle) {
  await page.locator('.ive-session-composer textarea:visible, [data-home-composer]:visible').first().waitFor()
  for (let attempt = 0; attempt < 20; attempt++) {
    await handle.focus()
    await page.waitForTimeout(60)
    if (await page.evaluate(() => document.activeElement?.hasAttribute('data-sidebar-resize'))) return
  }
  throw new Error('the resize handle did not keep keyboard focus')
}

test('dragging the right edge resizes the sidebar, keeps the width across reload, and double-click resets it', async () => {
  const f = await fixture()
  try {
    const { page } = f
    const sidebar = page.locator('#ive-project-sidebar')
    const handle = sidebar.getByRole('separator', { name: 'Resize sidebar', exact: true })
    await handle.waitFor({ state: 'visible' })
    assert.equal(await width(sidebar), 240, 'the default width is the 240px of --ive-sidebar-w')
    assert.equal(await handle.getAttribute('aria-orientation'), 'vertical')
    assert.equal(await handle.getAttribute('aria-valuenow'), '240')
    assert.equal(await handle.getAttribute('aria-valuemin'), '200')
    assert.equal(await handle.getAttribute('aria-valuemax'), '440')
    const hit = await handle.boundingBox()
    assert.ok(hit.width >= 6 && hit.width <= 8, `the hit area is about 6px wide, got ${hit.width}`)
    assert.ok(Math.abs(hit.x + hit.width / 2 - 240) <= 2, 'the handle sits on the sidebar edge')

    // Terminals re-fit through the same event the drawer and grid use.
    await page.evaluate(() => { window.__refits = 0; window.addEventListener('cc-terminal-refit', () => { window.__refits += 1 }) })

    const y = hit.y + hit.height / 2
    const x = hit.x + hit.width / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y, { steps: 4 })
    await page.mouse.move(x + 80, y, { steps: 4 })
    await untilWidth(sidebar, 320, 'the width follows the pointer while dragging')
    assert.equal(await page.evaluate(() => document.body.classList.contains('ive-sidebar-resizing')), true, 'the page shows the resize cursor while dragging')
    assert.equal(await handle.getAttribute('aria-valuenow'), '320')
    assert.equal(await stored(page), null, 'nothing is written while the pointer is down')
    await page.waitForTimeout(300) // let the compositor settle so the shot shows the drag line
    await page.screenshot({ path: `${shots}/chromium-sidebar-mid-drag.png` })
    await page.mouse.up()
    await untilWidth(sidebar, 320, 'the width stays where the pointer let go')
    assert.equal(await stored(page), '320', 'the width is saved on release')
    assert.equal(await page.evaluate(() => document.body.classList.contains('ive-sidebar-resizing')), false)
    await page.waitForFunction(() => window.__refits > 0)
    assert.ok(Math.abs((await page.locator('main.x-app-main').boundingBox()).x - 320) <= 1, 'the main area starts where the sidebar ends')
    await page.mouse.move(720, 500) // leave the edge so the hover line fades
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${shots}/chromium-sidebar-after-drag.png` })

    // Limits: the edge never goes past 440 or under 200.
    await page.mouse.move(x + 80, y)
    await page.mouse.down()
    await page.mouse.move(x + 600, y, { steps: 3 })
    await untilWidth(sidebar, 440, 'the sidebar stops at 440px')
    // Just past the minimum the edge holds at 200px; further left would close it.
    await page.mouse.move(x - 100, y, { steps: 3 })
    await untilWidth(sidebar, 200, 'the sidebar stops at 200px')
    await page.mouse.move(x + 80, y, { steps: 2 })
    await untilWidth(sidebar, 320, 'back at 320px before release')
    await page.mouse.up()
    await untilWidth(sidebar, 320, 'the limits do not change the committed width')

    await page.reload()
    await handle.waitFor({ state: 'visible' })
    await untilWidth(sidebar, 320, 'the width survives a reload')
    assert.equal(await handle.getAttribute('aria-valuenow'), '320')

    // Keyboard: arrows step 16px.
    await focusHandle(page, handle)
    await page.keyboard.press('ArrowLeft')
    await untilWidth(sidebar, 304, 'ArrowLeft takes 16px away')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await untilWidth(sidebar, 336, 'ArrowRight adds 16px')
    assert.equal(await stored(page), '336')

    // Double-click: back to the default, nothing left in storage.
    await handle.dblclick()
    await untilWidth(sidebar, 240, 'double-click resets to the default width')
    assert.equal(await stored(page), null)
    assert.equal(await handle.getAttribute('aria-valuenow'), '240')
    await page.reload()
    await handle.waitFor({ state: 'visible' })
    await untilWidth(sidebar, 240, 'the reset survives a reload')

    // Hiding and showing the sidebar keeps a custom width.
    await focusHandle(page, handle)
    await page.keyboard.press('End')
    await untilWidth(sidebar, 440, 'End jumps to the widest setting')
    await sidebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
    await sidebar.waitFor({ state: 'detached' })
    await page.locator('header.ive-header').getByRole('button', { name: 'Show sidebar', exact: true }).click()
    await handle.waitFor({ state: 'visible' })
    await untilWidth(sidebar, 440, 'reopening restores the chosen width')

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow')
    assert.deepEqual(f.errors, [], 'no browser exceptions')
    assert.deepEqual(f.writes.filter((call) => /\/sessions/.test(call.path)), [], 'resizing never touches a session')
  } finally { await f.context.close() }
})

test('a stored width outside the limits is clamped on load, and a broken value falls back to the default', async () => {
  for (const [value, expected] of [['900', 440], ['12', 200], ['garbage', 240]]) {
    const f = await fixture({ storage: { [KEY]: value } })
    try {
      const sidebar = f.page.locator('#ive-project-sidebar')
      await sidebar.getByRole('separator', { name: 'Resize sidebar', exact: true }).waitFor({ state: 'visible' })
      assert.equal(await width(sidebar), expected, `stored "${value}" renders at ${expected}px`)
      assert.deepEqual(f.errors, [])
    } finally { await f.context.close() }
  }
})

test('the phone layout has no resize handle', async () => {
  const f = await fixture({ width: 390, height: 844, touch: true, storage: { 'ive.operator-desk': { openTabs: [], showHome: true, activeWorkspaceId: null } } })
  try {
    const { page } = f
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'Sidebar', exact: true })
    await drawer.waitFor({ state: 'visible' })
    assert.equal(await drawer.getByRole('separator').count(), 0, 'the drawer sidebar is full width and not resizable')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})

test('dragging the edge far to the left closes the sidebar; the left window edge pulls it back at its width', async () => {
  const f = await fixture({ storage: { [KEY]: '300' } })
  try {
    const { page } = f
    const sidebar = page.locator('#ive-project-sidebar')
    const handle = sidebar.getByRole('separator', { name: 'Resize sidebar', exact: true })
    await handle.waitFor({ state: 'visible' })
    await untilWidth(sidebar, 300, 'the stored width applies')
    const hit = await handle.boundingBox()
    const x = hit.x + hit.width / 2, y = hit.y + hit.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 120, y, { steps: 3 })
    await untilWidth(sidebar, 200, 'first the edge holds at the minimum')
    await page.mouse.move(x - 260, y, { steps: 4 })
    await page.waitForFunction(() => document.body.classList.contains('ive-sidebar-collapsing'))
    // Change of mind: back above the threshold reopens the preview.
    await page.mouse.move(x - 60, y, { steps: 3 })
    await page.waitForFunction(() => !document.body.classList.contains('ive-sidebar-collapsing'))
    await page.mouse.move(x - 280, y, { steps: 4 })
    await page.waitForFunction(() => document.body.classList.contains('ive-sidebar-collapsing'))
    await page.mouse.up()
    await sidebar.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => localStorage.getItem('ive.sidebar-visible')), 'false', 'the hidden sidebar is remembered')
    assert.equal(await stored(page), '300', 'closing keeps the width for next time')
    assert.ok((await page.locator('main.x-app-main').boundingBox()).x <= 1, 'the main area takes the full width')
    assert.equal(await page.getByRole('button', { name: /Show sidebar/ }).count() > 0, true, 'the header offers Show sidebar')

    const edge = page.locator('.ive-sidebar-edge')
    await edge.waitFor()
    const e = await edge.boundingBox()
    await page.mouse.move(e.x + 2, e.y + 300)
    await page.mouse.down()
    await page.mouse.move(e.x + 80, e.y + 300, { steps: 5 })
    await page.mouse.up()
    await sidebar.waitFor({ state: 'visible' })
    await untilWidth(sidebar, 300, 'it comes back at the width it had')
    assert.equal(await page.locator('.ive-sidebar-edge').count(), 0, 'the edge handle leaves with the sidebar shown')
    assert.equal(await page.evaluate(() => localStorage.getItem('ive.sidebar-visible')), 'true')
    assert.deepEqual(f.errors, [])
  } finally { await f.context.close() }
})
