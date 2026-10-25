// The recognised terminal dialog ("menu") as backend and frontend share it:
// the CLI's own question and option labels, never paraphrased.
//   { kind: 'permission' | 'plan' | 'question', question, options: [{key, label, selected}],
//     excerpt, identity, answerable }
// `identity` comes from the backend and is what a guarded reply is checked
// against; a menu parsed from the screen in the browser has none and replies
// with the legacy expected_screen instead.
const KINDS = new Set(['permission', 'plan', 'question'])
const DIGIT = /^[1-9]$/

export function normalizeMenu(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.options) || !raw.options.length) return null
  const options = raw.options.map((option, index) => ({
    key: String(option?.key ?? option?.value ?? index + 1),
    label: String(option?.label ?? '').trim(),
    selected: !!option?.selected,
  }))
  if (options.some((option) => !option.label)) return null
  // Exactly one highlighted option, like the CLI cursor.
  const first = options.findIndex((option) => option.selected)
  options.forEach((option, index) => { option.selected = index === (first < 0 ? 0 : first) })
  return {
    kind: KINDS.has(raw.kind) ? raw.kind : 'permission',
    question: String(raw.question || '').trim(),
    options,
    excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : '',
    identity: typeof raw.identity === 'string' && raw.identity.trim() ? raw.identity : null,
    answerable: raw.answerable !== false,
  }
}

/** A menu from the browser-side parser (lib/sessionPrompt.js), for backends without `menu`. */
export function menuFromPrompt(prompt) {
  if (!prompt || !Array.isArray(prompt.choices) || !prompt.choices.length) return null
  return normalizeMenu({
    kind: prompt.kind || 'permission',
    question: prompt.question,
    options: prompt.choices.map((choice) => ({ key: choice.value, label: choice.label, selected: !!choice.selected })),
    excerpt: prompt.excerpt,
    answerable: prompt.answerable !== false,
  })
}

/** Stable key of a question: the selection may move, the request must stay put. */
export function menuKey(menu) {
  if (!menu) return ''
  return menu.identity || [menu.question, ...menu.options.map((option) => `${option.key}. ${option.label}`), menu.excerpt].join('\n')
}

export function selectedOption(menu) {
  return menu?.options?.find((option) => option.selected) || menu?.options?.[0] || null
}

export function optionForKey(menu, key) {
  const wanted = String(key ?? '').trim().toLowerCase()
  if (!wanted) return null
  return menu?.options?.find((option) => option.key.toLowerCase() === wanted) || null
}

// Composer shortcuts while a menu is open: a digit (or an option's letter)
// picks that option. y/yes and n/no stand for the first "Yes…" and the last
// "No…" of a permission dialog only (or a label that is exactly Yes/No or
// carries that hotkey): a plan's "Yes, and use auto mode" or a question's
// rows never come from a reflex keystroke.
const yesShortcut = (option, menu) => /^yes$/i.test(option.label) || /\(y\)/i.test(option.label) || (menu.kind === 'permission' && /^yes\b/i.test(option.label))
const noShortcut = (option, menu) => /^no$/i.test(option.label) || /\(n\)/i.test(option.label) || (menu.kind === 'permission' && /^no\b/i.test(option.label))

export function shortcutChoice(text, menu) {
  if (!menu?.options?.length) return null
  const typed = String(text || '').trim().toLowerCase().replace(/[.!]$/, '')
  if (!typed || typed.length > 3) return null
  const direct = optionForKey(menu, typed)
  if (direct) return direct
  if (typed === 'y' || typed === 'yes') return yesShortcut(menu.options[0], menu) ? menu.options[0] : null
  if (typed === 'n' || typed === 'no') return noShortcut(menu.options.at(-1), menu) ? menu.options.at(-1) : null
  return null
}

// Automations (full_auto, auto_approve_plan) answer only what a person would
// answer the same way every time: a plan approval's first option, or a plain
// "Yes" / "Yes, proceed" on a permission. Questions (AskUserQuestion) and
// persistent allowances ("always allow", "don't ask again", auto mode) are
// left to the user (null = blocked).
export function autoOption(menu, { planOnly = false } = {}) {
  if (!menu?.options?.length || menu.answerable === false || menu.kind === 'question') return null
  if (menu.kind === 'plan') return menu.options[0]
  if (planOnly) return null
  const first = menu.options[0]
  return /^yes$/i.test(first.label) || /^yes, proceed\b/i.test(first.label) ? first : null
}

// The plan buttons act on a plan approval only: with any other dialog live
// (a Bash permission, a question) "Approve" would pick that dialog's option.
export function planChoice(menu, number) {
  if (!menu) return { reason: 'no_menu' }
  if (menu.kind !== 'plan') return { reason: 'not_plan' }
  if (menu.answerable === false) return { reason: 'terminal_only' }
  const option = menu.options[number - 1]
  return option ? { option } : { reason: 'no_option' }
}

/** The plan option that leaves the approval for feedback: "keep planning", else the last "No…", else the last row. */
export function keepPlanningOption(menu) {
  return menu.options.find((option) => /keep planning|what to change/i.test(option.label))
    || menu.options.find((option) => /^no\b/i.test(option.label)) || menu.options.at(-1)
}

// Codex draws question, request, options; Claude draws the request with its
// header line first, then the question. A permission excerpt that does not
// start with a Claude header (or a hook confirmation) is drawn question first.
const CLAUDE_HEADER = /^(?:Tool use|Bash command|Run command|Edit file|Create file|Write file|Read file|Fetch|Web ?search|Notebook edit|Edit notebook)\b/i
const HOOK_NOTICE = /^[│|]?\s*Hook PreToolUse:/

export function questionFirst(menu) {
  if (menu?.kind !== 'permission' || !menu.excerpt) return false
  const [first = '', second = ''] = menu.excerpt.split('\n').map((line) => line.trim())
  return !CLAUDE_HEADER.test(first) && !HOOK_NOTICE.test(second)
}

// AskUserQuestion's free-text rows ("Type something.", "Chat about this",
// with a "[ ]" box in multi-select): drawn as the CLI draws them, but typing
// the answer happens in the terminal, so choosing one opens it instead of
// sending a guarded choice.
const TERMINAL_ROW = /^(?:\[[ xX✔✓]\]\s*)?(?:Type something\.?|Chat about this)$/i

export function opensTerminal(option, menu) {
  return !!option && menu?.kind === 'question' && TERMINAL_ROW.test(String(option.label || '').trim())
}

export function isDigitKey(key) {
  return DIGIT.test(String(key))
}

// ⌘⇧Y walks the waiting sessions oldest question first; unknown ages last.
export function orderWaitingSessions(sessions) {
  const age = (session) => (typeof session?.attention?.asked_at === 'number' ? session.attention.asked_at : Infinity)
  return [...(sessions || [])].sort((a, b) => age(a) - age(b) || String(a.id).localeCompare(String(b.id)))
}

export function nextWaitingSessionId(ordered, lastId) {
  if (!ordered?.length) return null
  const index = ordered.findIndex((session) => session.id === lastId)
  return ordered[(index + 1) % ordered.length].id
}

/**
 * One stop of the ⌘⇧Y walk: the waiting session after `currentId` (oldest
 * first, wrapping) and where its question is reached. `targets(id)` returns
 * the on-screen element in order of preference (its pop-up card, else its
 * PromptMenu or band); without one the session itself has to be opened.
 */
export function nextPromptStop(ordered, currentId, targets) {
  const id = nextWaitingSessionId(ordered, currentId)
  if (!id) return null
  const target = targets(id) || null
  return { id, target, open: !target }
}
