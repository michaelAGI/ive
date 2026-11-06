import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { isSessionPermissionPromptFragment, parseSessionPermissionPrompt, promptChoices, promptIdentity, submitSessionPromptReply } from '../src/lib/sessionPrompt.js'
import { menuFromPrompt } from '../src/lib/promptMenu.js'
import { detectTerminalAttention } from '../src/lib/sessionAttention.js'
import { ASK_COLOUR, BASH_TWO, EDIT_THREE, identityOf, menuFor } from './fixtures/prompt-dialogs.mjs'

// The real dialogs (rendered 120x40 screens from the PTY captures, plus the
// 140-column screens of Claude 2.1.299) are the shared evidence of the
// backend's _session_permission_menu and this parser.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/fixtures/permission_dialogs')
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'))
const KIND = { permission: 'permission', plan_approval: 'plan', ask_user_question: 'question' }
const fixture = (name) => manifest.find((entry) => entry.name === name)
const screenOf = (entry) => fs.readFileSync(path.join(FIXTURES, entry.path || `${entry.name}.screen.txt`), 'utf8')
const screenNamed = (name) => screenOf(fixture(name))
const labelsOf = (prompt) => prompt.choices.map((choice) => choice.label)

for (const entry of manifest.filter((item) => !['probe', 'redraw'].includes(item.kind))) {
  const kind = KIND[entry.kind]
  test(`fixture ${entry.name} (${entry.cli_version}) is ${kind ? `a ${kind} menu` : 'never a menu'}`, () => {
    const prompt = parseSessionPermissionPrompt(screenOf(entry))
    if (!kind) { assert.equal(prompt, null); return }
    assert.equal(prompt?.kind, kind)
    assert.equal(prompt.question, entry.question)
    assert.deepEqual(labelsOf(prompt), entry.options)
    assert.deepEqual(prompt.choices.map((choice) => choice.value), entry.options.map((_, index) => String(index + 1)))
    assert.equal(prompt.choices.findIndex((choice) => choice.selected), entry.selected_index)
    assert.equal(prompt.choices.filter((choice) => choice.selected).length, 1)
    assert.equal(prompt.answerable, !entry.options.some((label) => /^\[[ x]\] /.test(label)))
    assert.equal(prompt.identity, identityOf(entry.question, entry.options, prompt.excerpt))
    assert.equal(isSessionPermissionPromptFragment(screenOf(entry)), false)
  })
}

test('manifest covers every dialog kind the parser knows', () => {
  const kinds = new Set(manifest.map((entry) => KIND[entry.kind]).filter(Boolean))
  assert.deepEqual([...kinds].sort(), ['permission', 'plan', 'question'])
  assert.ok(manifest.some((entry) => entry.cli === 'codex' && entry.kind === 'permission'))
  assert.ok(manifest.some((entry) => ['startup_blocker', 'negative'].includes(entry.kind)))
})

test('excerpts carry the request: Claude from the header line to the question, Codex between question and rows', () => {
  // Like the backend: the header line first, rule lines left out, common indent removed.
  const bash = parseSessionPermissionPrompt(screenNamed('claude-bash'))
  assert.match(bash.excerpt, /^Bash command\nTip: auto mode handles these prompts/)
  assert.match(bash.excerpt, /\nWrite hello-ive into hello\.txt\necho hello-ive > hello\.txt$/)
  assert.doesNotMatch(bash.excerpt, /Do you want to proceed|╌/)
  assert.equal(parseSessionPermissionPrompt(screenNamed('claude-edit-file')).excerpt, 'Edit file\nnotes.txt\n1 -hi\n1 +hello')
  assert.equal(parseSessionPermissionPrompt(screenNamed('claude-create-file')).excerpt, 'Create file\nnotes.txt\n 1 hi')
  assert.match(parseSessionPermissionPrompt(screenNamed('claude-fetch')).excerpt, /^Fetch\nClaude wants to fetch content from example\.com\nurl: https:\/\/example\.com\/\nprompt: /)
  const codex = parseSessionPermissionPrompt(screenNamed('codex-command'))
  assert.equal(codex.excerpt.split('\n')[0], 'Environment: local')
  assert.match(codex.excerpt, /Reason: Allow creating created\.txt/)
  assert.match(codex.excerpt, /\$ touch created\.txt$/)
  assert.equal(parseSessionPermissionPrompt(screenNamed('claude-plan-approval')).excerpt, '')
  assert.equal(parseSessionPermissionPrompt(screenNamed('claude-ask-single')).excerpt, '')
})

test('the identity ignores the cursor and redraws above the dialog, not the request', () => {
  const bash = screenNamed('claude-bash')
  const moved = bash.replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No')
  const a = parseSessionPermissionPrompt(bash), b = parseSessionPermissionPrompt(moved)
  assert.equal(b.choices.findIndex((choice) => choice.selected), 3)
  assert.equal(a.identity, b.identity)
  assert.notEqual(a.identity, parseSessionPermissionPrompt(bash.replace('echo hello-ive > hello.txt\n╌', 'rm -rf build\n╌')).identity)
  const codex = screenNamed('codex-command')
  const codexMoved = codex.replace('› 1. Yes', '  1. Yes').replace('  2. Yes', '› 2. Yes')
  assert.equal(parseSessionPermissionPrompt(codexMoved).choices[1].selected, true)
  assert.equal(parseSessionPermissionPrompt(codex).identity, parseSessionPermissionPrompt(codexMoved).identity)
  const redraw = JSON.parse(fs.readFileSync(path.join(FIXTURES, fixture('legacy-claude-tool-use-redraw').path), 'utf8'))
  const identities = ['before', 'expected', 'after'].map((key) => parseSessionPermissionPrompt(redraw[key])?.identity)
  assert.ok(identities[0])
  assert.deepEqual(identities, [identities[0], identities[0], identities[0]])
  assert.equal(promptIdentity(' Do you  want to proceed? ', ['Yes', 'No,\n   later'], 'Write hello\n  ls  -la'), 'Do you want to proceed?\n1. Yes\n2. No, later\nWrite hello ls -la')
  assert.equal(promptIdentity('Which colour?', ['Red', 'Chat about this'], ''), 'Which colour?\n1. Red\n2. Chat about this', 'an empty excerpt adds no line')
})

test('the browser fixtures agree with the backend mirror', () => {
  for (const screen of [BASH_TWO, EDIT_THREE, ASK_COLOUR]) {
    const prompt = parseSessionPermissionPrompt(screen), mirror = menuFor(screen)
    assert.equal(prompt.kind, mirror.kind)
    assert.equal(prompt.question, mirror.question)
    assert.equal(prompt.answerable, mirror.answerable)
    assert.deepEqual(labelsOf(prompt), mirror.options.map((option) => option.label))
    assert.equal(prompt.excerpt, mirror.excerpt)
    assert.equal(prompt.identity, mirror.identity)
    assert.equal(menuFromPrompt(prompt).identity, null, 'a browser-side parse replies with expected_screen, not an identity claim')
  }
})

test('the menu shape carries kind and answerable into PromptMenu', () => {
  const multi = menuFromPrompt(parseSessionPermissionPrompt(screenNamed('claude-ask-multi-q2')))
  assert.equal(multi.kind, 'question')
  assert.equal(multi.answerable, false)
  assert.deepEqual(multi.options.map((option) => option.key), ['1', '2', '3', '4', '5'])
  const single = menuFromPrompt(parseSessionPermissionPrompt(screenNamed('claude-ask-single')))
  assert.equal(single.answerable, true)
  assert.equal(menuFromPrompt(parseSessionPermissionPrompt(screenNamed('claude-plan-approval'))).kind, 'plan')
  assert.equal(menuFromPrompt(parseSessionPermissionPrompt(screenNamed('codex-network'))).kind, 'permission')
})

test('a recognised dialog is terminal attention on its own, pickers and trust screens are not', () => {
  const codex = detectTerminalAttention(screenNamed('codex-command'))
  assert.equal(codex.kind, 'permission')
  assert.equal(codex.source, 'terminal')
  assert.equal(codex.menu.kind, 'permission')
  assert.equal(codex.menu.options[0].label, 'Yes, proceed (y)')
  const ask = detectTerminalAttention(screenNamed('claude-ask-single'))
  assert.equal(ask.kind, 'question')
  assert.equal(ask.title, 'Your answer is needed')
  assert.equal(ask.menu.kind, 'question')
  assert.equal(detectTerminalAttention(screenNamed('claude-ask-multi-q2')).menu.answerable, false)
  assert.equal(detectTerminalAttention(screenNamed('claude-fetch')).menu.kind, 'permission', 'no footer on screen, still a dialog')
  assert.equal(detectTerminalAttention(screenNamed('claude-plan-approval')).menu.kind, 'plan')
  assert.deepEqual(detectTerminalAttention(screenNamed('codex-patch')), detectTerminalAttention(screenNamed('codex-patch')), 'byte-identical per poll')
  for (const name of ['claude-trust', 'codex-trust', 'claude-model-picker', 'codex-model-picker', 'claude-permissions', 'claude-bash-after-digit-2', 'codex-command-after-digit-2']) {
    assert.equal(detectTerminalAttention(screenNamed(name)), null, name)
  }
})

test('post-answer screens, half-drawn dialogs and dialogs left in scrollback are never a menu', () => {
  const bash = screenNamed('claude-bash')
  const rows = bash.indexOf(' ❯ 1. Yes')
  const cases = {
    'probe after digit 2 (Claude)': screenNamed('claude-bash-after-digit-2'),
    'probe after digit 2 (Codex)': screenNamed('codex-command-after-digit-2'),
    'rows cut after option 2': bash.slice(0, bash.indexOf('   3. Yes, and switch')),
    'header and question, rows not drawn yet': bash.slice(0, rows),
    'rows without the request header': bash.slice(rows),
    'question line not drawn yet': bash.replace(' Do you want to proceed?\n', ''),
    'Claude back at its prompt below the dialog': `${bash.trimEnd()}\n\n✻ Brewed for 2s · done 13:44\n\n❯ \n${'─'.repeat(120)}\n  ⏸ manual mode on · esc to interrupt`,
    'Codex composer below the dialog': `${screenNamed('codex-command')}\n› Ask Codex to do anything\n\n  GPT-6-Astra default · /tmp/proj-3`,
    'Codex dialog without its request': screenNamed('codex-command').replace(/\n  Environment: local\n[\s\S]*?\n  \$ touch created\.txt\n/, '\n'),
    'plan rows cut after the first option': screenNamed('claude-plan-approval').replace(/     2\. Yes, manually approve edits\n     3\. Tell Claude what to change\n        shift\+tab to approve with this feedback\n/, ''),
    'AskUserQuestion without its footer': screenNamed('claude-ask-single').replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''),
    'AskUserQuestion rows without the question': screenNamed('claude-ask-single').replace('Which colour?\n', ''),
    // Invariant: nothing but the footer below the options. An assistant-echoed dialog with the composer under it is history.
    'assistant-echoed dialog with the composer below': `⏺ Earlier I asked:\n  Bash command\n  ls\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n\n  Esc to cancel · Tab to amend\n\n❯ \n${'─'.repeat(40)}\n  ⏸ manual mode on`,
  }
  for (const [name, screen] of Object.entries(cases)) assert.equal(parseSessionPermissionPrompt(screen), null, name)
  // Like the backend: a fragment is a dialog whose bottom (footer, or a "No…" row under its question) is on screen without its top.
  for (const name of ['rows without the request header', 'question line not drawn yet', 'AskUserQuestion rows without the question']) {
    assert.equal(isSessionPermissionPromptFragment(cases[name]), true, name)
  }
  // The top on screen with the rows not drawn yet is a dialog being drawn, not a cut-off one; answered screens and history are neither.
  for (const name of ['rows cut after option 2', 'header and question, rows not drawn yet', 'probe after digit 2 (Claude)', 'probe after digit 2 (Codex)', 'assistant-echoed dialog with the composer below']) {
    assert.equal(isSessionPermissionPromptFragment(cases[name]), false, name)
  }
  // The "No…" row of a permission question as the last line counts as its bottom.
  assert.equal(isSessionPermissionPromptFragment(bash.slice(bash.indexOf('Do you want to proceed?')).replace(/\n\s*Esc to cancel[^\n]*/, '')), true)
})

test('numbered lists in assistant output never become a menu', () => {
  const prose = `⏺ Two ways forward:\n  1. Yes, keep the current layout\n  2. No, start over\n\n  Do you want to proceed?\n\n${'─'.repeat(120)}\n❯ \n${'─'.repeat(120)}\n  ⏸ manual mode on`
  assert.equal(parseSessionPermissionPrompt(prose), null)
  assert.equal(parseSessionPermissionPrompt('⏺ Options:\n  1. Yes\n  2. No\n'), null, 'no cursor, no footer')
  assert.equal(parseSessionPermissionPrompt('Do you want to proceed?\n  1. Yes\n  2. No\n\nEsc to cancel'), null, 'no cursor')
  assert.equal(parseSessionPermissionPrompt('Bash command\nls\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel\n⏺ Done.'), null, 'output below the footer')
  assert.equal(parseSessionPermissionPrompt('Which one?\n❯ 1. Red\n  2. Blue\n\nEnter to select · ↑/↓ to navigate · Esc to cancel'), null, 'no Type something / Chat about this rows')
  assert.equal(parseSessionPermissionPrompt(`${'─'.repeat(120)}\n Select model\n ❯ 1. Yes, the default\n   2. No, the other one\n\n Enter to set as default · Esc to cancel`), null, 'a picker without a dialog question')
})

test('legacy roles: first Yes allows, second Yes persists, last No refuses, questions have none', () => {
  const bash = promptChoices({ prompt: parseSessionPermissionPrompt(screenNamed('claude-bash')) })
  assert.deepEqual([bash.allow, bash.allowSession, bash.deny, bash.labels.length], ['1', '2', '4', 4])
  const plan = promptChoices({ prompt: parseSessionPermissionPrompt(screenNamed('claude-plan-approval')) })
  assert.deepEqual([plan.allow, plan.allowSession, plan.deny], ['1', '2', null])
  const ask = promptChoices({ prompt: parseSessionPermissionPrompt(screenNamed('claude-ask-single')) })
  assert.deepEqual([ask.allow, ask.allowSession, ask.deny, ask.labels], [null, null, null, []])
  assert.equal(ask.question, 'Which colour?')
})

test('multi-select questions are recognised but refuse a guarded reply', async () => {
  const screen = screenNamed('claude-ask-multi-q2')
  assert.equal(parseSessionPermissionPrompt(screen).answerable, false)
  await assert.rejects(submitSessionPromptReply('session-a', screen, '1', { sendInput: () => assert.fail('a multi-select question must not be answered from outside') }), /needs the terminal/)
  let sent
  await submitSessionPromptReply('session-a', screenNamed('codex-command'), '2', { sendInput: async (...args) => { sent = args; return { ok: true } } })
  assert.equal(sent[1], '2')
})

const screen = `Earlier assistant output
 Tool use
 worker-board — Get My Task Tool: (MCP)
 task_id: "fixture-task"
 About the worker-board — Get My Task Tool:
 │ Get full details of one of your assigned tasks.

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for worker-board — Get My Task commands in ~/demo
   3. No

 Esc to cancel · Tab to amend
`

const hookScreen = `ToolSearch
──────────────────────────────
│ Hook PreToolUse:ToolSearch requires confirmation for this tool:
│ [Safety Gate] LLM safety classifier provider 'gemini_api' is not configured: missing API key 'api_key_gemini_api' (fail-closed)
settings.json to update hooks

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for ToolSearch commands in /test/project
  3. No

Esc to cancel · Tab to amend`

test('named hook menus show the complete request and all choices', () => {
  const prompt = parseSessionPermissionPrompt(hookScreen)
  assert.deepEqual(prompt.choices.map(choice => choice.value), ['1', '2', '3'])
  assert.match(prompt.excerpt, /^ToolSearch\n│ Hook PreToolUse:ToolSearch requires confirmation/)
  assert.match(prompt.excerpt, /missing API key/)
  assert.equal(isSessionPermissionPromptFragment(hookScreen), false)
  for (const invalid of [hookScreen.replace(/^ToolSearch\n/, ''), hookScreen.replace(/^ToolSearch\n/, 'Read\n'), hookScreen.replace('Hook PreToolUse:ToolSearch', 'Hook PreToolUse:Read')]) {
    assert.equal(parseSessionPermissionPrompt(invalid), null)
    assert.equal(isSessionPermissionPromptFragment(invalid), true)
  }
})

test('current native permission menu preserves one-time and persistent choices', () => {
  const prompt = parseSessionPermissionPrompt(screen)
  assert.equal(prompt.kind, 'permission')
  assert.equal(prompt.question, 'Do you want to proceed?')
  assert.deepEqual(prompt.choices.map((choice) => choice.value), ['1', '2', '3'])
  assert.equal(prompt.choices[0].label, 'Yes')
  assert.match(prompt.choices[1].label, /don't ask again.*~\/demo/)
  assert.equal(prompt.choices[2].label, 'No')
  assert.match(prompt.excerpt, /Get My Task Tool/)
  assert.match(prompt.excerpt, /fixture-task/)
  assert.doesNotMatch(prompt.excerpt, /Earlier assistant output/)
})

test('wrapped options and styled selectors retain the full choice text', () => {
  const wrapped = screen.replace('commands in ~/demo', 'commands\n      in ~/demo').replace('❯ 1. Yes', '\x1b[32m❯ 1. Yes\x1b[0m')
  assert.match(parseSessionPermissionPrompt(wrapped).choices[1].label, /commands in ~\/demo$/)
})

test('historical menus, ordinary lists and changed prompt layouts do not invent approval buttons', () => {
  // A missing footer alone is no longer disqualifying: Claude's Fetch dialog
  // draws its rows on the last screen line (fixture claude-fetch).
  for (const value of [
    '', '1. Yes\n2. Yes, always\n3. No',
    screen + '\n❯ Ready for your next message',
    screen.replace('Do you want to proceed?', 'What should we call this project?'),
    screen.replace('3. No', '3. Continue'),
    screen.replace('2. Yes,', '4. Yes,'),
    screen.replace('❯ 1. Yes', '1. Yes'),
    screen.replace('3. No', '❯ 3. No'),
    screen.replace('Esc to cancel · Tab to amend', '⏺ Working on it'),
  ]) assert.equal(parseSessionPermissionPrompt(value), null, value)
})

test('an explicit choice sends the unchanged screen guard and waits for acknowledgement', async () => {
  const rawScreen = screen.replaceAll('\n', '\r\n')
  let sent, acknowledge, settled = false
  const pending = submitSessionPromptReply('session-a', rawScreen, '1', {
    sendInput: (...args) => { sent = args; return new Promise((resolve) => { acknowledge = resolve }) },
  }).then(() => { settled = true })
  assert.deepEqual(sent, ['session-a', '1', { expected_screen: rawScreen, ready_timeout: 0 }])
  assert.equal(settled, false)
  acknowledge({ ok: true })
  await pending
  assert.equal(settled, true)
})

test('missing snapshots and invented choices never send input', async () => {
  let calls = 0
  const opts = { sendInput: async () => { calls++; return { ok: true } } }
  for (const [snapshot, reply] of [['', '1'], [screen, '4'], ['Unrecognized menu', '1']]) {
    await assert.rejects(submitSessionPromptReply('session-a', snapshot, reply, opts))
  }
  assert.equal(calls, 0)
})

test('stale and partial failures propagate once without automatic resubmission', async () => {
  for (const partial of [false, true]) {
    let calls = 0
    const stale = Object.assign(new Error('Request changed'), { status: 409, body: { code: 'stale_session_prompt', partial } })
    await assert.rejects(submitSessionPromptReply('session-a', screen, '1', {
      sendInput: async () => { calls++; throw stale },
    }), (error) => error === stale)
    assert.equal(calls, 1)
  }
})

test('unknown questions support only explicit guarded single-line manual replies', async () => {
  let sent
  await submitSessionPromptReply('session-a', 'What should this project be called?', 'Demo', {
    manual: true,
    sendInput: async (...args) => { sent = args; return { ok: true } },
  })
  assert.deepEqual(sent, ['session-a', 'Demo', { expected_screen: 'What should this project be called?', ready_timeout: 0, prompt_reply: true }])
  for (const reply of ['first\nsecond', 'escape\x1bkey', 'x'.repeat(2001)]) {
    await assert.rejects(submitSessionPromptReply('session-a', 'Question?', reply, {
      manual: true, sendInput: () => assert.fail('unsafe control input must never be sent'),
    }), /single line/)
  }
})

test('an unacknowledged or intercepted reply is not marked accepted', async () => {
  for (const result of [null, { ok: false }, { ok: true, intercepted: true }]) {
    await assert.rejects(submitSessionPromptReply('session-a', screen, '3', { sendInput: async () => result }), /did not accept/)
  }
})

test('a clipped permission menu has no approval choices or manual reply fallback', async () => {
  const clipped = screen.slice(screen.indexOf(' task_id:'))
  assert.equal(parseSessionPermissionPrompt(clipped), null)
  assert.equal(isSessionPermissionPromptFragment(clipped), true)
  for (const manual of [false, true]) {
    await assert.rejects(submitSessionPromptReply('session-a', clipped, '1', {
      manual, sendInput: () => assert.fail('a clipped permission request must not send input'),
    }), /permission request is incomplete/)
  }
})

test('a long current frame retains the tool header and complete request body', () => {
  const longScreen = screen.replace(' task_id:', `${Array.from({ length: 65 }, (_, index) => ` payload line ${index}`).join('\n')}\n task_id:`)
  const full = parseSessionPermissionPrompt(longScreen)
  assert.match(full.excerpt, /^Tool use\nworker-board [^\n]*Get My Task Tool: \(MCP\)\n/)
  assert.match(full.excerpt, /payload line 0/)
  assert.match(full.excerpt, /payload line 64/)
  const clipped = longScreen.split('\n').slice(-40).join('\n')
  assert.equal(parseSessionPermissionPrompt(clipped), null)
  assert.equal(isSessionPermissionPromptFragment(clipped), true)
})

test('permission fragments remain blocked while ordinary questions keep manual replies', () => {
  assert.equal(isSessionPermissionPromptFragment(screen.slice(screen.indexOf(' ❯ 1. Yes'))), true)
  assert.equal(isSessionPermissionPromptFragment(screen.replace('3. No', '3. Unexpected choice')), true)
  assert.equal(isSessionPermissionPromptFragment('What should this project be called?'), false)
  assert.equal(isSessionPermissionPromptFragment('I can migrate the table now. Would you like to proceed?\n\n❯ '), false, 'prose with a question but no dialog parts')
  assert.equal(isSessionPermissionPromptFragment(screen), false)
})
