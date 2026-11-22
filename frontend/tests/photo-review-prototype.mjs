// Interactive concept only: fixtures, no phone/library/provider access.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, 'packaging/artifacts/device-next-review')
await mkdir(output, { recursive: true })
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const html = url.pathname === '/docs/prototypes/photo-review.html'
  const font = /^\/frontend\/public\/fonts\/inter-latin-(400|600)\.woff2$/.test(url.pathname)
  if (!html && !font) { res.writeHead(404); res.end(); return }
  try {
    const content = await readFile(path.join(root, url.pathname))
    res.writeHead(200, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'font/woff2' })
    res.end(content)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/docs/prototypes/photo-review.html`
const evidence = []
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch()
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 940 }, reducedMotion: 'reduce', acceptDownloads: true })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(url)
      await page.evaluate(() => document.fonts.ready)
      assert.equal(await page.locator('.photo').count(), 4)
      assert.equal(await page.locator('#save').isDisabled(), true)
      await page.screenshot({ path: path.join(output, `photo-review-${name}-desktop.png`), fullPage: true })
      await page.getByRole('button', { name: 'Keep IMG_2041.HEIC', exact: true }).click()
      await page.getByRole('button', { name: 'Keep IMG_2042.HEIC', exact: true }).click()
      assert.equal(await page.locator('.photo[aria-pressed=true]').count(), 2)
      await page.getByRole('button', { name: 'Compare two' }).click()
      assert.equal(await page.locator('dialog[open] figure').count(), 2)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('dialog[open]').count(), 0)
      await page.getByRole('button', { name: 'Keep all', exact: true }).click()
      await page.getByRole('button', { name: 'Save selection' }).click()
      assert.match(await page.locator('#group-progress').innerText(), /1 of 3/)
      assert.equal(await page.locator('#group-title').innerText(), 'Around the city')
      await page.getByRole('button', { name: 'Review later' }).click()
      assert.equal(await page.locator('#group-title').innerText(), 'On the trail')
      await page.getByRole('button', { name: 'Keep IMG_2130.HEIC', exact: true }).focus()
      await page.keyboard.press('Space')
      await page.getByRole('button', { name: 'Save selection' }).click()
      assert.match(await page.locator('#summary').innerText(), /5 keepers saved · 1 groups unresolved/)
      const pendingDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export demo choices' }).click()
      const download = await pendingDownload
      const manifest = JSON.parse(await readFile(await download.path(), 'utf8'))
      assert.equal(manifest.demo, true)
      assert.equal(manifest.groups[1].status, 'deferred')
      assert.equal(manifest.groups[1].keep.length, 0)
      assert.equal(manifest.groups[0].keep.length, 4)
      assert.equal(manifest.groups[2].keep.length, 1)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Reset demo' }).click()
      await page.evaluate(() => window.scrollTo(0, 0))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: path.join(output, `photo-review-${name}-mobile.png`), fullPage: true })
      await page.getByRole('button', { name: 'Keep IMG_2041.HEIC', exact: true }).click()
      await page.getByRole('button', { name: 'Compare two' }).click()
      assert.equal(await page.locator('dialog[open]').count(), 1)
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.reload()
      assert.equal(await page.locator('.photo[aria-pressed=true]').count(), 0)
      assert.deepEqual(errors, [])
      evidence.push({ browser: name, desktop: true, mobile: true, selection: true, comparison: true, deferred: true, export: true, errors })
      await context.close()
    } finally { await browser.close() }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
console.log(JSON.stringify(evidence, null, 2))
