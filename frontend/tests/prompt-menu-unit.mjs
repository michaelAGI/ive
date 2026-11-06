import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoOption, keepPlanningOption, menuFromPrompt, menuKey, nextPromptStop, nextWaitingSessionId, normalizeMenu, opensTerminal, optionForKey, orderWaitingSessions, planChoice, questionFirst, selectedOption, shortcutChoice } from '../src/lib/promptMenu.js'
import { canRestoreTerminalFocus } from '../src/lib/gridFocus.js'
import { parseSessionPermissionPrompt } from '../src/lib/sessionPrompt.js'
import { choiceTone, promptNotice } from '../src/lib/conversationPresentation.js'

const screen = `Bash command
Find Orbit and traffic projects
──────────────────────────────
ls -d */ Projects/*/ | grep -i 'orbit|traffic'
Do you want to proceed?
   1. Yes
 ❯ 2. Yes, and don't ask again for commands in /project
   3. No

Esc to cancel · Tab to amend`

const backend = {
  kind: 'plan', question: 'Would you like to proceed?',
  options: [{ key: '1', label: 'Yes, and auto-accept edits', selected: true }, { key: '2', label: 'Yes, and manually approve edits' }, { key: '3', label: 'No, keep planning' }],
  excerpt: 'Ready to code?', identity: 'id-1', answerable: true, choices: ['1', '2', '3'], selected: '1',
}

test('the backend menu is kept verbatim with exactly one highlighted option', () => {
  const menu = normalizeMenu(backend)
  assert.equal(menu.kind, 'plan')
  assert.deepEqual(menu.options.map((o) => o.label), backend.options.map((o) => o.label))
  assert.deepEqual(menu.options.map((o) => o.selected), [true, false, false])
  assert.equal(menu.identity, 'id-1')
  assert.equal(menu.answerable, true)
  assert.equal(normalizeMenu({ ...backend, options: backend.options.map((o) => ({ ...o, selected: false })) }).options[0].selected, true)
  assert.equal(normalizeMenu({ ...backend, kind: 'weird', answerable: false }).kind, 'permission')
  assert.equal(normalizeMenu({ ...backend, answerable: false }).answerable, false)
  for (const bad of [null, {}, { options: [] }, { options: [{ key: '1', label: '' }] }]) assert.equal(normalizeMenu(bad), null)
})

test('the screen parser carries the cursor and converts to the same shape without an identity', () => {
  const prompt = parseSessionPermissionPrompt(screen)
  assert.deepEqual(prompt.choices.map((c) => c.selected), [false, true, false])
  const menu = menuFromPrompt(prompt)
  assert.equal(menu.identity, null)
  assert.equal(selectedOption(menu).key, '2')
  assert.equal(menu.options[1].label, "Yes, and don't ask again for commands in /project")
  // Like the backend, the excerpt is the header line and the request, without rule lines.
  assert.match(menu.excerpt, /^Bash command\nFind Orbit and traffic projects\nls -d /)
  assert.equal(menuFromPrompt(null), null)
})

test('the menu key ignores the cursor but not the request', () => {
  const a = menuFromPrompt(parseSessionPermissionPrompt(screen))
  const b = menuFromPrompt(parseSessionPermissionPrompt(screen.replace(' ❯ 2.', '   2.').replace('   1. Yes', ' ❯ 1. Yes')))
  assert.equal(menuKey(a), menuKey(b))
  assert.notEqual(menuKey(a), menuKey(menuFromPrompt(parseSessionPermissionPrompt(screen.replace('Find Orbit', 'Find Mars')))))
  assert.equal(menuKey(normalizeMenu(backend)), 'id-1')
})

test('composer shortcuts map to the current options only', () => {
  const menu = menuFromPrompt(parseSessionPermissionPrompt(screen))
  assert.equal(shortcutChoice('y', menu).key, '1')
  assert.equal(shortcutChoice('Yes.', menu).key, '1')
  assert.equal(shortcutChoice('n', menu).key, '3')
  assert.equal(shortcutChoice('NO', menu).key, '3')
  assert.equal(shortcutChoice('2', menu).key, '2')
  for (const text of ['4', 'maybe', 'yes please', '', '   ', 'y es']) assert.equal(shortcutChoice(text, menu), null, text)
  const question = normalizeMenu({ kind: 'question', question: 'Which colour?', options: [{ key: '1', label: 'Red' }, { key: '2', label: 'Blue' }] })
  assert.equal(shortcutChoice('y', question), null)
  assert.equal(shortcutChoice('n', question), null)
  assert.equal(shortcutChoice('2', question).label, 'Blue')
  assert.equal(optionForKey(question, ' 1 ').label, 'Red')
})

test('⌘⇧Y walks waiting sessions oldest first and wraps around', () => {
  const sessions = [{ id: 'b', attention: { asked_at: 20 } }, { id: 'c', attention: {} }, { id: 'a', attention: { asked_at: 10 } }]
  const ordered = orderWaitingSessions(sessions)
  assert.deepEqual(ordered.map((s) => s.id), ['a', 'b', 'c'])
  assert.equal(nextWaitingSessionId(ordered, null), 'a')
  assert.equal(nextWaitingSessionId(ordered, 'a'), 'b')
  assert.equal(nextWaitingSessionId(ordered, 'c'), 'a')
  assert.equal(nextWaitingSessionId(ordered, 'gone'), 'a')
  assert.equal(nextWaitingSessionId([], 'a'), null)
})

test('⌘⇧Y is one list: a card when the pop-up shows one, else the on-screen menu, else the session is opened', () => {
  // a: oldest, its PromptMenu is on screen (no card, the session is in front); b: a pop-up card; c: nowhere on screen.
  const sessions = [{ id: 'c', attention: { asked_at: 30 } }, { id: 'b', attention: { asked_at: 20 } }, { id: 'a', attention: { asked_at: 10 } }]
  const onScreen = { a: 'menu-a', b: 'card-b' }
  const targets = (id) => onScreen[id] || null
  const ordered = orderWaitingSessions(sessions)
  const first = nextPromptStop(ordered, null, targets)
  assert.deepEqual(first, { id: 'a', target: 'menu-a', open: false })
  const second = nextPromptStop(ordered, first.id, targets)
  assert.deepEqual(second, { id: 'b', target: 'card-b', open: false })
  const third = nextPromptStop(ordered, second.id, targets)
  assert.deepEqual(third, { id: 'c', target: null, open: true })
  assert.equal(nextPromptStop(ordered, third.id, targets).id, 'a')
  assert.equal(nextPromptStop([], null, targets), null)
})

test('y/n stand for Yes/No on a permission dialog only', () => {
  const plan = normalizeMenu({ kind: 'plan', question: 'Would you like to proceed?', options: [{ key: '1', label: 'Yes, and use auto mode', selected: true }, { key: '2', label: 'Yes, manually approve edits' }, { key: '3', label: 'Tell Claude what to change' }] })
  assert.equal(shortcutChoice('y', plan), null)
  assert.equal(shortcutChoice('yes', plan), null)
  assert.equal(shortcutChoice('n', plan), null)
  assert.equal(shortcutChoice('1', plan).label, 'Yes, and use auto mode')
  const olderPlan = normalizeMenu({ ...plan, options: [{ key: '1', label: 'Yes, and auto-accept edits' }, { key: '2', label: 'No, keep planning' }] })
  assert.equal(shortcutChoice('y', olderPlan), null)
  assert.equal(shortcutChoice('n', olderPlan), null)
  // A permission dialog keeps the reflex; so does a label that is exactly Yes or carries the hotkey.
  const codex = normalizeMenu({ kind: 'permission', question: 'Would you like to run the following command?', options: [{ key: '1', label: 'Yes, proceed (y)' }, { key: '2', label: "Yes, and don't ask again (p)" }, { key: '3', label: 'No, and tell Codex what to do differently (esc)' }] })
  assert.equal(shortcutChoice('y', codex).key, '1')
  assert.equal(shortcutChoice('n', codex).key, '3')
  const questionYes = normalizeMenu({ kind: 'question', question: 'Ship it?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] })
  assert.equal(shortcutChoice('y', questionYes).key, '1')
  assert.equal(shortcutChoice('n', questionYes).key, '2')
})

test('automations answer a plan, a plain Yes on a permission, never a question or a persistent allowance', () => {
  const plan = normalizeMenu({ kind: 'plan', question: 'Would you like to proceed?', options: [{ key: '1', label: 'Yes, and use auto mode' }, { key: '2', label: 'Yes, manually approve edits' }, { key: '3', label: 'Tell Claude what to change' }] })
  assert.equal(autoOption(plan).key, '1')
  assert.equal(autoOption(plan, { planOnly: true }).key, '1')
  const question = normalizeMenu({ kind: 'question', question: 'Which colour?', options: [{ key: '1', label: 'Red' }, { key: '2', label: 'Blue' }] })
  assert.equal(autoOption(question), null)
  assert.equal(autoOption(question, { planOnly: true }), null)
  const bash = normalizeMenu({ kind: 'permission', question: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'Yes, and always allow access to /x from this project' }, { key: '3', label: 'No' }] })
  assert.equal(autoOption(bash).key, '1')
  assert.equal(autoOption(bash, { planOnly: true }), null)
  const codex = normalizeMenu({ kind: 'permission', question: 'Would you like to run the following command?', options: [{ key: '1', label: 'Yes, proceed (y)' }, { key: '2', label: "Yes, and don't ask again for commands that start with `touch` (p)" }, { key: '3', label: 'No, and tell Codex what to do differently (esc)' }] })
  assert.equal(autoOption(codex).key, '1')
  // The first option is already a persistent allowance (or anything but a plain Yes): blocked.
  const persistent = normalizeMenu({ ...bash, options: [{ key: '1', label: "Yes, and don't ask again for ls commands" }, { key: '2', label: 'No' }] })
  assert.equal(autoOption(persistent), null)
  const auto = normalizeMenu({ ...bash, options: [{ key: '1', label: 'Yes, and switch to auto mode' }, { key: '2', label: 'No' }] })
  assert.equal(autoOption(auto), null)
  assert.equal(autoOption({ ...bash, answerable: false }), null)
  assert.equal(autoOption(null), null)
})

test('plan buttons act on a plan approval only', () => {
  const plan = normalizeMenu({ kind: 'plan', question: 'Would you like to proceed?', options: [{ key: '1', label: 'Yes, and use auto mode' }, { key: '2', label: 'Yes, manually approve edits' }, { key: '3', label: 'Tell Claude what to change' }] })
  assert.equal(planChoice(plan, 1).option.label, 'Yes, and use auto mode')
  assert.equal(planChoice(plan, 2).option.label, 'Yes, manually approve edits')
  assert.deepEqual(planChoice(plan, 4), { reason: 'no_option' })
  assert.equal(keepPlanningOption(plan).label, 'Tell Claude what to change')
  const olderPlan = normalizeMenu({ ...plan, options: [{ key: '1', label: 'Yes, and auto-accept edits' }, { key: '2', label: 'Yes, manually approve edits' }, { key: '3', label: 'No, keep planning' }] })
  assert.equal(keepPlanningOption(olderPlan).label, 'No, keep planning')
  // A Bash permission is live instead: "Approve & Auto-accept" must not pick its "always allow" option.
  const bash = normalizeMenu({ kind: 'permission', question: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'Yes, and always allow access to /x from this project' }, { key: '3', label: 'No' }] })
  assert.deepEqual(planChoice(bash, 1), { reason: 'not_plan' })
  assert.deepEqual(planChoice(bash, 2), { reason: 'not_plan' })
  assert.deepEqual(planChoice(normalizeMenu({ kind: 'question', question: 'Which?', options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }] }), 1), { reason: 'not_plan' })
  assert.deepEqual(planChoice(null, 1), { reason: 'no_menu' })
  assert.deepEqual(planChoice({ ...plan, answerable: false }, 1), { reason: 'terminal_only' })
})

test('the question is drawn first for Codex, after the request for Claude', () => {
  const claude = menuFromPrompt(parseSessionPermissionPrompt(screen))
  assert.equal(questionFirst(claude), false)
  for (const header of ['Edit file\nsrc/App.jsx\n-  a\n+  b', 'Tool use\nworker-board — Get My Task Tool: (MCP)', 'Fetch\nurl: https://example.com', 'Web search\nquery: vite', 'Notebook edit\nnotes.ipynb']) {
    assert.equal(questionFirst({ ...claude, excerpt: header }), false, header.split('\n')[0])
  }
  // A hook confirmation names the tool on the first line and the hook notice on the second: Claude order.
  assert.equal(questionFirst({ ...claude, excerpt: 'ToolSearch\n│ Hook PreToolUse:ToolSearch requires confirmation for this tool:\n│ missing API key' }), false)
  const codex = normalizeMenu({ kind: 'permission', question: 'Would you like to run the following command?', options: [{ key: '1', label: 'Yes, proceed (y)' }, { key: '2', label: 'No, and tell Codex what to do differently (esc)' }], excerpt: 'Environment: local\n\n$ touch created.txt' })
  assert.equal(questionFirst(codex), true)
  assert.equal(questionFirst({ ...codex, excerpt: '' }), false)
  assert.equal(questionFirst({ ...codex, kind: 'plan' }), false)
  assert.equal(questionFirst(null), false)
})

test('AskUserQuestion free-text rows open the terminal instead of being sent', () => {
  const ask = normalizeMenu({ kind: 'question', question: 'Which colour?', options: [{ key: '1', label: 'Red' }, { key: '2', label: 'Type something.' }, { key: '3', label: 'Chat about this' }] })
  assert.deepEqual(ask.options.map((option) => opensTerminal(option, ask)), [false, true, true])
  const multi = normalizeMenu({ kind: 'question', question: 'Which?', options: [{ key: '1', label: '[ ] S' }, { key: '2', label: '[ ] Type something' }, { key: '3', label: 'Chat about this' }], answerable: false })
  assert.deepEqual(multi.options.map((option) => opensTerminal(option, multi)), [false, true, true])
  // Only question menus: the same words in a permission dialog would be a real choice.
  const permission = normalizeMenu({ kind: 'permission', question: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'Chat about this' }] })
  assert.equal(opensTerminal(permission.options[1], permission), false)
  assert.equal(opensTerminal(null, ask), false)
  assert.equal(opensTerminal(ask.options[1], null), false)
})

test('a focused PromptMenu keeps the keyboard when IVE hands focus back to the terminal', () => {
  const el = (within) => ({ isConnected: true, ownerDocument: { body: {} }, classList: { contains: () => false }, getClientRects: () => [{}], closest: (selector) => (within && selector.includes(within) ? {} : null) })
  assert.equal(canRestoreTerminalFocus(el('[data-prompt-menu]')), false)
  assert.equal(canRestoreTerminalFocus(el('[role="menu"]')), false)
  assert.equal(canRestoreTerminalFocus(el(null)), true)
})

test('presentation helpers give tone and notice only, never other words', () => {
  const menu = menuFromPrompt(parseSessionPermissionPrompt(screen))
  assert.deepEqual(menu.options.map((o, i) => choiceTone(o, i, menu)), ['allow', 'persistent', 'deny'])
  assert.equal(promptNotice(menu), '')
  assert.match(promptNotice({ ...menu, excerpt: `${menu.excerpt}\nSafety check not configured: missing API key 'x' (fail-closed)` }), /safety check needs setup/i)
})
