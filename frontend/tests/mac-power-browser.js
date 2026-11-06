// Headless Playwright check of the Mac & Power panel against a mocked API.
// Run after `npm run build` (the harness reuses the built CSS):
//   node tests/mac-power-browser.js            Chromium
//   IVE_QA_BROWSER=webkit node tests/mac-power-browser.js
// IVE_QA_SHOTS sets the screenshot folder, IVE_QA_TMP the harness folder.
// Nothing here registers a helper, changes power or opens System Settings.
import { build } from 'esbuild'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.env.IVE_QA_TMP || '/tmp/ive-mac-power-ui'
const shots = process.env.IVE_QA_SHOTS || path.join(root, '..', 'packaging', 'artifacts', 'mac-power-ui')
const engine = process.env.IVE_QA_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const origin = 'http://ive-mac-power.test'
const contexts = [], checks = [], errors = [], screenshots = []
const check = (value, message) => { if (!value) throw new Error(message); checks.push(message) }
const GERMAN = /Energie|Zuklappen|Akku|Stromspar|prüfen|Deckel|Laufzeit|einschalten/

async function harness() {
  await mkdir(dir, { recursive: true }); await mkdir(shots, { recursive: true })
  await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import Panel from './src/components/settings/MacPowerPanel.jsx'; createRoot(document.getElementById('root')).render(<Panel/>);`, resolveDir: root, loader: 'jsx' }, bundle: true, jsx: 'automatic', format: 'esm', outfile: `${dir}/harness.js`, logLevel: 'silent' })
  await cp(`${root}/dist/assets`, `${dir}/assets`, { recursive: true })
  await cp(`${root}/dist/fonts`, `${dir}/fonts`, { recursive: true }).catch(() => {})
  const css = (await readdir(`${root}/dist/assets`)).find(name => /^index-.*\.css$/.test(name))
  await writeFile(`${dir}/index.html`, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/${css}"></head><body style="background:var(--color-x-surface);margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/harness.js"></script></body></html>`)
}
const POWER = { battery_percent: 76, on_battery: false, low_power_active: false }
async function fixture(browser, initial = {}) {
  const s = { calls: [], approved: false, statusFail: false, stopFail: false, startFail: false, refuse: null,
    status: { state: 'not_registered', lid_saver_supported: true, battery_floor: 20, ...POWER }, ...initial }
  const context = await browser.newContext({ viewport: { width: 1000, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); contexts.push(context)
  await context.route('**/*', async route => {
    const r = route.request(), url = new URL(r.url())
    if (url.origin !== origin) return route.fulfill({ status: 403, body: 'External requests blocked' })
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ path: dir + (url.pathname === '/' ? '/index.html' : url.pathname) })
    if (r.method() === 'GET') return s.statusFail ? route.fulfill({ status: 503, json: { error: 'Test status unavailable' } }) : route.fulfill({ json: s.status })
    const body = r.postData() ? r.postDataJSON() : null
    if (url.pathname === '/api/macos/open-settings') { s.calls.push({ action: 'open-settings', body }); return route.fulfill({ json: { ok: true, pane: body.pane } }) }
    const action = url.pathname.split('/').at(-1)
    s.calls.push({ action, body })
    if (action === 'start') {
      if (s.refuse) { const { status = 409, body: refusal } = s.refuse; s.refuse = null; return route.fulfill({ status, json: { state: s.status.state, settings_pane: null, ...refusal } }) }
      if (s.startFail) return route.fulfill({ status: 503, json: { error: 'Test start uncertain' } })
      s.status = s.approved ? { state: 'active', mode_source: 'agent', lid_saver_supported: true, ...body,
        lid_closed: false, lid_saver_active: false, low_power_active: false, paused_processes: 0,
        expires_at: new Date(Date.now() + body.duration_seconds * 1000).toISOString(), battery_percent: 76, on_battery: s.status.on_battery === true }
        : { state: 'needs_approval', lid_saver_supported: true, ...POWER }
    }
    if (action === 'stop') s.status = { state: s.stopFail ? 'restore_failed' : 'ready', lid_saver_supported: true, ...POWER }
    return route.fulfill({ json: s.status })
  })
  const p = await context.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', e => errors.push(e.message))
  await p.goto(origin); await p.locator('[data-mac-power-state]:not([data-mac-power-state="loading"])').waitFor()
  // Icons transition on theme change; screenshots must not catch them half-way.
  await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important }' })
  return { p, s }
}
async function shoot(p, name) {
  for (const theme of ['dark', 'light']) {
    await p.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
    const file = path.join(shots, `${name}-${theme}-${engine}.png`); await p.screenshot({ path: file, fullPage: true }); screenshots.push(file)
  }
  await p.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
}
const status = (p, phase) => p.locator(`[data-mac-power-state="${phase}"]`).waitFor()
const button = (p, name) => p.getByRole('button', { name, exact: true })
const alert = p => p.getByRole('alert')
const refresh = p => button(p, 'Check status').click()
const line = p => p.locator('[data-mac-power-line]').innerText()
const posted = (p, suffix) => p.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === 'POST')
const start = p => p.locator('[data-mac-power-start]')
const batteryBox = p => p.getByRole('checkbox', { name: /Also run on battery/ })
const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem('ive:mac-power-options:v1')))
async function refuse(p, s, body) {
  s.refuse = { body }; await start(p).click()
  await p.locator(`[data-mac-power-error="${body.reason}"]`).waitFor()
}

const browser = await (engine === 'webkit' ? webkit : chromium).launch()
try {
  await harness()
  // 1. Safe defaults, honest power line, the full on/off round trip.
  let { p, s } = await fixture(browser)
  await status(p, 'not_registered')
  check(s.calls.length === 0, 'Opening settings never registers a helper or changes power')
  check((await line(p)) === 'Battery 76 % · on power adapter · Low Power Mode off', 'Power line reports battery, source and Low Power Mode while off')
  check(!GERMAN.test(await p.locator('[data-mac-power-panel]').innerText()), 'No German strings remain')
  check(await p.getByRole('checkbox', { name: /Low Power Mode on battery/ }).isChecked(), 'Low Power option is a visible, checked default')
  check(!(await batteryBox(p).isChecked()), 'Battery operation stays explicit')
  check(await p.locator('[data-mac-power-battery-hint]').count() === 0, 'No battery hint while on the power adapter')
  check((await p.locator('[data-mac-power-panel]').innerText()).includes('(Control-Command-Q)'), 'Lock shortcut is spelled Control-Command-Q')
  for (const name of ['Slack', 'Discord', 'WhatsApp', 'Spotify']) check(!(await p.getByRole('checkbox', { name, exact: true }).isChecked()), name + ' starts unselected')
  await batteryBox(p).check()
  await p.getByRole('checkbox', { name: 'Discord', exact: true }).check()
  await p.getByLabel('Maximum duration').selectOption('1800')
  check(s.calls.length === 0, 'Selecting lid actions alone causes no OS changes')
  await shoot(p, 'mac-power-options')
  await button(p, 'Turn on').click(); await status(p, 'needs_approval')
  check(s.calls[0].action === 'start' && s.calls[0].body.duration_seconds === 1800 && s.calls[0].body.allow_battery === true && s.calls[0].body.lid_low_power === true && JSON.stringify(s.calls[0].body.pause_apps) === '["com.hnc.Discord"]', 'Only selected settings reach start')
  check((await p.locator('[data-mac-power-state]').innerText()).includes('Login Items & Extensions'), 'Missing approval names the System Settings pane')
  check(await p.locator('[data-mac-power-notice]').isVisible() && await button(p, 'Turn on').count() === 0 && await button(p, 'Check approval and turn on').count() === 1, 'A still-unapproved reply shows the neutral notice and renames the primary')
  let reply = posted(p, '/api/mac-power/approval'); await button(p, 'Open Login Items & Extensions').click(); await reply
  check(s.calls.at(-1).action === 'approval' && s.status.state === 'needs_approval', 'Login Items button calls the approval endpoint and does not imply activation')
  reply = posted(p, '/api/mac-power/start'); await button(p, 'Check approval and turn on').click(); await reply; await button(p, 'Check approval and turn on').waitFor()
  check(s.calls.at(-1).action === 'start' && await p.locator('[data-mac-power-state="needs_approval"]').count() === 1 && await p.locator('[data-mac-power-notice]').isVisible(), 'Checking approval before macOS allowed IVE keeps the state and the notice')
  s.approved = true; await button(p, 'Check approval and turn on').click(); await status(p, 'active')
  check(await p.locator('[data-mac-power-notice]').count() === 0, 'Activation clears the approval notice')
  check((await p.getByRole('status').innerText()).includes('ready to close the lid'), 'Open lid is armed, not falsely saving')
  check(await p.getByText('No apps paused', { exact: true }).isVisible(), 'Open lid reports no paused apps')
  check(await p.getByRole('checkbox', { name: 'Discord', exact: true }).isDisabled(), 'Active options cannot be silently changed')
  check(await button(p, 'Open Battery settings').isEnabled(), 'Battery settings stay reachable while options are locked')
  const left = await p.getByLabel('Time remaining').innerText()
  check(left.startsWith('00:29:') || left === '00:30:00', 'Countdown uses confirmed expiry')
  Object.assign(s.status, { lid_closed: true, lid_saver_active: true, low_power_active: true, on_battery: true, paused_processes: 3 }); await refresh(p)
  await p.getByText('Lid closed · lid actions active', { exact: true }).waitFor()
  check(await p.getByText('Selected apps paused', { exact: true }).isVisible(), 'Closed lid reports verified saver and app suspension')
  check((await line(p)).endsWith('on battery · Low Power Mode on'), 'Closed lid power line shows battery and Low Power Mode')
  await shoot(p, 'mac-power-closed')
  Object.assign(s.status, { lid_closed: false, lid_saver_active: false, low_power_active: false, on_battery: false, paused_processes: 0 }); await refresh(p)
  await p.getByText('On · ready to close the lid', { exact: true }).waitFor()
  check(await p.getByText('No apps paused', { exact: true }).isVisible(), 'Reopening restores apps while the feature stays armed')
  s.stopFail = true; await button(p, 'Turn off and restore').click(); await status(p, 'restore_failed')
  check(await button(p, 'Turn off and restore').isEnabled(), 'Restore failure offers retry')
  check(await button(p, 'Turn on').count() === 0, 'No new start during failed restoration')
  check((await p.locator('[data-mac-power-state]').innerText()).includes('sudo pmset -a disablesleep 0') && await p.locator('[data-mac-power-state]').getByRole('button', { name: 'Copy command', exact: true }).count() === 1, 'Failed restoration shows the restore command with a copy button')
  s.stopFail = false; await button(p, 'Turn off and restore').click(); await status(p, 'ready')
  check(true, 'Explicit stop confirms restoration')
  s.startFail = true; await button(p, 'Turn on').click(); await status(p, 'unknown')
  check(await button(p, 'Turn on').isDisabled(), 'Uncertain activation without a reason requires fresh status before retry')
  check(await alert(p).isVisible(), 'Action error remains visible')
  s.statusFail = true; await refresh(p); await alert(p).filter({ hasText: 'Test status unavailable' }).waitFor()
  check(await p.locator('[data-mac-power-state="active"]').count() === 0, 'Lost verification never leaves an active claim')

  // 2. A refusal with a reason keeps the confirmed status and offers the one-click battery action.
  ;({ p, s } = await fixture(browser, { approved: true, status: { state: 'ready', lid_saver_supported: true, battery_percent: 58, on_battery: false, low_power_active: false } }))
  await status(p, 'ready')
  await refuse(p, s, { error: 'Connect the power adapter or allow battery use.', reason: 'battery_not_allowed' })
  check(await p.locator('[data-mac-power-state="ready"]').count() === 1, 'A refusal with a reason never flips the status to unknown')
  // The adapter was pulled just before the click; the next poll reports battery power.
  s.status.on_battery = true; await p.locator('[data-mac-power-line]').filter({ hasText: 'on battery' }).waitFor()
  const refusal = await alert(p).innerText()
  check(refusal.includes('Connect the power adapter or allow battery use.') && refusal.includes('until the battery reaches 20 %'), 'Battery refusal shows the server sentence and the 20 % sentence')
  check(await button(p, 'Allow battery use and turn on').count() === 1 && await button(p, 'Turn on').count() === 0 && await p.locator('[data-mac-power-battery-hint]').count() === 0, 'Battery refusal offers exactly one start action and replaces the pre-flight hint')
  await shoot(p, 'mac-power-battery-refused')
  s.refuse = { body: { error: 'This Mac is too warm right now.', reason: 'thermal_cutoff' } }
  await button(p, 'Allow battery use and turn on').click(); await p.locator('[data-mac-power-error="thermal_cutoff"]').waitFor()
  check(s.calls.at(-1).action === 'start' && s.calls.at(-1).body.allow_battery === true, 'One-click battery action posts allow_battery:true')
  check((await stored(p)) === null && !(await batteryBox(p).isChecked()), 'A refused one-click action saves nothing and leaves the checkbox unticked')
  await button(p, 'Allow battery use and turn on').click(); await status(p, 'active')
  check(await alert(p).count() === 0, 'A successful start clears the refusal')
  check(await batteryBox(p).isChecked() && (await stored(p)).allow_battery === true, 'The battery choice is ticked and saved only after macOS confirmed the start')

  // 3. Approval refusals point to Login Items; other reasons get their single action.
  ;({ p, s } = await fixture(browser, { status: { state: 'needs_approval', lid_saver_supported: true, ...POWER } }))
  await status(p, 'needs_approval')
  await refuse(p, s, { error: 'Allow IVE under Login Items & Extensions first.', reason: 'macos_helper_approval_required', settings_pane: 'login_items' })
  check(await p.locator('[data-mac-power-state="needs_approval"]').count() === 1, 'Approval refusal keeps the confirmed status')
  check(await button(p, 'Open Login Items & Extensions').count() === 1, 'Approval refusal shows exactly one Login Items action')
  reply = posted(p, '/api/mac-power/approval'); await alert(p).getByRole('button', { name: 'Open Login Items & Extensions', exact: true }).click(); await reply
  check(s.calls.at(-1).action === 'approval', 'Login Items button in the refusal calls the approval endpoint')
  check(await alert(p).count() === 1, 'Opening Login Items keeps the instructions until the status confirms approval')
  await alert(p).getByRole('button', { name: 'Check again', exact: true }).click(); await alert(p).waitFor({ state: 'hidden' })
  check(await button(p, 'Open Login Items & Extensions').count() === 1, 'After Check again the status card still offers Login Items')
  await shoot(p, 'mac-power-needs-approval')
  await refuse(p, s, { error: 'Update the IVE Mac app. If it is already current, turn the IVE item off and on in Login Items & Extensions, or restart the Mac.', reason: 'helper_outdated' })
  check(await alert(p).getByRole('button').count() === 1 && await alert(p).getByRole('button', { name: 'Open Login Items & Extensions', exact: true }).count() === 1 && await button(p, 'Open Login Items & Extensions').count() === 1, 'Outdated helper gets the Login Items button only, and only once on the screen')
  await refuse(p, s, { error: 'Another app or setting already prevents sleep.', reason: 'sleep_already_disabled_elsewhere' })
  check((await alert(p).innerText()).includes('sudo pmset -a disablesleep 0') && await alert(p).getByRole('button', { name: 'Copy command', exact: true }).count() === 1, 'Sleep conflict shows the restore command with a copy button')
  await refuse(p, s, { error: 'This feature needs the IVE Mac app.', reason: 'mac_app_required' })
  check(await alert(p).getByRole('button').count() === 0 && await p.locator('[data-mac-power-state="needs_approval"]').count() === 1, 'Mac app requirement is a sentence and keeps the status')
  await refuse(p, s, { error: 'This feature needs a MacBook with a built-in battery.', reason: 'battery_unavailable' })
  check(await alert(p).getByRole('button').count() === 0 && await start(p).isDisabled() && (await line(p)).startsWith('No battery ·'), 'Missing battery is a sentence without an action, disables the start and names the missing battery')

  // 4. Battery settings deep link and the pre-flight hint on battery.
  ;({ p, s } = await fixture(browser, { approved: true, status: { state: 'ready', lid_saver_supported: true, battery_percent: 43, on_battery: true, low_power_active: false } }))
  await status(p, 'ready')
  reply = posted(p, '/api/macos/open-settings'); await button(p, 'Open Battery settings').click(); await reply
  check(s.calls.at(-1).action === 'open-settings' && s.calls.at(-1).body.pane === 'battery', 'Battery settings button posts pane battery to /api/macos/open-settings')
  check((await p.locator('[data-mac-power-battery-hint]').innerText()) === 'You are on battery. Allow battery use or connect the power adapter.', 'On battery without the battery choice shows the pre-flight hint')
  check(await button(p, 'Allow battery use and turn on').count() === 1 && await button(p, 'Turn on').count() === 0, 'On battery the primary action allows battery use in one go')
  check((await p.locator('[data-mac-power-battery-sentence]').innerText()).includes('until the battery reaches 20 %'), 'The 20 % sentence sits under the pre-flight primary action')
  await shoot(p, 'mac-power-on-battery')
  await batteryBox(p).check()
  check(await p.locator('[data-mac-power-battery-hint]').count() === 0 && await p.locator('[data-mac-power-battery-sentence]').count() === 0 && await button(p, 'Turn on').count() === 1, 'Ticking the battery choice removes the hint and restores Turn on')
  await batteryBox(p).uncheck()
  await button(p, 'Allow battery use and turn on').click(); await status(p, 'active')
  check(s.calls.at(-1).action === 'start' && s.calls.at(-1).body.allow_battery === true, 'Pre-flight primary action posts allow_battery:true')
  check(await batteryBox(p).isChecked(), 'Pre-flight action ticks the battery choice')

  // 5. Browser-only and outdated helpers cannot activate anything; narrow layout holds.
  ;({ p, s } = await fixture(browser, { status: { state: 'unavailable', reason: 'mac_app_required', message: 'Closed-lid power control needs the IVE Mac app.' } })); await status(p, 'unavailable')
  check(await button(p, 'Turn on').isDisabled() && s.calls.length === 0, 'Browser-only installation cannot activate privileged actions')
  const card = await p.locator('[data-mac-power-state]').innerText()
  check(card.includes('Closed-lid power control needs the IVE Mac app.') && !card.includes('with its macOS helper'), 'Missing Mac app is explained once by the server sentence, without the generic repeat')
  check((await line(p)) === 'Battery level unknown · power source unknown', 'Unknown power facts are named, not faked')
  check(await p.getByRole('link', { name: 'Get the IVE Mac app' }).getAttribute('href') === 'https://ive.dev', 'Missing Mac app offers the download link')
  ;({ p, s } = await fixture(browser, { status: { state: 'ready', lid_saver_supported: false, ...POWER } })); await status(p, 'ready')
  check(await button(p, 'Turn on').isDisabled(), 'Older native helper cannot masquerade as supporting lid actions')
  check((await p.locator('[data-mac-power-state]').innerText()).includes('Update the IVE Mac app. If it is already current') && await button(p, 'Open Login Items & Extensions').count() === 1, 'Outdated helper status names the fix and offers Login Items')
  ;({ p, s } = await fixture(browser, { status: { state: 'blocked', reason: 'helper_connection_failed', settings_pane: 'login_items', message: 'The IVE background helper did not answer. Check that IVE is allowed under Login Items & Extensions, then try again.', lid_saver_supported: true, ...POWER } })); await status(p, 'blocked')
  check(await button(p, 'Turn on').isDisabled() && await button(p, 'Open Login Items & Extensions').count() === 1, 'Blocked status with a Login Items reason offers the pane from the status card')
  check(!(await p.locator('[data-mac-power-panel]').innerText()).includes('Settings >'), 'Only the arrow spelling of the Login Items path appears')
  await p.setViewportSize({ width: 390, height: 844 })
  check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Panel fits narrow screens without horizontal overflow')
  await shoot(p, 'mac-power-narrow')
  check(errors.length === 0, 'No JavaScript page errors: ' + errors.join('; '))
  console.log(JSON.stringify({ browser: engine, passed: checks.length, screenshots, evidence: 'Isolated UI fixtures. No native registration, power changes, System Settings or real app pauses.' }, null, 1))
} catch (e) {
  console.error(JSON.stringify({ browser: engine, passed: checks.length, failed: e.message, errors }, null, 1)); process.exitCode = 1
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close() }
