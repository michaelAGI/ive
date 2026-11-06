// The visible scope is the authority for sending and saving recipients. A stale
// selection or a saved global group must not reach hidden/closed sessions.
export function getBroadcastRecipients(selected, scopedTabs, openTabs, sessions) {
  const open = new Set(openTabs || [])
  return [...new Set(scopedTabs || [])].filter((id) => (
    Boolean(selected?.[id]) && open.has(id) && Boolean(sessions?.[id])
  ))
}

const sessionsWord = (count) => `${count} ${count === 1 ? 'session' : 'sessions'}`

/** A broadcast leaves out sessions with an open dialog: the text would have answered it. */
export function broadcastSkippedMessage(count) {
  return `Skipped ${sessionsWord(count)} with an open question. Answer it there first.`
}

export function broadcastFailedMessage(count) {
  return `Broadcast not delivered to ${sessionsWord(count)}. Check each session before retrying.`
}
