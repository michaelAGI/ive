// Mirrors backend/server.py _session_permission_menu line by line: the dialogs
// as Claude Code 2.1.x and Codex 0.16x draw them (fixtures in
// backend/fixtures/permission_dialogs). An allowlist of three frames, never
// "any numbered list": permission dialogs, plan approval and AskUserQuestion.
// Trust, /model, /permissions, theme and login screens are never a menu.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const QUESTION = /^(?:Do you want to|Would you like to) .{1,240}\?$/
const PLAN_QUESTION = /Would you like to proceed\?|Ready to code\?/
const PLAN_OPTION = /keep planning|what to change|auto mode/i
const HEADER = /^(?:Tool use|Bash command|Run command|Edit file|Create file|Write file|Read file|Fetch|Web ?search|Notebook edit|Edit notebook)$/i
const HOOK_HEADER = /^[│|]?\s*Hook PreToolUse:([A-Za-z][\w:.-]*) requires confirmation for this tool:$/
const RULE = /^[─╌━═▔]{8,}(?:\s.*)?$/
const TOP_RULE = /^─{20,}$/
// The hint line under the options, one wording per dialog kind. Nothing may follow it.
const FOOTER = /^(?:Esc to cancel(?:\s*·.*)?|Press enter to confirm or esc to cancel|Enter to select\s*·.*Esc to cancel|ctrl\+g to edit in Vim.*)$/i
const OPTION = /^(\s*)([❯›])?\s*([1-9])[.)]\s+(\S.*)$/
const CHECKBOX = /\[[ xX✔✓]\]/
const ASK_FOOTER = /^enter to select/i
const ASK_LAST = 'Chat about this'
const TAB_STRIP = /[☐☑✔✓]/
const YES = /^Yes/
const NO = /^No\b/

const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

function screenLines(screen) {
  return screen.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[^\S\n]/g, ' ').split('\n').map((line) => line.replace(/\s+$/, ''))
}

/** Shared with the backend: question, "1. label" per option and the excerpt, whitespace collapsed, empty parts dropped, joined by newlines. */
export function promptIdentity(question, labels, excerpt) {
  return [question, ...labels.map((label, index) => `${index + 1}. ${label}`), excerpt].filter((part) => part).map(normalize).join('\n')
}

// The numbered rows from `start` (a "1." row) with the lines indented under
// their labels, and the index of the first line after them. One rule line may
// separate rows (AskUserQuestion draws it above "Chat about this").
function optionBlock(lines, start) {
  const options = []
  let column = 0, i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(OPTION)
    const indent = line.length - line.trimStart().length
    if (match && Number(match[3]) === options.length + 1 && (!options.length || line.length - match[4].length === column)) {
      column = line.length - match[4].length
      options.push({ value: match[3], label: match[4].trim(), line, extra: [], selected: !!match[2] })
    } else if (options.length && line.trim() && indent >= column) {
      options.at(-1).extra.push(line)
    } else if (!(options.length && RULE.test(line.trim()) && Number(lines[i + 1]?.match(OPTION)?.[3]) === options.length + 1)) {
      break
    }
  }
  return { options, next: i }
}

// A line indented under a label continues it when its first word did not fit
// on the line above; otherwise it is a description (plan hint, AskUserQuestion
// description). Permission dialogs have no descriptions: every such line is label.
function dialogLabels(options, width, wrappedOnly) {
  return options.map((option) => {
    let label = option.label, previous = option.line
    for (const extra of option.extra) {
      const text = extra.trim()
      if (!wrappedOnly || previous.length + 1 + text.split(/\s+/)[0].length > width - 4) label += ` ${text}`
      previous = extra
    }
    return label
  })
}

function dialogExcerpt(lines) {
  const kept = lines.filter((line) => !RULE.test(line.trim()))
  const indents = kept.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length)
  const indent = indents.length ? Math.min(...indents) : 0
  return kept.map((line) => line.slice(indent).replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// A footer or a cursor row above the current dialog: an earlier dialog's remains.
function earlierDialog(lines, i) {
  const match = lines[i].match(OPTION)
  return FOOTER.test(lines[i].trim()) || !!(match && match[2])
}

// Claude's dialog header above the question: a known header, the tool name a
// hook notice names, or else a short title right under the top rule.
function headerAbove(lines, question) {
  const hooks = new Map()
  for (let i = 0; i < question; i++) {
    const match = lines[i].trim().match(HOOK_HEADER)
    if (match) hooks.set(match[1], i)
  }
  let titled = null
  for (let i = question - 1; i >= 0; i--) {
    const text = lines[i].trim()
    if (HEADER.test(text) || hooks.get(text) > i) return i
    if (earlierDialog(lines, i)) break
    if (titled === null && text && i && text.length <= 40 && TOP_RULE.test(lines[i - 1].trim()) && !OPTION.test(lines[i]) && !QUESTION.test(text)) titled = i
  }
  return titled
}

// Codex puts its question above the request: the nearest allowlisted question
// line, unless an earlier dialog's remains come first.
function questionAbove(lines, below) {
  for (let i = below; i >= 0; i--) {
    if (QUESTION.test(lines[i].trim())) return i
    if (earlierDialog(lines, i)) return null
  }
  return null
}

/**
 * Parse a current screen, never historical scrollback, into the dialog:
 * { kind: 'permission' | 'plan' | 'question', question, choices: [{ value, label, selected }],
 *   excerpt, identity, answerable } or null. The excerpt is the request with its
 * header line first (Claude) or the lines under the question (Codex), rule lines
 * removed. Anchored at the last "1." row on
 * screen: exactly one cursor, nothing but the footer below, "Yes..." first and
 * "No..." last with the request in full for permissions.
 */
export function parseSessionPermissionPrompt(screen) {
  if (typeof screen !== 'string' || !screen.trim()) return null
  const lines = screenLines(screen)
  let start = -1
  lines.forEach((line, index) => { if (line.match(OPTION)?.[3] === '1') start = index })
  if (start < 0) return null
  const { options, next } = optionBlock(lines, start)
  let i = next
  while (i < lines.length && !lines[i].trim()) i++
  let footer = ''
  if (i < lines.length && FOOTER.test(lines[i].trim())) { footer = lines[i].trim(); i++ }
  // Invariant: nothing but the footer below the options. A dialog with the composer or any output under it is history (echoed, scrolled, answered).
  if (options.length < 2 || options.length > 9 || options.filter((option) => option.selected).length !== 1 || lines.slice(i).some((line) => line.trim())) return null
  let above = start - 1
  while (above >= 0 && (!lines[above].trim() || RULE.test(lines[above].trim()))) above--
  if (above < 0) return null
  const lead = lines[above].trim()
  let top = above
  while (top > 0 && lines[top - 1].trim() && !RULE.test(lines[top - 1].trim())) top--
  const leadBlock = lines.slice(top, above + 1).map((line) => line.trim()).join(' ')
  const width = Math.max(...lines.map((line) => line.length))
  let labels = dialogLabels(options, width, true)
  let kind, question, excerpt = '', answerable = true
  if (ASK_FOOTER.test(footer) && labels.at(-1) === ASK_LAST) {
    // The tab strip ("☐ Colour  ✔ Submit") above the question is not the question.
    if (TAB_STRIP.test(leadBlock)) return null
    kind = 'question'
    question = leadBlock
    answerable = !labels.some((label) => CHECKBOX.test(label))
  } else if (PLAN_QUESTION.test(leadBlock) && YES.test(labels[0]) && labels.some((label) => PLAN_OPTION.test(label))) {
    kind = 'plan'
    question = leadBlock
  } else {
    labels = dialogLabels(options, width, false)
    if (!YES.test(labels[0]) || !NO.test(labels.at(-1))) return null
    kind = 'permission'
    if (QUESTION.test(lead)) {
      // Claude: header, request, question. A cropped header means the request is not all on screen: never a menu.
      // The excerpt starts with the header line ("Bash command", "Edit file", ...).
      const header = headerAbove(lines, above)
      if (header === null) return null
      question = lead
      excerpt = dialogExcerpt(lines.slice(header, above))
    } else {
      // Codex: question, request, options. A menu without its request is none.
      const at = questionAbove(lines, above)
      if (at === null) return null
      question = lines[at].trim()
      excerpt = dialogExcerpt(lines.slice(at + 1, start))
      if (!excerpt) return null
    }
  }
  const choices = options.map((option, index) => ({ value: option.value, label: labels[index], selected: option.selected }))
  return { kind, question, choices, excerpt, identity: promptIdentity(question, labels, excerpt), answerable }
}

/**
 * Mirrors backend _is_incomplete_permission_screen: a dialog's bottom is on
 * screen (its footer, or a "No…" option under an allowlisted question) without
 * a complete menu, so the top is cut off. Such a screen never falls back to an
 * unguarded manual choice. A dialog whose top shows but whose rows are not
 * drawn yet is not a fragment: it is still being drawn.
 */
export function isSessionPermissionPromptFragment(screen) {
  if (typeof screen !== 'string' || !screen.trim() || parseSessionPermissionPrompt(screen)) return false
  const lines = screenLines(screen).filter((line) => line.trim())
  if (!lines.length) return false
  const last = lines.at(-1)
  if (FOOTER.test(last.trim())) return true
  const option = last.match(OPTION)
  return !!option && NO.test(option[4]) && lines.some((line) => QUESTION.test(line.trim()))
}

export async function submitSessionPromptReply(sessionId, screen, reply, { sendInput, manual = false }) {
  const message = String(reply || '').trim()
  if (!sessionId || typeof screen !== 'string' || !screen.trim()) throw new Error('Refresh the current request before replying.')
  if (!message) throw new Error('Enter a reply first.')
  if (manual && (message.length > 2000 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(message))) {
    throw new Error('Use a single line of text, up to 2,000 characters.')
  }
  if (isSessionPermissionPromptFragment(screen)) {
    throw new Error('The permission request is incomplete or not recognized. Refresh to show the full request before replying.')
  }
  if (!manual) {
    const prompt = parseSessionPermissionPrompt(screen)
    if (prompt?.answerable === false) throw new Error('This question needs the terminal.')
    if (!prompt?.choices.some((choice) => choice.value === message)) throw new Error('This choice is not part of the current request. Refresh and review it again.')
  }
  const result = await sendInput(sessionId, message, {
    expected_screen: screen,
    ready_timeout: 0,
    ...(manual ? { prompt_reply: true } : {}),
  })
  if (!result?.ok || result.intercepted) throw new Error(result?.message || 'The assistant did not accept this reply.')
  return result
}

// Keep one-time approval, persistent approval, and refusal separate: the
// first "Yes…" allows once, the second "Yes…" (if any) persists, the last
// "No…" refuses. AskUserQuestion rows carry none of these roles.
export function promptChoices(snapshot) {
  const prompt = snapshot?.prompt
  const choices = Array.isArray(prompt?.choices) ? prompt.choices : []
  const value = (index) => choices[index]?.value || null
  const recognized = choices.length >= 2 && prompt?.kind !== 'question'
  return {
    allow: recognized && YES.test(choices[0].label) ? value(0) : null,
    allowSession: recognized && choices.length >= 3 && YES.test(choices[1].label) ? value(1) : null,
    deny: recognized && NO.test(choices.at(-1).label) ? value(choices.length - 1) : null,
    labels: recognized ? choices.map((choice) => choice.label) : [],
    question: prompt?.question || '',
    excerpt: prompt?.excerpt || (snapshot?.screen ? snapshot.screen.slice(-8000) : ''),
  }
}
