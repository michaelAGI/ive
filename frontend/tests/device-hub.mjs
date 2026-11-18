// Production DeviceHub in an offline fixture: no device, account or agent calls.
// Build the frontend and run device-hub-preview.mjs before this test.
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const output = path.resolve('../review-device-hub-ui')
await mkdir(output, { recursive: true })
const report = []
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(path.resolve('device-hub-review/index.html')).href)
    const frame = page.frameLocator('#frame')
    const calls = () => page.locator('#frame').evaluate(el => el.contentWindow.previewCalls)
    const state = async kind => {
      await page.getByRole('button', { name: kind, exact: true }).click()
      await frame.locator('.device-hub-device, .device-hub-empty').first().waitFor()
      await frame.locator('.device-hub-status').waitFor({ state: 'hidden' })
    }
    const capture = async filename => {
      await page.waitForTimeout(300) // Wait for the shared modal opening animation.
      await frame.locator('[role="dialog"]').screenshot({ path: path.join(output, `${name}-${filename}.png`) })
    }
    await frame.getByRole('button', { name: 'Connect iPhone', exact: true }).waitFor()
    assert.equal(await frame.locator('.device-hub-preview').count(), 0)
    assert.equal(await frame.locator('.device-hub-ideas').getAttribute('open'), null)
    await capture('desktop-initial')

    await frame.getByText('Choose a task idea', { exact: true }).click()
    assert.equal(await frame.locator('.device-hub-recipe').count(), 10)
    await frame.getByRole('button', { name: 'Review the coming week' }).click()
    assert.match(await frame.getByRole('textbox').inputValue(), /next seven days/)
    assert.equal(await frame.locator('.device-hub-ideas').getAttribute('open'), null)
    assert.equal(await frame.getByRole('textbox').evaluate(el => el === document.activeElement), true)
    await frame.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('claude')
    await frame.getByRole('checkbox').uncheck()
    await frame.getByRole('button', { name: 'Connect iPhone', exact: true }).click()
    await frame.getByRole('button', { name: 'Stop setup', exact: true }).waitFor()
    const setupCalls = await calls()
    assert.deepEqual(setupCalls.map(c => c[0]), ['create', 'grant-setup', 'send'])
    assert.equal(setupCalls[0][1].cli_type, 'claude')
    assert.equal(setupCalls[0][1].permission_mode, 'default')
    assert.match(setupCalls[2][2], /next seven days/)
    await capture('setup')
    await frame.getByRole('button', { name: 'Stop setup', exact: true }).click()
    await frame.getByRole('button', { name: 'Connect iPhone', exact: true }).waitFor()
    assert.equal((await calls()).at(-1)[0], 'stop-setup')

    await state('ready')
    assert.equal(await frame.getByRole('button', { name: 'Connect iPhone', exact: true }).count(), 0)
    await frame.getByRole('button', { name: 'Start control', exact: true }).click()
    await frame.getByRole('button', { name: 'Stop control', exact: true }).waitFor()
    assert.deepEqual((await calls()).map(c => c[0]), ['create', 'assign', 'send'])
    await frame.getByRole('textbox').fill('Review my calendar without changing it.')
    await frame.getByRole('button', { name: 'Send task', exact: true }).click()
    await frame.getByRole('button', { name: 'Task sent', exact: true }).waitFor()
    assert.equal(await frame.getByRole('button', { name: 'Task sent', exact: true }).isDisabled(), true)
    await frame.getByRole('button', { name: 'Show screen', exact: true }).click()
    await frame.getByRole('img', { name: 'Latest screenshot from the assigned iPhone' }).waitFor()
    await capture('screen')
    await frame.getByRole('button', { name: 'Pause', exact: true }).click()
    assert.equal(await frame.getByRole('button', { name: 'Resume', exact: true }).isVisible(), true)
    await frame.getByRole('button', { name: 'Hide screen', exact: true }).click()
    assert.equal(await frame.locator('.device-hub-preview').count(), 0)
    await frame.getByRole('button', { name: 'Stop control', exact: true }).click()
    await frame.getByRole('button', { name: 'Start control', exact: true }).waitFor()
    assert.equal((await calls()).at(-1)[0], 'unassign')

    await state('ready')
    await frame.getByText('Use an existing session', { exact: true }).click()
    await frame.getByRole('combobox', { name: 'Session', exact: true }).selectOption('preview-agent')
    await frame.getByRole('button', { name: 'Give control', exact: true }).click()
    await frame.getByRole('button', { name: 'Stop control', exact: true }).waitFor()
    assert.deepEqual((await calls()).map(c => c[0]), ['assign'])

    await state('unsupported')
    assert.equal(await frame.getByRole('button', { name: 'Start control', exact: true }).isDisabled(), true)
    await state('multiple')
    assert.equal(await frame.locator('.device-hub-device[aria-pressed="true"]').count(), 0)
    await frame.getByRole('button', { name: 'Second iPhone' }).click()
    assert.equal(await frame.getByRole('button', { name: 'Start control', exact: true }).isVisible(), true)

    await state('empty')
    assert.match(await frame.locator('.device-hub-empty').innerText(), /No iPhone connected/)
    await capture('empty')
    await page.getByRole('button', { name: '390 px', exact: true }).click()
    await page.locator('#frame').evaluate(el => { el.style.height = '844px' })
    await state('initial')
    assert.equal(await frame.locator('.device-hub-body').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await capture('mobile-initial')
    await frame.getByText('Connection help', { exact: true }).click()
    await frame.getByText('Developer Mode ↗', { exact: true }).scrollIntoViewIfNeeded()
    assert.equal(await frame.locator('.device-hub-body').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await frame.getByText('Connection help', { exact: true }).click()
    await state('initial')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('#frame').evaluate(el => { el.contentDocument.documentElement.dataset.theme = 'dark' })
    await capture('mobile-dark')
    await page.getByRole('button', { name: 'Wide', exact: true }).click()
    await capture('desktop-dark')
    await frame.getByRole('textbox').focus()
    await page.keyboard.press('Tab')
    assert.match(await frame.locator(':focus').innerText(), /Choose a task idea/)
    assert.deepEqual(errors, [])
    report.push({ browser: name, passed: true, checks: ['initial', 'task ideas', 'provider and permissions', 'setup', 'stop setup', 'start control', 'send task once', 'screen preview and pause', 'stop control', 'existing session', 'unsupported Mac', 'multiple devices', 'empty', '390px', 'dark theme', 'keyboard focus', 'no JavaScript errors'] })
  } finally {
    await browser.close()
  }
}
await writeFile(path.join(output, 'ui-checks.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
