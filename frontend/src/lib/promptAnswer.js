// Answering the agent's native prompt from outside the terminal (chat card,
// terminal tile band, plan buttons). Only the current dialog can authorize an
// answer: the backend compares `expected_identity` (or, for older servers
// without a `menu`, `expected_screen`) and refuses with 409
// stale_session_prompt when the dialog changed. Callers reload after a 409
// and never resend.
import { api } from './api.js'
import { isSessionPermissionPromptFragment, parseSessionPermissionPrompt, submitSessionPromptReply } from './sessionPrompt.js'
import { menuFromPrompt, normalizeMenu, optionForKey } from './promptMenu.js'

export const PROMPT_SNAPSHOT_LINES = 60

// → { sessionId, screen, prompt, menu, kind, answerable, identity, incomplete, startupBlocker, viewState }
// kind/answerable/identity describe the dialog a reply is checked against:
// identity is the server's (null for a menu parsed here, which replies with
// expected_screen instead).
export async function fetchPromptSnapshot(sessionId) {
  const output = await api.getSessionOutput(sessionId, PROMPT_SNAPSHOT_LINES, { permission_view: true })
  // Only the current screen can authorize an action; text is scrollback.
  const screen = typeof output?.screen === 'string' ? output.screen : ''
  const prompt = parseSessionPermissionPrompt(screen)
  const menu = normalizeMenu(output?.menu) || menuFromPrompt(prompt)
  return {
    sessionId,
    screen,
    prompt,
    menu,
    kind: menu?.kind || null,
    answerable: menu ? menu.answerable !== false : null,
    identity: menu?.identity || null,
    incomplete: !menu && isSessionPermissionPromptFragment(screen),
    startupBlocker: output?.startup_blocker || null,
    viewState: output?.permission_view_state || null,
  }
}

export { promptChoices } from './sessionPrompt.js'

export function isStalePromptError(err) {
  return err?.body?.code === 'stale_session_prompt'
}

export function isQuestionOpenError(err) {
  return err?.status === 409 && err?.body?.code === 'question_open'
}

/** The guard refused because the dialog takes several answers or free text: only the terminal can answer it. */
export function isTerminalRequiredError(err) {
  return err?.status === 409 && err?.body?.code === 'terminal_required'
}

export const QUESTION_OPEN_HINT = 'Answer the question above first'
export const STALE_HINT = 'The question changed, look again'
export const SENDING_HINT = 'Sending the last answer, one moment'

export function promptErrorMessage(err) {
  if (isStalePromptError(err)) return err.body.partial ? `${STALE_HINT}. Text may already be typed in the terminal.` : STALE_HINT
  if (isQuestionOpenError(err)) return QUESTION_OPEN_HINT
  return err?.body?.startup_blocker?.label || err?.message || 'Reply was not sent. Please try again.'
}

// Sends an option key ("1" | "2" | …, or free text with manual: true) against
// the dialog in `snapshot`. Throws the ApiError on 409 (err.body.code).
export async function answerPrompt(sessionId, snapshot, value, { manual = false } = {}) {
  const menu = snapshot?.menu
  const choice = String(value ?? '').trim()
  if (!manual && menu?.identity) {
    if (menu.answerable === false) throw new Error('This question needs the terminal.')
    if (!optionForKey(menu, choice)) throw new Error('This choice is not part of the current request. Refresh and review it again.')
    const result = await api.sendSessionInput(sessionId, undefined, { choice, expected_identity: menu.identity, ready_timeout: 0 })
    if (!result?.ok || result.intercepted) throw new Error(result?.message || 'The assistant did not accept this reply.')
    return result
  }
  return submitSessionPromptReply(sessionId, snapshot?.screen, choice, { sendInput: api.sendSessionInput, manual })
}
