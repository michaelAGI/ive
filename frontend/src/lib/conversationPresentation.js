// Tone and colour only: the menu shows the CLI's own words (PromptMenu.jsx)
// and the unchanged live dialog remains the authority for replies.
const SETUP_ISSUE = /missing API key|not configured|fail.closed/i

/** A one-line notice when the request is really an IVE safety-check setup problem. */
export function promptNotice(menu) {
  if (!menu || !SETUP_ISSUE.test(menu.excerpt || '')) return ''
  return 'An additional IVE safety check needs setup. Changing the agent mode does not fix this check. Review the exact request before deciding.'
}

/** 'allow' | 'deny' | 'persistent' | 'neutral' for colouring an option line. */
export function choiceTone(option, index, menu) {
  const label = String(option?.label || '')
  if (/^no\b/i.test(label)) return 'deny'
  if (/^yes\b/i.test(label)) return index === 0 ? 'allow' : 'persistent'
  return menu?.kind === 'question' ? 'neutral' : index === 0 ? 'allow' : 'neutral'
}

export function activityLabel(steps, running) {
  if (!running) return `Activity · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  const step = steps.at(-1)
  const tool = step?.tool_use
  if (typeof tool?.input?.description === 'string' && tool.input.description.trim()) return tool.input.description.trim()
  const name = String(tool?.name || '').toLowerCase()
  if (/search_memory/.test(name)) return 'Checking project context'
  if (/search|grep|glob/.test(name)) return 'Finding relevant files'
  if (/read/.test(name)) return 'Reading project files'
  if (/write|edit|patch/.test(name)) return 'Updating files'
  if (/bash|shell|exec/.test(name)) return 'Running a project command'
  if (name) return 'Working with a connected service'
  return 'Working on your request'
}

export function hasVisibleMessage(content) {
  if (typeof content === 'string') {
    if (/^\s*[\[{]/.test(content)) {
      try { return hasVisibleMessage(JSON.parse(content)) } catch {}
    }
    return Boolean(content.trim())
  }
  if (Array.isArray(content)) return content.some(hasVisibleMessage)
  if (!content || typeof content !== 'object') return false
  if (content.type === 'thinking' || content.type === 'redacted_thinking') return false
  if (content.type === 'text') return Boolean(String(content.text || '').trim())
  return true // Images, files and other rich content must remain visible.
}
