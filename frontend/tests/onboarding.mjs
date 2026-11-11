import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

let browser
const engine = process.env.IVE_QA_BROWSER === 'webkit' ? webkit : chromium
const pictures = fileURLToPath(new URL('../../review/welcome/', import.meta.url))
before(async () => { await mkdir(pictures, { recursive: true }); browser = await engine.launch({ headless: true }) })
after(async () => { await browser?.close() })
const dialog = f => f.page.getByRole('dialog', { name: 'Willkommen bei IVE', exact: true })
const start = async (options = {}) => {
  const f = await createTourFixture(browser, options)
  await dialog(f).waitFor()
  return f
}
const clean = f => {
  assert.deepEqual(f.errors, [])
  assert.ok(!f.writes.some(call => !call.path.startsWith('/settings/')), 'Welcome never starts sessions, tasks or model calls')
}

test('one screen opens the real project picker and stays dismissed after reload', async () => {
  const f = await start()
  try {
    assert.equal(f.writes.length, 0)
    assert.equal(await dialog(f).locator('li').count(), 4)
    await f.page.screenshot({ path: `${pictures}/${engine.name()}-desktop.png` })
    await dialog(f).getByRole('button', { name: 'Projekt öffnen', exact: true }).click()
    await dialog(f).waitFor({ state: 'detached' })
    await f.page.locator('.ive-project-picker').waitFor()
    assert.equal(f.data.settings.product_tour_version, '2')
    assert.equal(await f.page.locator('.x-app-shell').evaluate(el => el.inert), false)
    await f.page.reload()
    await f.page.locator('.x-app-shell').waitFor()
    assert.equal(await dialog(f).count(), 0)
    clean(f)
  } finally { await f.context.close() }
})

test('keyboard focus stays inside, Escape dismisses, and help reopens the introduction', async () => {
  const f = await start()
  try {
    const primary = dialog(f).getByRole('button', { name: 'Projekt öffnen', exact: true })
    assert.equal(await primary.evaluate(el => el === document.activeElement), true)
    assert.equal(await f.page.locator('.x-app-shell').evaluate(el => el.inert), true)
    await f.page.keyboard.press('Shift+Tab')
    assert.equal(await dialog(f).getByRole('button', { name: 'Einführung schließen' }).evaluate(el => el === document.activeElement), true)
    await f.page.keyboard.press('Shift+Tab')
    assert.equal(await dialog(f).getByRole('button', { name: 'Deckel-zu-Modus' }).evaluate(el => el === document.activeElement), true)
    await f.page.keyboard.press('Shift+Tab')
    assert.equal(await dialog(f).getByRole('button', { name: 'KI einrichten' }).evaluate(el => el === document.activeElement), true)
    await f.page.keyboard.press('Tab')
    await f.page.keyboard.press('Tab')
    assert.equal(await dialog(f).getByRole('button', { name: 'Einführung schließen' }).evaluate(el => el === document.activeElement), true)
    await f.page.keyboard.press('Escape')
    await dialog(f).waitFor({ state: 'detached' })
    assert.equal(await f.page.locator('.x-app-shell').evaluate(el => el.inert), false)
    await f.page.keyboard.press('?')
    await f.page.getByRole('button', { name: 'Introduction' }).click()
    await dialog(f).waitFor()
    clean(f)
  } finally { await f.context.close() }
})

test('account action opens existing account settings', async () => {
  const f = await start()
  try {
    await dialog(f).getByRole('button', { name: 'KI einrichten' }).click()
    await dialog(f).waitFor({ state: 'detached' })
    await f.page.getByRole('dialog').waitFor()
    assert.match(await f.page.getByRole('dialog').innerText(), /Account|Kont|Connect/i)
    clean(f)
  } finally { await f.context.close() }
})

test('save failure keeps the chosen destination available for local-only continuation', async () => {
  const f = await start({ failSave: true })
  try {
    await dialog(f).getByRole('button', { name: 'Projekt öffnen', exact: true }).click()
    await dialog(f).getByRole('alert').waitFor()
    assert.equal(await f.page.locator('.ive-project-picker').count(), 0)
    await dialog(f).getByRole('button', { name: 'Ohne Speichern fortfahren' }).click()
    await dialog(f).waitFor({ state: 'detached' })
    await f.page.locator('.ive-project-picker').waitFor()
    clean(f)
  } finally { await f.context.close() }
})

test('guest sees shared-access guidance and never writes owner settings', async () => {
  const f = await start({ guest: true })
  try {
    assert.equal(await dialog(f).getByRole('button', { name: 'Projekt öffnen' }).count(), 0)
    assert.equal(await dialog(f).getByRole('button', { name: 'KI einrichten' }).count(), 0)
    await dialog(f).getByRole('button', { name: 'Zur Übersicht' }).click()
    await dialog(f).waitFor({ state: 'detached' })
    assert.deepEqual(f.writes, [])
    clean(f)
  } finally { await f.context.close() }
})

for (const theme of ['light', 'dark']) test(`320px ${theme} layout keeps every action reachable`, async () => {
  const f = await start({ viewport: { width: 320, height: 640 } })
  try {
    await f.page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await dialog(f).getByRole('button', { name: 'KI einrichten' }).scrollIntoViewIfNeeded()
    const box = await dialog(f).getByRole('button', { name: 'KI einrichten' }).boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 640)
    await f.page.screenshot({ path: `${pictures}/${engine.name()}-mobile-${theme}.png` })
    clean(f)
  } finally { await f.context.close() }
})
