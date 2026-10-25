// Tasks board (⌘B) review flow against the built frontend with a mocked API:
// four review cards from the lane contract (guided + verified, agent-reported,
// backstop, guided with a failed verification and a deleted session), column
// hints and empty states, card content and actions, the modal's Review tab,
// Accept (with a verified run, without a run, with a failed run), Send back
// (posts the note), the attention modal route and the renamed navigation.
// Light and dark at 1440 px plus a 390 px phone check of the modal header;
// screenshots land in packaging/artifacts/task-board-20261025/.
//   cd frontend && npm run build && node tests/task-board-review.mjs
//   IVE_QA_BROWSER=webkit node tests/task-board-review.mjs
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
import { COLUMNS } from '../src/lib/boardColumns.js'
import { TOUR_VERSION } from '../src/lib/onboarding.js'

const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const out = new URL('../../packaging/artifacts/task-board-20261025/', import.meta.url).pathname
await mkdir(out, { recursive: true })

const workspace = { id: 'w', name: 'Demo shop', path: '/isolated/demo', auto_test_enabled: 1 }
const session = (id, name, status, alive, extra = {}) => ({ id, workspace_id: 'w', name, cli_type: 'claude', model: 'sonnet', status, agentState: status === 'running' ? 'working' : 'idle', pty_alive: alive, session_type: 'worker', tags: [], ...extra })
const sessions = [
  session('s-guided', 'Worker: rate limit', 'idle', true, { worktree_path: '/isolated/demo/.ive/worktrees/rate-limit' }),
  session('s-agent', 'Checkout worker', 'running', true),
  session('s-idle', 'Docs cleanup', 'exited', false),
]
const base = { workspace_id: 'w', status: 'review', priority: 'normal', created_at: '2026-10-25T08:00:00Z', updated_at: '2026-10-25T09:00:00Z', iteration: 1 }
const guidedSummary = 'Added a sliding window limiter (5 attempts per minute per IP) and wired it into the login route. Two new tests cover the limit and the reset.'
const tasks = () => [
  {
    ...base, id: 't-guided', title: 'Add rate limiting to the login endpoint', description: 'Limit login attempts per IP.', labels: ['ive-guided'], origin: 'guided',
    assigned_session_id: 's-guided', assigned_session_name: 'Worker: rate limit', assigned_session_status: 'idle', assigned_session_alive: true,
    worktree_path: '/isolated/demo/.ive/worktrees/rate-limit', branch_label: 'lane/rate-limit',
    files_changed: ['backend/auth/limiter.py', 'backend/auth/routes.py', 'backend/test_limiter.py'], files_changed_count: 3,
    verification: 'passed', latest_run_id: 'run-1', latest_run_summary: guidedSummary,
    latest_run_verify_summary: 'Ran the backend suite: 4 tests passed, including the two new limiter tests.',
    result_summary: `__pipeline_result:pass:${guidedSummary}`, result_text: guidedSummary,
  },
  {
    ...base, id: 't-agent', title: 'Fix the checkout total rounding', description: 'Invoice totals drift by a cent.', labels: [], origin: 'agent',
    assigned_session_id: 's-agent', assigned_session_name: 'Checkout worker', assigned_session_status: 'running', assigned_session_alive: true,
    worktree_path: null, branch_label: 'main', files_changed: ['src/cart/total.js'], files_changed_count: 1,
    verification: 'none', latest_run_id: null, latest_run_summary: null, latest_run_verify_summary: null,
    result_summary: 'Rounded the cart total once at the end instead of per line. The 0.01 drift in the invoice is gone.',
    result_text: 'Rounded the cart total once at the end instead of per line. The 0.01 drift in the invoice is gone.',
  },
  {
    ...base, id: 't-backstop', title: '[auto-triage] Docs cleanup', labels: ['auto-triage'], origin: 'backstop',
    description: 'Session "Docs cleanup" edited 2 files (README.md, docs/setup.md), then went idle without a report.',
    assigned_session_id: 's-idle', assigned_session_name: 'Docs cleanup', assigned_session_status: 'exited', assigned_session_alive: false,
    worktree_path: null, branch_label: null, files_changed: ['/isolated/demo/README.md', '/isolated/demo/docs/setup.md'], files_changed_count: 2,
    verification: 'none', latest_run_id: null, result_summary: null,
    result_text: 'Session "Docs cleanup" edited 2 files (README.md, docs/setup.md), then went idle without a report.',
  },
  {
    // Run finished, verification failed, session deleted since: Accept still
    // works (no reviewed_run_id), "Open session" gives way to a muted note.
    ...base, id: 't-failed', title: 'Speed up the product search', description: 'Search takes three seconds.', labels: ['ive-guided'], origin: 'guided',
    assigned_session_id: 's-gone', assigned_session_name: 'Search worker', assigned_session_status: 'exited', assigned_session_alive: false,
    worktree_path: null, branch_label: 'main', files_changed: ['src/search/index.js'], files_changed_count: 1,
    verification: 'failed', latest_run_id: 'run-2', latest_run_summary: 'Added an index on product names.',
    latest_run_verify_summary: 'One of three search tests failed: the empty query still scans every row.',
    result_summary: '__pipeline_result:pass:Added an index on product names.', result_text: 'Added an index on product names.',
  },
]
const runs = [{
  id: 'run-1', task_id: 't-guided', workspace_id: 'w', pipeline_id: 'p1', status: 'completed', created_at: '2026-10-25T08:30:00Z', completed_at: '2026-10-25T09:00:00Z',
  current_stages: [], iteration: 1, max_iterations: 3, variables: {},
  stage_history: {
    implement: { status: 'completed', output_summary: `__pipeline_result:pass:${guidedSummary}` },
    verify: { status: 'completed', output_summary: '__pipeline_result:pass:Ran the backend suite: 4 tests passed, including the two new limiter tests.' },
  },
}, {
  id: 'run-2', task_id: 't-failed', workspace_id: 'w', pipeline_id: 'p1', status: 'completed', created_at: '2026-10-25T08:40:00Z', completed_at: '2026-10-25T09:05:00Z',
  current_stages: [], iteration: 1, max_iterations: 3, variables: {},
  stage_history: {
    implement: { status: 'completed', output_summary: '__pipeline_result:pass:Added an index on product names.' },
    verify: { status: 'completed', output_summary: '__pipeline_result:fail:One of three search tests failed: the empty query still scans every row.' },
  },
}]
const events = {
  't-guided': [
    { id: 2, task_id: 't-guided', event_type: 'status_changed', actor: 'pipeline', new_value: 'review', message: 'Pipeline set task to review', created_at: '2026-10-25T09:00:00Z' },
    { id: 1, task_id: 't-guided', event_type: 'created', actor: 'user', message: 'Card created from the guided flow', created_at: '2026-10-25T08:00:00Z' },
  ],
  't-agent': [{ id: 3, task_id: 't-agent', event_type: 'status_changed', actor: 'agent', new_value: 'review', message: 'Checkout worker reported the fix', created_at: '2026-10-25T09:10:00Z' }],
}
const diff = [
  'diff --git a/backend/auth/limiter.py b/backend/auth/limiter.py', 'new file mode 100644', '--- /dev/null', '+++ b/backend/auth/limiter.py', '@@ -0,0 +1,6 @@',
  '+WINDOW = 60', '+LIMIT = 5', '+', '+def allow(ip, now, hits):', '+    recent = [t for t in hits.get(ip, []) if now - t < WINDOW]', '+    return len(recent) < LIMIT',
  'diff --git a/backend/auth/routes.py b/backend/auth/routes.py', '--- a/backend/auth/routes.py', '+++ b/backend/auth/routes.py', '@@ -10,3 +10,5 @@ async def login(request):',
  '     body = await request.json()', '-    user = await authenticate(body)', '+    if not allow(request.remote, time.time(), HITS):', '+        return web.json_response({"error": "too many attempts"}, status=429)', '+    user = await authenticate(body)',
].join('\n')

const results = []
let failed = false
try {
  for (const theme of ['light', 'dark']) {
    const f = await createTourFixture(browser, {
      theme, width: 1440, height: 1000, settings: { product_tour_version: String(TOUR_VERSION) },
      workspaces: [workspace], sessions, tasks: tasks(), runs, diff,
    })
    const p = f.page
    const iterations = [], puts = []
    await f.context.route('**/api/tasks/*/events', (route) => route.fulfill({ json: events[new URL(route.request().url()).pathname.split('/').at(-2)] || [] }))
    await f.context.route('**/api/tasks/*/iterate', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2)
      const task = f.data.tasks.find((item) => item.id === id)
      iterations.push({ id, body: route.request().postDataJSON() })
      Object.assign(task, { status: 'todo', iteration: (task.iteration || 1) + 1, assigned_session_id: null, assigned_session_name: null, result_summary: null, result_text: '' })
      return route.fulfill({ json: task })
    })
    // The fixture only accepts verified runs; the backstop card has none and the
    // failed card's run did not pass, so their plain PUTs are answered here (the
    // backend accepts any review card without reviewed_run_id).
    await f.context.route(/\/api\/tasks\/(t-backstop|t-failed)$/, (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      const id = new URL(route.request().url()).pathname.split('/').at(-1)
      const body = route.request().postDataJSON()
      puts.push({ id, body })
      const task = f.data.tasks.find((item) => item.id === id)
      Object.assign(task, body)
      return route.fulfill({ json: task })
    })

    // C1: navigation labels.
    await p.locator('[data-nav="board"]').waitFor()
    assert.equal((await p.locator('[data-nav="board"]').innerText()).trim().split('\n')[0], 'Overview')
    assert.equal((await p.locator('[data-nav="review"]').innerText()).trim(), 'Changes')

    const board = p.getByTestId('feature-board')
    const card = (id) => board.locator(`[data-task-id="${id}"]`)
    const modal = (id) => p.locator(`[data-task-modal="${id}"]`)

    if (theme === 'light') {
      // C3: the attention modal's Review opens the card on its Review tab.
      await p.locator('.ive-needs-you').click()
      const attention = p.getByRole('dialog', { name: 'Needs your attention' })
      await attention.locator('.ive-attention-item').filter({ hasText: 'Add rate limiting' }).getByRole('button', { name: 'Review', exact: true }).click()
      await modal('t-guided').waitFor()
      assert.equal(await modal('t-guided').getAttribute('data-task-tab'), 'review')
      await p.keyboard.press('Escape')
      await modal('t-guided').waitFor({ state: 'hidden' })
      await board.waitFor()
    } else {
      await p.keyboard.press('Meta+b')
      await board.waitFor()
    }

    // C1: header, help, column hints, empty states.
    assert.equal(await board.locator('header').first().getByText('Tasks', { exact: true }).count(), 1)
    assert.equal(await board.locator('h1').innerText(), 'Tasks')
    assert.equal(await board.getByTestId('board-subtitle').innerText(), 'Tasks for this project. Agents and you move the cards. Review means an agent is done and you decide.')
    const help = board.locator('details.ive-help-details').first()
    assert.equal(await help.getAttribute('open'), null)
    await help.locator('summary').click()
    assert.match(await help.locator('.ive-help-content').innerText(), /Accept moves the card to Done; Send back puts it in To Do with your note for the next worker\./)
    assert.match(await help.locator('.ive-help-content').innerText(), /Nothing here blocks a running session\./)
    await help.locator('summary').click()
    for (const column of COLUMNS) {
      assert.equal(await board.locator(`[data-column="${column.key}"] [data-column-hint]`).innerText(), column.hint, column.key)
    }
    assert.equal(await board.locator('[data-column="testing"] [data-column-empty]').innerText(), 'No test agent is checking a card.')
    assert.equal(await board.locator('[data-column="review"] [data-column-empty]').count(), 0)
    assert.equal(await board.locator('[data-column="review"] [data-task-id]').count(), 4)
    assert.equal(await board.getByText('no cards', { exact: true }).count(), 0)

    // C2: card content and actions.
    const guided = card('t-guided')
    await guided.waitFor()
    assert.equal(await guided.locator('[data-origin]').innerText(), 'Guided task')
    assert.equal(await guided.getByTestId('card-agent').innerText(), 'Worker: rate limit')
    assert.equal(await guided.getByTestId('card-agent').locator('.ive-dot').getAttribute('data-state'), 'done')
    assert.equal(await guided.getByTestId('card-result').innerText(), guidedSummary)
    assert.equal(await guided.locator('[data-verification]').innerText(), 'Verified')
    assert.equal(await guided.locator('[data-verification]').getAttribute('data-verification'), 'passed')
    const files = guided.getByTestId('card-files')
    assert.equal(await files.locator('summary').innerText(), '3 files changed')
    assert.equal(await files.locator('li').first().isVisible(), false)
    await files.locator('summary').click()
    assert.deepEqual(await files.locator('li').allInnerTexts(), ['backend/auth/limiter.py', 'backend/auth/routes.py', 'backend/test_limiter.py'])
    for (const name of ['Accept', 'Send back', 'Open session', 'Show changes']) assert.equal(await guided.getByTestId('card-actions').getByRole('button', { name, exact: true }).count(), 1, name)
    // Pills on one row, the two text links on one row: never three rows of actions.
    const rowTops = (await Promise.all(['Accept', 'Send back', 'Open session', 'Show changes'].map(async (name) => (await guided.getByTestId('card-actions').getByRole('button', { name, exact: true }).boundingBox()).y)))
    assert.equal(rowTops[0], rowTops[1], 'Accept and Send back share a row')
    assert.equal(rowTops[2], rowTops[3], 'Open session and Show changes share a row')
    assert.ok(rowTops[2] > rowTops[0], 'links sit below the pills')
    assert.equal(await board.locator('[data-column="review"]').getByRole('button', { name: 'route' }).count(), 0, 'no route button on review cards')

    const agent = card('t-agent')
    assert.equal(await agent.locator('[data-origin]').innerText(), 'Reported by agent')
    assert.equal(await agent.getByTestId('card-agent').locator('.ive-dot').getAttribute('data-state'), 'running')
    assert.match(await agent.getByTestId('card-result').innerText(), /Rounded the cart total once/)
    assert.equal(await agent.locator('[data-verification]').innerText(), 'Not verified')
    assert.equal(await agent.getByTestId('card-files').locator('summary').innerText(), '1 file changed')

    const backstop = card('t-backstop')
    assert.equal(await backstop.locator('[data-origin]').innerText(), 'Auto-documented, session idle 2\u00a0h')
    const chipBox = await backstop.locator('[data-origin]').boundingBox()
    assert.ok(chipBox.height < 24, `chip stays on one line: ${chipBox.height}px`)
    await backstop.screenshot({ path: `${out}card-backstop-${engine}-${theme}.png`, animations: 'disabled' })
    assert.equal(await backstop.getByTestId('card-agent').locator('.ive-dot').getAttribute('data-state'), 'stopped')
    assert.match(await backstop.getByTestId('card-result').innerText(), /went idle without a report/)
    assert.doesNotMatch(await backstop.innerText(), /[{[]"/, 'no raw JSON on the card')
    await backstop.getByTestId('card-files').locator('summary').click()
    assert.deepEqual(await backstop.getByTestId('card-files').locator('li').allInnerTexts(), ['README.md', 'docs/setup.md'])
    await p.mouse.move(0, 0)
    await guided.scrollIntoViewIfNeeded()
    await p.screenshot({ path: `${out}board-${engine}-${theme}.png`, animations: 'disabled' })

    // C3: Show changes opens the Review tab with the three columns.
    await agent.getByTestId('card-actions').getByRole('button', { name: 'Show changes', exact: true }).click()
    const agentModal = modal('t-agent')
    await agentModal.waitFor()
    assert.equal(await agentModal.getAttribute('data-task-tab'), 'review')
    assert.deepEqual(await agentModal.locator('[data-review-column] > h3').allInnerTexts(), ['Where things stand', 'Changes & results', 'Checks'])
    assert.equal(await agentModal.locator('[data-review-column="changed"]').getByRole('button', { name: 'Open session' }).count(), 0, 'Open session only in the header')
    assert.equal(await agentModal.getByTestId('task-modal-actions').getByRole('button', { name: 'Open session', exact: true }).count(), 1)
    assert.equal(await agentModal.getByRole('button', { name: 'Save Changes' }).count(), 0, 'no save footer on the Review tab')
    assert.equal(await agentModal.getByTestId('task-modal-actions').getByRole('button', { name: 'Send back', exact: true }).getAttribute('title'), 'Back to To Do with a note')
    await agentModal.getByTestId('review-diff').waitFor()
    assert.match(await agentModal.getByTestId('review-diff').innerText(), /\+LIMIT = 5/)
    assert.equal(await agentModal.getByTestId('review-files').locator('li').first().innerText(), 'src/cart/total.js')
    assert.equal(await agentModal.locator('[data-review-column="checks"] [data-verification]').innerText(), 'Not verified')
    assert.match(await agentModal.locator('[data-review-column="checks"]').innerText(), /No verification report/)
    assert.match(await agentModal.getByTestId('review-timeline').innerText(), /Checkout worker reported the fix/)
    assert.equal(await agentModal.getByRole('button', { name: 'Preview' }).count(), 0, 'no Preview tab without a preview_url')
    assert.equal(await agentModal.locator('iframe').count(), 0)
    assert.equal(await f.reads.filter((call) => call.path.endsWith('/git/diff') && !call.query.includes('session_id')).length > 0, true, 'workspace diff without a worktree')
    await p.keyboard.press('Escape')
    await agentModal.waitFor({ state: 'hidden' })

    // C3: the guided card's modal loads the worktree diff through session_id and Accept passes reviewed_run_id.
    await guided.locator('span.font-semibold').first().click()
    const guidedModal = modal('t-guided')
    await guidedModal.waitFor()
    assert.equal(await guidedModal.getAttribute('data-task-tab'), 'review')
    await guidedModal.getByTestId('review-diff').waitFor()
    assert.match(await guidedModal.locator('[data-review-column="changed"]').innerText(), /sliding window limiter/)
    assert.match(await guidedModal.locator('[data-review-column="changes"]').innerText(), /3 files changed · lane\/rate-limit · worktree/)
    assert.equal(await guidedModal.locator('[data-review-column="checks"] [data-verification]').innerText(), 'Verified')
    assert.match(await guidedModal.locator('[data-review-column="checks"]').innerText(), /4 tests passed/)
    assert.match(await guidedModal.getByTestId('review-timeline').innerText(), /Status changed by pipeline[\s\S]*Pipeline set task to review/)
    assert.ok(f.reads.some((call) => call.path.endsWith('/git/diff') && call.query.includes('session_id=s-guided')), 'worktree diff requested with session_id')
    await p.screenshot({ path: `${out}review-${engine}-${theme}.png`, animations: 'disabled' })
    await guidedModal.getByTestId('task-modal-actions').getByRole('button', { name: 'Accept', exact: true }).click()
    await guidedModal.waitFor({ state: 'hidden' })
    await board.locator('[data-column="done"] [data-task-id="t-guided"]').waitFor()
    const accept = f.writes.find((call) => call.method === 'PUT' && call.path === '/tasks/t-guided')
    assert.deepEqual(accept.body, { status: 'done', reviewed_run_id: 'run-1' })
    await board.locator('[data-column="done"] [data-task-id="t-guided"] [data-testid="card-checking"]').waitFor()
    assert.equal(await board.locator('[data-column="done"] [data-task-id="t-guided"] [data-testid="card-checking"]').innerText(), 'Test agent checking…')

    // C2: Send back posts the note and the card returns to To Do.
    await agent.getByTestId('card-actions').getByRole('button', { name: 'Send back', exact: true }).click()
    const note = agent.getByTestId('card-send-back')
    assert.match(await note.innerText(), /What should change\?/)
    await note.getByRole('textbox').fill('Round half up like the invoice does, and add a test for 19.995.')
    await note.getByRole('button', { name: 'Send back', exact: true }).click()
    await board.locator('[data-column="todo"] [data-task-id="t-agent"]').waitFor()
    assert.equal(iterations.length, 1)
    assert.equal(iterations[0].id, 't-agent')
    assert.equal(iterations[0].body.note, 'Round half up like the invoice does, and add a test for 19.995.')
    assert.equal(await board.locator('[data-column="todo"] [data-task-id="t-agent"] [data-testid="card-actions"]').count(), 0)

    // C3: a review card without a run is accepted without reviewed_run_id.
    await backstop.getByTestId('card-actions').getByRole('button', { name: 'Accept', exact: true }).click()
    await board.locator('[data-column="done"] [data-task-id="t-backstop"]').waitFor()
    assert.deepEqual(puts, [{ id: 't-backstop', body: { status: 'done' } }])

    // D1/U6: a run that failed verification is accepted without reviewed_run_id
    // and a deleted session shows as a note instead of "Open session".
    const failedCard = card('t-failed')
    assert.equal(await failedCard.locator('[data-verification]').innerText(), 'Checks failed')
    assert.equal(await failedCard.getByTestId('card-actions').getByRole('button', { name: 'Open session', exact: true }).count(), 0)
    assert.equal(await failedCard.getByTestId('card-session-gone').innerText(), 'Session no longer exists')
    await failedCard.locator('span.font-semibold').first().click()
    const failedModal = modal('t-failed')
    await failedModal.waitFor()
    assert.equal(await failedModal.getAttribute('data-task-tab'), 'review')
    assert.equal(await failedModal.locator('[data-review-column="checks"] [data-verification]').innerText(), 'Checks failed')
    assert.match(await failedModal.locator('[data-review-column="checks"]').innerText(), /empty query still scans every row/)
    assert.equal(await failedModal.getByTestId('modal-session-gone').innerText(), 'Session no longer exists')
    assert.equal(await failedModal.getByTestId('task-modal-actions').getByRole('button', { name: 'Open session', exact: true }).count(), 0)
    // U5: typing a send-back note does not mark the card dirty; Escape closes
    // the note (focus back on Send back), the next Escape closes the modal.
    await failedModal.getByTestId('task-modal-actions').getByRole('button', { name: 'Send back', exact: true }).click()
    await failedModal.getByTestId('review-send-back').getByRole('textbox').fill('draft')
    await p.keyboard.press('Escape')
    await failedModal.getByTestId('review-send-back').waitFor({ state: 'hidden' })
    // The focus hand-off runs in the next animation frame.
    await p.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Send back', null, { timeout: 2000 })
    await p.keyboard.press('Escape')
    await failedModal.waitFor({ state: 'hidden' })
    assert.equal(await board.locator('[data-task-id="t-failed"]').count(), 1, 'no discard prompt, modal closed')
    await failedCard.getByTestId('card-actions').getByRole('button', { name: 'Accept', exact: true }).click()
    await board.locator('[data-column="done"] [data-task-id="t-failed"]').waitFor()
    assert.deepEqual(puts.at(-1), { id: 't-failed', body: { status: 'done' } })
    assert.equal(await board.locator('[data-column="review"] [data-column-empty]').innerText(), 'Nothing to review. Cards land here when an agent reports it is finished.')
    await p.screenshot({ path: `${out}board-after-${engine}-${theme}.png`, animations: 'disabled' })

    if (theme === 'dark') {
      // C2: Open session leaves the board and shows the agent session.
      await p.keyboard.press('Escape')
      await board.waitFor({ state: 'hidden' })
      f.data.tasks.push({ ...tasks()[1], id: 't-open', title: 'Open session check' })
      await p.keyboard.press('Meta+b')
      await board.waitFor()
      await card('t-open').getByTestId('card-actions').getByRole('button', { name: 'Open session', exact: true }).click()
      await board.waitFor({ state: 'hidden' })
      await p.locator('[data-session-view="s-agent"]').waitFor()
    }

    assert.deepEqual(f.errors, [], 'no page errors')
    results.push({ theme, engine, cards: 4, accepts: 3, sendBack: iterations.length })
    await f.context.close()
  }

  // U2: at phone width the modal header wraps; Delete and Close stay inside
  // the viewport (no Escape on touch).
  {
    const f = await createTourFixture(browser, {
      theme: 'light', width: 390, height: 844, touch: true, settings: { product_tour_version: String(TOUR_VERSION) },
      workspaces: [workspace], sessions, tasks: tasks(), runs, diff,
    })
    const p = f.page
    await f.context.route('**/api/tasks/*/events', (route) => route.fulfill({ json: [] }))
    const board = p.getByTestId('feature-board')
    for (let attempt = 0; attempt < 20 && !(await board.count()); attempt += 1) {
      await p.keyboard.press('Meta+b')
      await p.waitForTimeout(250)
    }
    await board.waitFor()
    const guided = board.locator('[data-task-id="t-guided"]')
    await guided.scrollIntoViewIfNeeded()
    await guided.getByTestId('card-actions').getByRole('button', { name: 'Show changes', exact: true }).click()
    const phoneModal = p.locator('[data-task-modal="t-guided"]')
    await phoneModal.waitFor()
    for (const title of ['Close Modal', 'Delete Task']) {
      const box = await phoneModal.locator(`[title="${title}"]`).boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, `${title} inside the 390 px viewport: ${JSON.stringify(box)}`)
    }
    assert.equal(await phoneModal.getByTestId('task-modal-actions').getByRole('button', { name: 'Accept', exact: true }).isVisible(), true)
    await p.screenshot({ path: `${out}review-phone-${engine}-light.png`, animations: 'disabled' })
    await phoneModal.locator('[title="Close Modal"]').click()
    await phoneModal.waitFor({ state: 'hidden' })
    assert.deepEqual(f.errors, [], 'no page errors on the phone')
    results.push({ theme: 'light', engine, viewport: 390 })
    await f.context.close()
  }
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
}
console.log(JSON.stringify({ ok: !failed, results, screenshots: out }))
process.exit(failed ? 1 : 0)
