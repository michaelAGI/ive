// Keep both review entry points on the same evidence-first default.
export const DEFAULT_REVIEW_AGENT_PROMPT = `Review the selected changes independently against the original user request. Inspect the actual diff, surrounding code and relevant tests without editing project files or applying fixes. Do not treat another agent's completion summary or claimed passing tests as evidence.

Look for concrete bugs, missed requirements, security issues and regressions. Check boundary cases and failure paths. Run relevant non-destructive checks when available; record the commands and observed results. If a check cannot be run, say what remains unverified. Do not claim tests passed unless you ran them.

Return actionable findings with file and line references, then a short list of checks performed and remaining gaps. If you found no issues, state that with the limits of your review.

{annotations}

\`\`\`diff
{diff}
\`\`\``

export async function composeIndependentReview(api, instructions, sessionId, mode = 'new') {
  try {
    const result = await api.composeReviewBrief({
      instructions,
      reviewed_session_id: sessionId,
    })
    if (typeof result?.brief === 'string' && result.brief.trim()) return result.brief
    throw new Error('Empty review context')
  } catch (error) {
    if (mode === 'current') return instructions
    throw new Error('Could not prepare the original task for review. Try again before starting the reviewer.')
  }
}

export async function sendReviewRequest({ store, sessionId, prompt, start, send }) {
  if (!sessionId) throw new Error('No review session available')
  if (start && !await store.ensureSessionRunning(sessionId)) {
    throw new Error('The reviewer could not start. Open its session to finish setup, then start the review again.')
  }
  if (!send(sessionId, prompt, { literal: true })) throw new Error('Could not queue the review request. Check the session and try again.')
}
