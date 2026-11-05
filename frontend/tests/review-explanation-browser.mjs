import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

let server, browser, page, base, cacheDir
const calls = []
let responseMode = 'completed'
let staleResponse = false
let failPoll = false
const fixtureSource = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewContextCard from '/src/components/session/ReviewContextCard.jsx';
import ReviewActions from '/src/components/session/ReviewActions.jsx';
window.holdNextReviewRefresh=()=>{window.__reviewHold=true};
function refreshMaterial(){if(!window.__reviewHold)return Promise.resolve();window.__reviewHold=false;return new Promise(resolve=>window.releaseReviewRefresh=resolve)}
function Fixture() {
 const [provider,setProvider]=useState('claude'); const [sid,setSid]=useState('one'); const [notes,setNotes]=useState(0);
 window.changeReviewSession=setSid; window.changeReviewNotes=setNotes; window.reviewActions=[];
 return React.createElement(React.Fragment,null,
 React.createElement(ReviewContextCard,{session:{id:sid,name:'Session '+sid,cli_type:'claude',model:'opus',account_id:'claude-account'},workspace:{name:'Project'},scope:'working',selectedFile:null,diffText:'+ fixed login',provider,onProviderChange:setProvider,onRefresh:refreshMaterial}),
 React.createElement('pre',null,'+ fixed login'),
 React.createElement(ReviewActions,{annotationsCount:notes,providerLabel:provider==='codex'?'Codex':'Claude',sessionName:'Session '+sid,onFeedback:()=>window.reviewActions.push('feedback'),onStartReview:()=>window.reviewActions.push('review'),onCopy:()=>window.reviewActions.push('copy')})
 );
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`
const fixture = '<!doctype html><html><body><main id="root" style="width:380px"></main><script type="module" src="/__review-fixture.jsx"></script></body></html>'

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'ive-review-fixture-'))
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
    cacheDir,
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'lucide-react', 'react-markdown', 'remark-gfm'] },
    esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
    plugins: [{ name: 'review-fixture', resolveId(id) { if (id === '/__review-fixture.jsx') return '\0review-fixture' }, load(id) { if (id === '\0review-fixture') return fixtureSource }, configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url?.split('?')[0] !== '/__review-fixture') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__review-fixture', fixture)) }) } }],
  })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => console.error('Review fixture browser error:', error.message))
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const url = new URL(req.url()); const body = req.postDataJSON();
    calls.push({ path: url.pathname, method: req.method(), body })
    let result
    if (url.pathname.endsWith('/context')) {
      const sid = url.searchParams.get('reviewed_session_id')
      result = { session: { id: sid, name: 'Session '+sid }, workspace: { name: 'Project' }, task: { title: 'Fix login '+sid }, original_prompt: { text: 'Repair the expired login link' }, reason: { text: 'No review was scheduled.', recorded: false }, scope: 'working', revision: 'rev-'+sid, files: [{ path: 'login.js' }], scope_warning: 'These are shared project changes.' }
    } else if (req.method() === 'DELETE') result = { status: 'cancelled' }
    else if (url.pathname.endsWith('/ask')) result = { id: body.request_id, status: responseMode, answer: 'Check the login expiry against the original request.', cli_type: body.cli_type, stale: staleResponse }
    else if (failPoll) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Connection interrupted' }) }); return }
    else result = { status: 'running' }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
  })
})
after(async () => { await browser?.close(); await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }) })

test('opening review shows provenance without generating an answer or starting a reviewer', async () => {
  await page.goto(`${base}/__review-fixture`)
  await page.getByText('Fix login one', { exact: false }).waitFor()
  assert.equal(calls.filter(c => c.method === 'POST').length, 0)
  assert.equal(await page.getByText('No review was scheduled.').count(), 1)
  await page.getByText('Original request', { exact: true }).click()
  assert.ok(await page.getByText('Repair the expired login link').isVisible())
  assert.ok(await page.getByText('+ fixed login', { exact: true }).isVisible())
})

test('explain and provider switching only call explanation endpoints', async () => {
  await page.getByRole('button', { name: 'Explain this', exact: true }).click()
  await page.getByText('Check the login expiry against the original request.', { exact: true }).waitFor()
  const first = calls.find(c => c.method === 'POST').body
  assert.equal(first.reviewed_session_id, 'one'); assert.equal(first.revision, 'rev-one')
  assert.equal(first.model, 'opus'); assert.equal(first.account_id, 'claude-account')
  await page.getByRole('combobox', { name: 'Explanation provider' }).selectOption('codex')
  await page.getByRole('button', { name: 'Why another agent?', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.ive-review-explanation-message.is-assistant').length === 2)
  const last = calls.filter(c => c.method === 'POST').at(-1).body
  assert.equal(last.cli_type, 'codex'); assert.equal(last.question_kind, 'separate_agent')
  assert.equal(last.model, undefined); assert.equal(last.account_id, undefined)
  assert.ok(calls.every(c => c.path.startsWith('/api/review/explanation/')))
})

test('feedback and reviewer launch are separate actions before and after annotation', async () => {
  const feedback = page.getByRole('button', { name: /Send feedback to this chat/ })
  assert.equal(await feedback.isDisabled(), true)
  await page.evaluate(() => window.changeReviewNotes(1))
  await page.getByRole('button', { name: 'Send feedback to this chat (1)' }).click()
  await page.getByRole('button', { name: 'Start review with Codex…' }).click()
  assert.deepEqual(await page.evaluate(() => window.reviewActions), ['feedback', 'review'])
})

test('switching review target cancels the pending explanation and clears old context', async () => {
  responseMode = 'running'
  await page.getByRole('button', { name: 'Explain this', exact: true }).click()
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  const requestId = calls.filter(c => c.method === 'POST').at(-1).body.request_id
  await page.evaluate(() => window.changeReviewSession('two'))
  await page.getByText('Fix login two', { exact: false }).waitFor()
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path.endsWith(requestId)))
  assert.equal(await page.locator('.ive-review-explanation-message').count(), 0)
})

test('a stale answer is labelled and requires a refreshed snapshot', async () => {
  responseMode = 'completed'; staleResponse = true
  await page.getByRole('button', { name: 'Explain this', exact: true }).click()
  await page.getByText('The changes have moved on. Refresh the context before asking again.').waitFor()
  assert.ok(await page.getByRole('button', { name: 'Explain this', exact: true }).isDisabled())
  await page.getByRole('button', { name: 'Refresh review context' }).click()
  await page.waitForFunction(() => !document.querySelector('.ive-review-explain-controls button').disabled)
  assert.equal(await page.locator('.ive-review-explanation-message').count(), 0)
})

test('unknown polling outcome keeps cancellation available and prevents duplicate work', async () => {
  responseMode = 'running'; staleResponse = false; failPoll = true
  await page.getByRole('button', { name: 'Explain this', exact: true }).click()
  await page.getByRole('button', { name: 'Stop pending request' }).waitFor()
  const posts = calls.filter(c => c.method === 'POST').length
  assert.ok(await page.getByRole('button', { name: 'Explain this', exact: true }).isDisabled())
  await page.waitForTimeout(1100)
  assert.equal(calls.filter(c => c.method === 'POST').length, posts)
  await page.getByRole('button', { name: 'Stop pending request' }).click()
  assert.equal(await page.getByRole('button', { name: 'Explain this', exact: true }).isDisabled(), false)
})

test('refresh prevents requests against old context until visible material has loaded', async () => {
  const contexts = calls.filter(c => c.path.endsWith('/context')).length
  const posts = calls.filter(c => c.method === 'POST').length
  await page.evaluate(() => window.holdNextReviewRefresh())
  await page.getByRole('button', { name: 'Refresh review context' }).click()
  assert.ok(await page.getByRole('button', { name: 'Explain this', exact: true }).isDisabled())
  assert.ok(await page.getByRole('button', { name: 'Why another agent?', exact: true }).isDisabled())
  await page.waitForTimeout(200)
  assert.equal(calls.filter(c => c.path.endsWith('/context')).length, contexts)
  assert.equal(calls.filter(c => c.method === 'POST').length, posts)
  await page.evaluate(() => window.releaseReviewRefresh())
  await page.waitForFunction(() => !document.querySelector('.ive-review-explain-controls button').disabled)
  assert.equal(calls.filter(c => c.path.endsWith('/context')).length, contexts + 1)
})
