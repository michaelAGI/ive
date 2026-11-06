// Headless Playwright check of PhonePanel (iPhone setup card, availability,
// notes) against a mocked API. Run after `npm run build`:
//   node tests/phone-setup-browser.js            Chromium
//   IVE_QA_BROWSER=webkit node tests/phone-setup-browser.js
// IVE_QA_SHOTS sets the screenshot folder, IVE_QA_TMP the harness folder.
// Nothing here touches the network, Mac power, System Settings or an iPhone.
import { build } from 'esbuild'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.env.IVE_QA_TMP || '/tmp/ive-phone-setup-ui'
const shots = process.env.IVE_QA_SHOTS || path.join(root, '..', 'packaging', 'artifacts', 'phone-setup-ui')
const engine = process.env.IVE_QA_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const origin = 'http://ive-phone-setup.test'
const contexts = [], checks = [], errors = [], screenshots = []
const assert = (ok, name) => { if (!ok) throw new Error(name); checks.push(name) }
const accepted = { required: false, accepted: true, closed_lid_requested: true, allow_battery_requested: false }
const tunnel = { running: true, url: 'https://setup-fixture.example', cloudflared_installed: true }
const urls = [{ url: tunnel.url, kind: 'tunnel', label: 'Secure tunnel', secure: true }]

async function harness() {
  await mkdir(dir, { recursive: true }); await mkdir(shots, { recursive: true })
  await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import Panel from './src/components/settings/PhonePanel.jsx'; createRoot(document.getElementById('root')).render(<Panel/>);`, resolveDir: root, loader: 'jsx' }, bundle: true, jsx: 'automatic', format: 'esm', outfile: `${dir}/harness.js`, logLevel: 'silent' })
  await cp(`${root}/dist/assets`, `${dir}/assets`, { recursive: true })
  await cp(`${root}/dist/fonts`, `${dir}/fonts`, { recursive: true }).catch(() => {})
  const css = (await readdir(`${root}/dist/assets`)).find(name => /^index-.*\.css$/.test(name))
  await writeFile(`${dir}/index.html`, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/${css}"></head><body style="background:var(--color-x-surface);margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/harness.js"></script></body></html>`)
}
async function fixture(browser, options = {}) {
  const state = { calls: [], statusFail: false, failSetup: false, failTunnel: false, failStop: false, approved: false, refuseStart: null, ...options }
  state.status = { desktop: true, is_local_owner: true, is_device: false, pin_enabled: false, pin_min_length: 6, idle_minutes: 15, setup: { required: true, accepted: false, closed_lid_requested: false, allow_battery_requested: false }, availability: { state: 'not_registered' }, tunnel: { running: false, cloudflared_installed: true }, urls: [], ...(options.status || {}) }
  const context = await browser.newContext({ viewport: { width: 1100, height: 950 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); contexts.push(context)
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method()
    if (url.origin !== origin) return route.fulfill({ status: 403, body: 'External request blocked' })
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ path: dir + (url.pathname === '/' ? '/index.html' : url.pathname) })
    const path = url.pathname.slice(4); let body; try { body = req.postDataJSON() } catch { /* GET */ }
    if (method !== 'GET') state.calls.push({ path, method, body })
    const send = (json, status = 200) => route.fulfill({ json, status })
    if (path === '/phone/status') return state.statusFail ? send({ error: 'Test status unavailable' }, 503) : send(state.status)
    if (path === '/phone/devices') return send({ devices: [] })
    if (path === '/phone/apns') return send({ configured: false, can_edit: false, transport: true, devices: [] })
    if (path === '/macos/open-settings') return send({ ok: true, pane: body.pane })
    if (path === '/phone/setup') {
      if (state.failSetup) return send({ error: 'Test consent save failed' }, 503)
      state.status.setup = { required: false, accepted: true, closed_lid_requested: body.closed_lid, allow_battery_requested: body.allow_battery }; return send(state.status.setup)
    }
    if (path === '/runtime/tunnel/start') {
      if (state.failTunnel) return send({ error: 'Test tunnel unavailable' }, 503)
      state.status.tunnel = { ...tunnel }; state.status.urls = urls.map(x => ({ ...x })); return send({ ok: true, ...tunnel })
    }
    if (path === '/phone/availability/start') {
      if (state.refuseStart && !state.status.setup.allow_battery_requested) return send({ state: state.status.availability.state, settings_pane: null, ...state.refuseStart }, 409)
      state.status.availability = state.approved ? { state: 'active', allow_battery: state.status.setup.allow_battery_requested, battery_floor: 20, expires_at: '2026-10-11T23:00:00Z', lease_id: 'SHOULD_NEVER_RENDER' } : { state: 'needs_approval', reason: 'macos_helper_approval_required', message: 'SERVER_REPEATS_THE_LOGIN_ITEMS_PATH' }
      return send(state.status.availability)
    }
    if (path === '/phone/availability/approval') return send(state.status.availability)
    if (path === '/phone/availability/stop') {
      state.status.availability = { state: state.failStop ? 'restore_failed' : 'stopped' }
      return state.failStop ? send({ error: 'Test restore failed' }, 503) : send(state.status.availability)
    }
    if (path === '/phone/pair/start') return send({ code: 'SETUP42', code_display: 'SET UP 42', expires_at: new Date(Date.now() + 300000).toISOString(), urls: state.status.urls.map(u => ({ ...u, pair_url: u.url + '/pair#SETUP42' })) })
    return send({ error: 'Unexpected fixture operation: ' + path }, 500)
  })
  const p = await context.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', e => errors.push(e.message)); await p.goto(origin); await p.locator('[data-phone-setup]').waitFor()
  // Icons transition on theme change; screenshots must not catch them half-way.
  await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important }' }); return { p, state }
}
async function shoot(p, name) {
  for (const theme of ['dark', 'light']) {
    await p.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
    const file = path.join(shots, `${name}-${theme}-${engine}.png`); await p.screenshot({ path: file }); screenshots.push(file)
  }
  await p.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
}
const button = (p, name) => p.getByRole('button', { name, exact: true })
const settled = (p, progress) => p.getByText(progress, { exact: true }).waitFor({ state: 'hidden' })
async function save(p) { await button(p, 'Agree and set up iPhone access').click(); await button(p, 'Review permissions').waitFor(); await settled(p, 'Saving your choices and connecting this Mac…') }
const control = p => p.getByRole('checkbox', { name: /Allow my paired phone to control IVE/ })
const lid = p => p.getByRole('checkbox', { name: /Keep this Mac available with the lid closed/ })
const battery = p => p.getByRole('checkbox', { name: 'Also run on battery (optional)', exact: true })
const toggle = p => p.getByRole('switch', { name: 'Also run on battery', exact: true })
const powerCalls = state => state.calls.filter(c => c.path.includes('/availability/')).map(c => c.path)

const browser = await (engine === 'webkit' ? webkit : chromium).launch()
try {
  await harness()
  let { p, state } = await fixture(browser, { status: { tunnel: { ...tunnel }, urls: urls.map(x => ({ ...x })) } })
  assert(!(await control(p).isChecked()), 'Full-control consent starts unchecked')
  assert(!(await lid(p).isChecked()), 'Closed-lid mode starts as an explicit optional choice')
  assert(await button(p, 'Agree and set up iPhone access').isDisabled(), 'Setup cannot proceed without consent')
  assert(await p.locator('[data-phone-pair-start]').isDisabled(), 'Existing tunnel alone cannot bypass consent for QR')
  assert(state.calls.length === 0, 'Opening setup never changes network or Mac power')
  await lid(p).check(); assert(!(await battery(p).isChecked()), 'Battery access is a separate unchecked option')
  await shoot(p, 'phone-setup-choices')
  await lid(p).uncheck(); await control(p).check(); await save(p)
  assert(powerCalls(state).length === 0, 'First-time normal-sleep setup makes no OS power request')
  assert(state.status.setup.accepted && !state.status.setup.closed_lid_requested, 'Only chosen consent options are saved')
  assert(await toggle(p).count() === 0, 'Without closed-lid access there is no battery toggle')
  assert(await p.locator('[data-phone-pair-start]').isEnabled(), 'Confirmed consent plus actual tunnel enables QR')
  await p.locator('[data-phone-pair-start]').click(); await p.locator('[data-phone-pair-code="SETUP42"]').waitFor()
  assert(true, 'Fresh code can be requested after consent and connection')
  const reply = p.waitForResponse(r => r.url().endsWith('/api/macos/open-settings')); await p.locator('[data-phone-notes]').getByRole('button', { name: 'Open Battery settings', exact: true }).click(); await reply
  assert(state.calls.at(-1).path === '/macos/open-settings' && state.calls.at(-1).body.pane === 'battery', 'Good-to-know card opens the Battery pane through the backend')

  ;({ p, state } = await fixture(browser, { failSetup: true })); await control(p).check()
  await button(p, 'Agree and set up iPhone access').click(); await p.getByRole('alert').filter({ hasText: 'Test consent save failed' }).waitFor()
  assert(!state.calls.some(c => c.path === '/runtime/tunnel/start'), 'Failed consent never starts a tunnel')
  assert(await p.locator('[data-phone-pair-start]').isDisabled(), 'Failed consent cannot enable QR')

  ;({ p, state } = await fixture(browser, { failTunnel: true })); await control(p).check(); await lid(p).check(); await battery(p).check(); await save(p)
  await p.getByRole('alert').filter({ hasText: 'Test tunnel unavailable' }).waitFor()
  assert(state.status.setup.accepted && state.status.setup.closed_lid_requested, 'Partial setup retains the actually saved choices')
  assert(!state.calls.some(c => c.path === '/phone/availability/start'), 'Power activation waits for a successful tunnel')
  assert(await p.locator('[data-phone-pair-start]').isDisabled(), 'Saved choices without a live tunnel never enable QR')
  assert((await p.locator('[data-phone-setup]').innerText()).includes('does not grant macOS approval'), 'Saved preference is explicitly distinct from OS approval')
  state.failTunnel = false; await button(p, 'Keep Mac available').click(); await p.locator('[data-phone-availability="needs_approval"]').waitFor()
  assert((await p.locator('[data-phone-availability="needs_approval"]').innerText()).includes('Login Items & Extensions'), 'Missing approval names the System Settings pane')
  assert(!(await p.locator('[data-phone-setup]').innerText()).includes('SERVER_REPEATS'), 'Approval status gives the Login Items path once, not the server repeat as well')
  assert(await button(p, 'Open Login Items & Extensions').isVisible(), 'Missing macOS approval has a concrete settings action')
  await button(p, 'Open Login Items & Extensions').click(); await settled(p, 'Opening Login Items & Extensions…')
  assert(powerCalls(state).at(-1) === '/phone/availability/approval', 'Login Items button calls the approval endpoint')
  await button(p, 'Continue after approval').click(); await settled(p, 'Checking approval and starting availability…'); await p.locator('[data-phone-availability="needs_approval"]').waitFor()
  assert(await p.locator('[data-phone-availability="active"]').count() === 0, 'Opening settings or continuing before approval cannot claim active')
  state.approved = true; await button(p, 'Continue after approval').click(); await p.locator('[data-phone-availability="active"]').waitFor()
  let text = await p.locator('[data-phone-setup]').innerText()
  assert(text.includes('Control-Command-Q') && text.includes('works while the screen is locked'), 'Active mode instructs manual locking without claiming automatic screen lock')
  assert(text.includes('maximum 8 hours') && text.includes('20%') && text.includes('high temperature') && text.includes('Closing IVE'), 'Active mode explains duration, battery, heat and app-exit limits')
  assert(!text.includes('SHOULD_NEVER_RENDER'), 'Internal lease data never appears in UI')
  await shoot(p, 'phone-setup-active')
  // Standalone battery toggle: rewrites the saved setup, restarts the lease, never reopens consent.
  assert(await toggle(p).getAttribute('aria-checked') === 'true', 'Battery toggle mirrors the saved battery choice')
  let before = state.calls.length
  await toggle(p).click(); await settled(p, 'Switching to power adapter only…'); await p.locator('[data-phone-battery-toggle][aria-checked="false"]').waitFor()
  let seq = state.calls.slice(before)
  assert(seq[0].path === '/phone/setup' && seq[0].body.allow_battery === false && seq[0].body.closed_lid === true && seq[0].body.remote_control === true, 'Battery toggle re-saves the setup with only the battery flag flipped')
  assert(seq.map(c => c.path).slice(1).join(',') === '/phone/availability/stop,/runtime/tunnel/start,/phone/availability/start', 'Battery toggle stops the active lease before starting it with the new choice')
  assert(state.status.availability.allow_battery === false && await button(p, 'Agree and set up iPhone access').count() === 0, 'Toggling battery never reopens the consent form')
  before = state.calls.length
  await toggle(p).click(); await settled(p, 'Allowing battery use…'); await p.locator('[data-phone-battery-toggle][aria-checked="true"]').waitFor()
  seq = state.calls.slice(before)
  assert(seq[0].body.allow_battery === true && state.status.availability.allow_battery === true, 'Battery toggle turns battery use back on')
  await button(p, 'Review permissions').click(); await battery(p).uncheck(); await control(p).check(); await save(p)
  assert(powerCalls(state).at(-2) === '/phone/availability/stop' && powerCalls(state).at(-1) === '/phone/availability/start', 'Changing active battery permission in the form stops the old mode before reactivation')
  assert(state.status.availability.allow_battery === false, 'Active mode reflects the newly confirmed battery choice')
  await button(p, 'Review permissions').click(); await battery(p).check(); await button(p, 'Cancel').first().click(); await button(p, 'Review permissions').click()
  assert(!(await battery(p).isChecked()) && !(await control(p).isChecked()), 'Review reloads saved choices after Cancel and requires fresh consent')
  await button(p, 'Cancel').first().click(); state.failStop = true; await button(p, 'Restore normal sleep').click(); await p.locator('[data-phone-availability="restore_failed"]').waitFor()
  assert(await button(p, 'Restore normal sleep').isEnabled(), 'Restore failure remains visible with a retry action')
  assert(await button(p, 'Keep Mac available').count() === 0, 'Failed restoration never offers a conflicting new start')
  state.failStop = false; await button(p, 'Restore normal sleep').click(); await p.locator('[data-phone-availability="stopped"]').waitFor(); assert(true, 'Successful retry confirms normal sleep')

  // battery_not_allowed: the refusal keeps its reason and offers Allow battery use as the only primary action.
  ;({ p, state } = await fixture(browser, { approved: true, refuseStart: { error: 'Connect the power adapter or allow battery use.', reason: 'battery_not_allowed' }, status: { availability: { state: 'ready', on_battery: true, battery_percent: 58 }, tunnel: { ...tunnel }, urls: urls.map(x => ({ ...x })) } }))
  await control(p).check(); await lid(p).check(); await save(p)
  await p.locator('[data-phone-setup-error="battery_not_allowed"]').waitFor()
  assert(state.status.setup.closed_lid_requested && !state.status.setup.allow_battery_requested, 'A refused start leaves the saved power-adapter choice in place')
  assert(await p.locator('[data-phone-availability="active"]').count() === 0, 'A refused start never claims active')
  text = await p.getByRole('alert').innerText()
  assert(text.includes('Connect the power adapter or allow battery use.') && text.includes('until the battery reaches 20 %'), 'Battery refusal shows the server sentence and the 20 % sentence')
  assert(await button(p, 'Allow battery use').count() === 1 && await button(p, 'Keep Mac available').count() === 0 && await p.locator('[data-phone-battery-hint]').count() === 0, 'Battery refusal offers exactly one start action and replaces the pre-flight hint')
  assert(await p.locator('[data-phone-setup] [role="alert"] ~ div button').count() > 0, 'The refusal sits above the action row')
  await shoot(p, 'phone-setup-battery-refused')
  before = state.calls.length
  await button(p, 'Allow battery use').click(); await settled(p, 'Allowing battery use…'); await p.locator('[data-phone-availability="active"]').waitFor()
  seq = state.calls.slice(before)
  assert(seq[0].path === '/phone/setup' && seq[0].body.allow_battery === true && seq[0].body.closed_lid === true && seq.at(-1).path === '/phone/availability/start', 'Allow battery use re-saves with battery allowed and retries the start')
  assert(state.status.availability.allow_battery === true && await p.getByRole('alert').count() === 0 && await button(p, 'Agree and set up iPhone access').count() === 0, 'Battery retry activates, clears the refusal and keeps the consent form closed')
  assert(await toggle(p).getAttribute('aria-checked') === 'true', 'Battery toggle reflects the new choice')

  // Pre-flight on battery: a hint before the click, the restore command with a copy button for a sleep conflict.
  ;({ p, state } = await fixture(browser, { status: { setup: { ...accepted }, availability: { state: 'ready', on_battery: true, battery_percent: 58 }, tunnel: { ...tunnel }, urls: urls.map(x => ({ ...x })) } }))
  assert((await p.locator('[data-phone-battery-hint]').innerText()) === 'You are on battery. Allow battery use or connect the power adapter.' && await button(p, 'Keep Mac available').count() === 1, 'On battery without the battery choice shows the pre-flight hint')
  state.refuseStart = { error: 'Another app or setting already keeps this Mac awake.', reason: 'sleep_already_disabled_elsewhere' }
  await button(p, 'Keep Mac available').click(); await p.locator('[data-phone-setup-error="sleep_already_disabled_elsewhere"]').waitFor()
  assert((await p.getByRole('alert').innerText()).includes('sudo pmset -a disablesleep 0') && await p.getByRole('alert').getByRole('button', { name: 'Copy command', exact: true }).count() === 1, 'Sleep conflict shows the restore command with a copy button')
  state.refuseStart = null; await toggle(p).click(); await settled(p, 'Allowing battery use…'); await p.locator('[data-phone-battery-toggle][aria-checked="true"]').waitFor()
  assert(await p.locator('[data-phone-battery-hint]').count() === 0 && await p.getByRole('alert').count() === 0, 'Allowing battery use removes the hint and the stale refusal')
  // An unreachable helper leaves the status screen up and offers the pane it names.
  ;({ p, state } = await fixture(browser, { status: { setup: { ...accepted }, availability: { state: 'unknown', reason: 'helper_connection_failed', settings_pane: 'login_items', message: 'The IVE background helper did not answer. Check that IVE is allowed under Login Items & Extensions, then try again.', battery_floor: 20 }, tunnel: { ...tunnel }, urls: urls.map(x => ({ ...x })) } }))
  await p.locator('[data-phone-availability="unknown"]').waitFor()
  assert((await p.locator('[data-phone-availability="unknown"]').innerText()).includes('did not answer') && await button(p, 'Open Login Items & Extensions').count() === 1 && await button(p, 'Keep Mac available').count() === 0, 'Unreachable helper shows its sentence with the Login Items action and no start')
  ;({ p, state } = await fixture(browser, { status: { setup: { ...accepted }, availability: { state: 'active', allow_battery: false }, tunnel: { ...tunnel }, urls: urls.map(x => ({ ...x })) } }))
  await p.locator('[data-phone-pair-start]').click(); await p.locator('[data-phone-pair-code]').waitFor(); state.statusFail = true
  await button(p, 'Check availability').click(); await p.locator('[data-phone-availability="unknown"]').waitFor()
  assert(await p.locator('[data-phone-pair-code]').count() === 0 && await p.locator('[data-phone-pair-start]').isDisabled(), 'Status failure removes stale QR and disables new pairing')
  assert(await p.locator('[data-phone-availability="active"]').count() === 0, 'Unverified status cannot leave a false active indicator')
  assert(await button(p, 'Keep Mac available').count() === 0 && await p.locator('[data-phone-tunnel-start]').count() === 0, 'Unknown status requires checking before another start')
  assert(await p.getByText('Connection status could not be checked', { exact: true }).isVisible(), 'Unknown connection is not misrepresented as a confirmed disconnection')
  await shoot(p, 'phone-setup-unverified')
  assert(errors.length === 0, 'No JavaScript page errors: ' + errors.join('; '))
  console.log(JSON.stringify({ browser: engine, passed: checks.length, screenshots, evidence: 'Isolated PhonePanel UI with stubbed network and helper APIs; no real OS power, System Settings or iPhone.' }, null, 1))
} catch (e) {
  console.error(JSON.stringify({ browser: engine, passed: checks.length, failed: e.message, errors }, null, 1)); process.exitCode = 1
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close() }
