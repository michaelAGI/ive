// Phone actions use the same authenticated HTTP endpoints as the desktop.
// Keep delivery acknowledgment separate from the agent actually becoming idle.
export function phoneControlReason(session, { connected, auth } = {}) {
  if (!session?.id) return 'This session is no longer available.'
  if (session.read_only || session.is_external) return 'This session is read-only.'
  if (session.archived) return 'Archived history. Reopen the session to control it.'
  if (!connected) return 'No connection to the Mac. Wait for it to reconnect.'
  if (!auth) return 'Loading access rights.'
  if (!['full', 'code'].includes(auth.mode)) return 'Your access does not allow terminal control.'
  return ''
}

export function phoneInterruptBytes(session) {
  return session?.cli_type === 'gemini' || session?.cli_type === 'shell' || session?.session_type === 'shell' ? '\x03' : '\x1b'
}

export async function interruptPhoneSession(api, session, access) {
  const reason = phoneControlReason(session, access)
  if (reason) throw new Error(reason)
  if (!session.pty_alive) throw new Error('This session is not running.')
  const result = await api.sendSessionInput(session.id, phoneInterruptBytes(session), { raw: true })
  if (result?.ok !== true || (result.session_id && result.session_id !== session.id)) {
    throw new Error('The Mac did not confirm the stop. Check the status and try again.')
  }
  return result
}

export function phoneSessionPatch(session, draft, options) {
  const patch = {}
  const name = String(draft.name || '').trim()
  if (!name) throw new Error('Give this session a name.')
  if (name.length > 120) throw new Error('The name can have at most 120 characters.')
  if (name !== session.name) patch.name = name
  const shell = session.cli_type === 'shell' || session.session_type === 'shell'
  for (const field of shell ? [] : ['model', 'effort', 'permission_mode']) {
    const value = draft[field] ?? ''
    if (value === (session[field] || '')) continue
    if (!options[field]?.some((option) => option.value === value)) throw new Error('This setting is not available for this agent.')
    patch[field] = value
  }
  if (Object.keys(patch).some((field) => field !== 'name')) patch.apply_live = true
  return patch
}

export function phoneApplyFeedback(results = {}) {
  const states = Object.values(results).filter(Boolean).map((result) => result.state)
  if (states.some((state) => ['failed', 'error', 'unsupported'].includes(state))) return { tone: 'error', text: 'Saved, but not applied to the running agent. Check the details. The previous setting may still be active.' }
  if (states.includes('pending')) return { tone: 'pending', text: 'Saved. Applies after the current answer or approval.' }
  if (states.some((state) => ['scheduled', 'applying'].includes(state))) return { tone: 'pending', text: 'Saved. The agent restarts with these settings.' }
  if (states.includes('saved')) return { tone: 'saved', text: 'Saved. Applies on the next start of this session.' }
  if (states.length && states.every((state) => state === 'applied' || state === 'none')) return { tone: 'applied', text: 'The Mac applied the settings.' }
  return { tone: 'saved', text: 'Saved on the Mac.' }
}

export async function savePhoneSession(api, session, draft, options, access) {
  const reason = phoneControlReason(session, access)
  if (reason) throw new Error(reason)
  const patch = phoneSessionPatch(session, draft, options)
  if (!Object.keys(patch).length) return null
  const updated = await api.updateSession(session.id, patch)
  if (updated?.id !== session.id) throw new Error('The Mac did not confirm the change. Reload to see the current state.')
  return updated
}
