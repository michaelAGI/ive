// Terminal dialogs for the PromptMenu browser tests and what the backend's
// _session_permission_menu(screen) returns for them (the shared "menu" contract).
export const BASH_TWO = `Bash command
Find Orbit and traffic projects
──────────────────────────────
ls -d */ Projects/*/ | grep -i 'orbit|traffic'
Safety check not configured: missing API key 'api_key_gemini_api' (fail-closed)
Do you want to proceed?
 ❯ 1. Yes
   2. No

Esc to cancel · Tab to amend`

// A long option, as the CLI wraps it at narrow widths: the menu wraps it too, nothing is cut off.
export const BASH_LONG = BASH_TWO.replace('   2. No', "   2. Yes, and don't ask again for commands that start with ls -d in /isolated/orbit/packages/traffic-fixtures from this project\n   3. No")

export const EDIT_THREE = `Edit file
src/App.jsx
──────────────────────────────
-  const title = 'Orbit'
+  const title = 'Orbit traffic'
Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No

Esc to cancel · Tab to amend`

// AskUserQuestion: the question, numbered rows with description lines, "Type
// something.", a rule, "Chat about this", the "Enter to select" footer. The
// last two rows are drawn 1:1 but open the terminal instead of being sent.
export const ASK_COLOUR = `Which colour should the button use?

❯ 1. Red
     Choose red
  2. Green
     Choose green
  3. Type something.
──────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`

// Like the backend, a dialog counts only with its request header above the
// question; a cropped menu is "incomplete" and never answerable from outside.
const HEADER = /^\s*(?:Tool use|Bash command|Run command|Edit file|Create file|Write file|Read file|Fetch|Web search|Notebook)\s*$/i

// The shared identity: question, "1. label" per option and the excerpt, runs
// of whitespace collapsed and each part trimmed, empty parts dropped, joined
// with newlines. Stable across cursor moves and redraws; computed the same way
// in both parsers (backend _session_permission_menu, lib/sessionPrompt.js).
const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
export const identityOf = (question, labels, excerpt) => [question, ...labels.map((label, index) => `${index + 1}. ${label}`), excerpt].filter(Boolean).map(normalize).join('\n')
// The excerpt: the header line and the request lines above the question without rule lines, common indent removed.
const RULE = /^[─╌━═▔]{8,}(?:\s.*)?$/
export function excerptOf(lines) {
  const kept = lines.filter((line) => !RULE.test(line.trim()))
  const indents = kept.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length)
  const indent = indents.length ? Math.min(...indents) : 0
  return kept.map((line) => line.slice(indent).replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function askMenuFor(screen) {
  const lines = String(screen || '').split('\n')
  const first = lines.findIndex((line) => /^\s*[❯›]?\s*1\.\s+\S/.test(line))
  if (first < 0) return null
  const options = []
  for (const line of lines.slice(first)) {
    const m = line.match(/^\s*([❯›])?\s*(\d)\.\s+(.+?)\s*$/)
    if (m) options.push({ key: m[2], label: m[3], selected: !!m[1] })
  }
  let top = first - 1
  while (top >= 0 && !lines[top].trim()) top--
  let start = top
  while (start > 0 && lines[start - 1].trim()) start--
  const question = lines.slice(start, top + 1).map((line) => line.trim()).join(' ')
  const answerable = !options.some((o) => /^\[[ xX]\] /.test(o.label))
  return { kind: 'question', question, options, excerpt: '', identity: identityOf(question, options.map((o) => o.label), ''), answerable, choices: options.map((o) => o.key), selected: options.find((o) => o.selected)?.key || '1' }
}

export function menuFor(screen, kind = 'permission') {
  if (/Enter to select/.test(screen) && /Chat about this/.test(screen)) return askMenuFor(screen)
  const lines = String(screen || '').split('\n')
  const q = lines.findIndex((line) => /^\s*Do you want to proceed\?\s*$/.test(line))
  if (q < 0 || !/Esc to cancel/.test(screen)) return null
  const hookHeaders = new Map()
  lines.slice(0, q).forEach((line, index) => {
    const m = line.match(/^\s*[│|]?\s*Hook PreToolUse:([A-Za-z][\w:.-]*) requires confirmation for this tool:\s*$/)
    if (m) hookHeaders.set(m[1], index)
  })
  let start = -1
  for (let index = q - 1; index >= 0; index--) if (HEADER.test(lines[index]) || hookHeaders.get(lines[index].trim()) > index) { start = index; break }
  if (start < 0) return null
  const options = []
  for (const line of lines.slice(q + 1)) {
    const m = line.match(/^\s*([❯›>])?\s*(\d)\.\s+(.+?)\s*$/)
    if (m) options.push({ key: m[2], label: m[3], selected: !!m[1] })
    else if (options.length && /^\s+\S/.test(line) && !/Esc to cancel/.test(line)) options.at(-1).label += ` ${line.trim()}`
  }
  if (!options.length) return null
  const excerpt = excerptOf(lines.slice(start, q))
  const question = lines[q].trim()
  return { kind, question, options, excerpt, identity: identityOf(question, options.map((o) => o.label), excerpt), answerable: true, choices: options.map((o) => o.key), selected: options.find((o) => o.selected)?.key || '1' }
}
