// Plan approvals and automations answer the live dialog through the guarded
// endpoint (lib/promptAnswer.js) instead of typing raw arrow keys. Free text
// goes out only once the CLI is back at its prompt (delivery wait_for_ready).
// What may be answered, and with which option, is decided in lib/promptMenu.js
// (planChoice, autoOption): a plan button never acts on a permission dialog.
import useStore from '../state/store'
import { sendTerminalCommand } from './terminal'
import { answerPrompt, fetchPromptSnapshot, isStalePromptError, promptErrorMessage } from './promptAnswer'
import { autoOption, keepPlanningOption, planChoice } from './promptMenu'

const notify = (sessionId, message, type = 'warning') => useStore.getState().addNotification?.({ sessionId, type, message })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const NOT_PLAN_TEXT = 'No plan approval is open right now.'

/** Answer the dialog in `snapshot` (or the live one) with the option at `key`; with `kind`, only a dialog of that kind. Never resends after a 409. */
export async function answerLiveChoice(sessionId, key, { snapshot, kind } = {}) {
  const current = snapshot || await fetchPromptSnapshot(sessionId).catch(() => null)
  const menu = current?.menu
  if (!menu) return { ok: false, reason: 'no_menu' }
  if (kind && menu.kind !== kind) return { ok: false, reason: kind === 'plan' ? 'not_plan' : 'wrong_kind' }
  if (menu.answerable === false) return { ok: false, reason: 'terminal_only' }
  const option = menu.options.find((candidate) => candidate.key === String(key))
  if (!option) return { ok: false, reason: 'no_option' }
  try {
    await answerPrompt(sessionId, current, option.key)
    useStore.getState().setSessionPlanWaiting(sessionId, false)
    return { ok: true, option }
  } catch (err) {
    return { ok: false, reason: isStalePromptError(err) ? 'stale' : 'error', message: promptErrorMessage(err) }
  }
}

const failureText = (result) => result.message || (
  result.reason === 'no_menu' ? 'No question is open in this session right now. Check the terminal.'
    : result.reason === 'not_plan' ? NOT_PLAN_TEXT
      : result.reason === 'no_option' ? 'The open question has no such option. Check the terminal.'
        : 'This question needs the terminal.')

/** Plan approval buttons: `number` is the option position in the live plan approval (1 auto mode, 2 review each edit). */
export async function answerPlanChoice(sessionId, number) {
  const current = await fetchPromptSnapshot(sessionId).catch(() => null)
  const choice = planChoice(current?.menu, number)
  const result = choice.option ? await answerLiveChoice(sessionId, choice.option.key, { snapshot: current, kind: 'plan' }) : { ok: false, ...choice }
  if (!result.ok) notify(sessionId, failureText(result))
  return result.ok
}

/** Feedback on a plan: leave the approval through "keep planning", then type once the CLI is at its prompt. Any other open dialog refuses. */
export async function sendPlanFeedbackGuarded(sessionId, feedback) {
  const text = String(feedback || '').trim()
  if (!sessionId || !text) return false
  const current = await fetchPromptSnapshot(sessionId).catch(() => null)
  if (current?.menu) {
    if (current.menu.kind !== 'plan') { notify(sessionId, NOT_PLAN_TEXT); return false }
    const result = await answerLiveChoice(sessionId, keepPlanningOption(current.menu).key, { snapshot: current, kind: 'plan' })
    if (!result.ok) { notify(sessionId, failureText(result)); return false }
  }
  return !!sendTerminalCommand(sessionId, text, { delivery: 'wait_for_ready' })
}

// Automations: answer an open menu only where autoOption allows it (polling
// for it when a plan approval is expected), otherwise say the sentence once
// the prompt is free. A question meant for the user is left alone ('blocked').
export async function answerOrSay(sessionId, sentence, { planOnly = false, attempts = 1, intervalMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await fetchPromptSnapshot(sessionId).catch(() => null)
    const menu = current?.menu
    if (menu) {
      const option = autoOption(menu, { planOnly })
      if (!option) return 'blocked'
      const result = await answerLiveChoice(sessionId, option.key, { snapshot: current })
      if (result.ok) return 'answered'
      if (result.reason !== 'stale') return 'failed'
    }
    if (attempt < attempts - 1) await sleep(intervalMs)
  }
  return sendTerminalCommand(sessionId, sentence, { delivery: 'wait_for_ready' }) ? 'typed' : 'failed'
}

export function approvePlanAutomatically(sessionId) {
  return answerOrSay(sessionId, 'Plan looks good, proceed with implementation.', { planOnly: true, attempts: 20, intervalMs: 1000 })
}
