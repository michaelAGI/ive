export const REVIEW_SCOPES = {
  working: 'Not selected for commit',
  staged: 'Selected for commit',
}

export function reviewTarget(session, scope = 'working', selectedFile = null) {
  if (!session?.id) return null
  const target = { reviewed_session_id: session.id, scope: scope === 'staged' ? 'staged' : 'working' }
  if (selectedFile) target.selected_file = selectedFile
  const taskId = session.active_ticket_id || session.task_id
  if (taskId) target.task_id = taskId
  return target
}

export function reviewContextSummary(context, fallback = {}) {
  const original = typeof context?.original_prompt === 'string' ? context.original_prompt : context?.original_prompt?.text
  return {
    project: context?.workspace?.name || fallback.workspace?.name || 'Project not available',
    session: context?.session?.name || fallback.session?.name || 'Conversation not available',
    task: context?.task?.title || '',
    original: original || '',
    reason: context?.reason?.text || 'No review trigger is recorded for this conversation.',
    scope: context?.scope_label || REVIEW_SCOPES[context?.scope || fallback.scope] || REVIEW_SCOPES.working,
    warning: context?.scope_warning || 'This view includes changes in the shared project. They may come from more than one session or person.',
    file: context?.selected_file || fallback.selectedFile || '',
  }
}

export function explanationProviderFields(session, cliType) {
  const fields = { cli_type: cliType }
  // A model/account selected for one provider must never leak to another.
  if (session?.cli_type === cliType) {
    if (session.model) fields.model = session.model
    if (session.account_id) fields.account_id = session.account_id
  }
  return fields
}

export const EXPLANATION_QUESTIONS = {
  purpose: 'What are these changes for, why is a review needed, and what should I check?',
  separate_agent: 'Why would another agent be useful here, and is one actually required?',
}
