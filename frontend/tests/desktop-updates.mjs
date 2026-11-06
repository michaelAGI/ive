import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/desktop-updates-qa/', import.meta.url).pathname
await mkdir(out, { recursive: true })
let passed = 0
const nativeMock = ({ latest, fail }) => {
    window.__IVE_BACKEND__ = location.origin
    window.nativeCalls = []
    window.updateState = { currentVersion: '1.0.21', version: null, automatic: false, downloaded: false, restartRequired: false, error: null }
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      async invoke(command, args) {
        if (!command.startsWith('desktop_update_')) return command === 'window_is_focused'
        window.nativeCalls.push(command)
        if (command === fail) throw 'The update could not be downloaded or verified. Your current app is unchanged.'
        if (command === 'desktop_update_check') { window.updateState.version = latest; window.updateState.notes = latest ? 'Fix normal chat questions and open session tiles with a double-click.' : null }
        if (command === 'desktop_update_automatic') window.updateState.automatic = args.enabled
        if (command === 'desktop_update_download') {
          args.progress.onmessage({ downloaded: 50, total: 100 })
          await new Promise(resolve => setTimeout(resolve, 250))
          args.progress.onmessage({ downloaded: 100, total: 100 })
          window.updateState.downloaded = true
        }
        return { ...window.updateState }
      },
    }
  }

async function fixture({ native = true, latest = '1.0.22', theme = 'dark', fail = null } = {}) {
  const f = await createTourFixture(browser, { theme, width: 1440, height: 960,
    ...(native ? { initScript: nativeMock, initArgs: { latest, fail } } : {}),
    settings: { product_tour_version: '2' }, workspaces: [{ id: 'w', name: 'Example', path: '/isolated/example' }],
    sessions: [{ id: 's', workspace_id: 'w', name: 'My session', cli_type: 'claude', model: 'sonnet', status: 'idle', pty_alive: true, session_type: 'worker', tags: [] }],
    storage: { 'ive.experience-mode.v1': { mode: 'dev', provider: 'claude' }, 'ive.operator-desk': { activeWorkspaceId: 'w', activeSessionId: 's', openTabs: ['s'], showHome: false, activeNavGroup: 'work' } },
  })
  await f.page.goto('http://ive-guide.test/#session-s')
  await f.page.locator('.ive-session-composer textarea').fill('Keep my current draft')
  await f.page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await f.page.locator('[data-settings-nav="general-settings"]').click()
  return f
}

try {
  for (const theme of ['dark', 'light']) {
    const f = await fixture({ theme }); const p = f.page
    await p.getByRole('button', { name: 'Check for updates', exact: true }).click()
    const modal = p.getByRole('dialog', { name: 'Update to IVE 1.0.22' })
    await modal.waitFor()
    await modal.getByText(/stops running agents and terminals/).waitFor()
    assert.equal((await p.evaluate(() => nativeCalls)).includes('desktop_update_download'), false)
    assert.equal((await p.evaluate(() => nativeCalls)).includes('desktop_update_install'), false)
    await p.screenshot({ path: `${out}${engine}-${theme}-available.png`, fullPage: true, animations: 'disabled' })
    await modal.getByRole('button', { name: 'Later', exact: true }).click()
    assert.equal(await p.locator('[data-desktop-update-notice]').count(), 0)
    await p.getByRole('checkbox', { name: /Automatic updates/ }).check()
    await p.waitForFunction(() => updateState.downloaded)
    assert.equal((await p.evaluate(() => nativeCalls)).includes('desktop_update_install'), false, 'Automatic download keeps the running app')
    await p.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await modal.getByText('The update is downloaded and verified.', { exact: true }).waitFor()
    await p.screenshot({ path: `${out}${engine}-${theme}-ready.png`, fullPage: true, animations: 'disabled' })
    await modal.getByRole('button', { name: 'Install and restart', exact: true }).click()
    await p.waitForFunction(() => nativeCalls.includes('desktop_update_install'))
    const calls = await p.evaluate(() => nativeCalls)
    assert.equal(calls.filter(c => c === 'desktop_update_install').length, 1)
    assert.equal(calls.filter(c => c === 'desktop_update_download').length, 1, 'Uses the already verified download')
    assert.equal(await p.locator('.ive-session-composer textarea').inputValue(), 'Keep my current draft')
    assert.equal(f.errors.length, 0, f.errors.join('\n'))
    await f.context.close(); passed++
  }
  const failure = await fixture({ fail: 'desktop_update_download' })
  await failure.page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await failure.page.getByRole('button', { name: 'Install and restart', exact: true }).click()
  await failure.page.getByRole('alert').filter({ hasText: 'could not be downloaded or verified' }).waitFor()
  assert.equal((await failure.page.evaluate(() => nativeCalls)).includes('desktop_update_install'), false)
  await failure.context.close(); passed++
  const current = await fixture({ latest: null })
  await current.page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await current.page.getByText('You’re up to date.', { exact: true }).waitFor()
  assert.equal(await current.page.getByRole('button', { name: 'Install and restart', exact: true }).count(), 0)
  await current.context.close(); passed++
  const web = await fixture({ native: false })
  assert.equal(await web.page.locator('[data-desktop-update-settings]').count(), 0)
  assert.equal(await web.page.locator('[data-desktop-update-notice]').count(), 0)
  await web.context.close(); passed++
  console.log(JSON.stringify({ engine, passed }))
} finally { await browser.close() }
