// Presentation only: the unchanged live screen remains the authority for replies.
const cleanLines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter((line) => line && !/^[─━╌┄│┆\s]+$/.test(line))

const PERSISTENT_RE = /^Yes, and don(?:'|’)t ask again for (.+)$/i

function requestVerb(kind) {
  const k = kind.toLowerCase()
  if (/^(bash command|run command)$/.test(k)) return 'run a command'
  if (/^(edit|update|modify) file/.test(k)) return 'edit a file'
  if (/^(create|write|save) file/.test(k)) return 'create a file'
  if (/^read file/.test(k)) return 'read a file'
  if (/^(fetch|web ?fetch)/.test(k)) return 'fetch a web page'
  if (/^(web ?search)/.test(k)) return 'search the web'
  if (/^tool use$/.test(k)) return 'use a tool'
  if (k.endsWith(' file')) return `${k.replace(/ file$/, '')} a file`
  return ''
}

// `agent` names who is asking ("Claude", "Codex"); the chat card shows it as
// "Claude wants to run a command" above the exact request.
export function permissionPresentation(prompt, agent = 'The assistant') {
  const lines = cleanLines(prompt?.excerpt)
  const kind = lines.shift() || ''
  const description = lines[0] || 'Review the requested action'
  const setupIssue = /missing API key|not configured|fail.closed/i.test(prompt?.excerpt || '')
  const verb = requestVerb(kind)
  return {
    title: /^(Bash command|Run command)$/i.test(kind) ? 'Allow this action?' : 'Allow access?',
    summary: verb ? `${agent} wants to ${verb}` : kind ? `${agent} asks for: ${kind}` : `${agent} needs your permission`,
    kind,
    description,
    // `description` is the first line under the heading (the command, the
    // file, the tool); `detail` is the rest the terminal shows (the note,
    // the diff, the tool input).
    detail: lines.slice(1).join('\n'),
    notice: setupIssue ? 'An additional IVE safety check needs setup. Changing the agent mode does not fix this check. Review the exact request before deciding.' : '',
    choices: (prompt?.choices || []).map((choice, index) => {
      const persistent = choice.label.match(PERSISTENT_RE)
      const plain = choice.label.replace(/\s*\((?:shift\+)?tab\)\s*$/i, '')
      return {
        ...choice,
        label: choice.label === 'No' ? 'Don’t allow' : choice.label === 'Yes' ? 'Allow once' : persistent ? `Always allow ${persistent[1]}` : plain,
        kind: choice.label === 'No' ? 'deny' : index === 0 ? 'allow' : 'persistent',
      }
    }),
  }
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
