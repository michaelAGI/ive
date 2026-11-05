// Reasoning effort helpers. Pure (no store import) so node tests can load it.
//
// '' means "pass no --effort": the CLI then uses its own default, which for
// Claude is CLAUDE_CODE_EFFORT_LEVEL / modelSettings / effortLevel from the
// user's settings, NOT "high". The backend resolves that value and sends it
// as profile.effort_default ({ value, source, label, by_model }).

// Values `claude --effort` accepts (2.1.296).
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export function effortDefaultValue(profile, model) {
  const def = profile?.effort_default
  if (!def) return null
  if (model && def.by_model && def.by_model[model]) return def.by_model[model]
  return def.value || null
}

// Label for the "nothing chosen" option of an effort picker.
export function effortDefaultLabel(profile, model) {
  const def = profile?.effort_default
  if (!def) return 'Default (CLI setting)'
  if (model && def.by_model && def.by_model[model]) {
    return `Default (${def.by_model[model]}, your Claude settings for ${model})`
  }
  return def.label || (def.value ? `Default (${def.value})` : 'Default (CLI picks per model)')
}

// Options for an effort <select>: the default entry first, then the levels.
export function effortOptions(levels, profile, model) {
  if (!levels || levels.length === 0) return []
  return [
    { value: '', label: effortDefaultLabel(profile, model) },
    ...levels.map((level) => ({ value: level, label: level })),
  ]
}

// Short text for read-only displays (cards, template details).
export function effortDisplay(value, profile, model) {
  if (value) return value
  const def = effortDefaultValue(profile, model)
  return def ? `${def} (default)` : 'default'
}

// What the chat header shows. `observed` comes from
// GET /api/sessions/:id/runtime-model (the CLI's own transcript), so a
// `/model` or `/effort` switch inside the terminal shows up after the next
// turn. Falls back to the launch config, then to the resolved default.
export function headerModelInfo(session, observed, profile, launched) {
  const configuredModel = session?.model || ''
  const configuredEffort = session?.effort || ''
  const model = observed?.model || launched || configuredModel || 'default'
  const effort = observed?.effort || configuredEffort || effortDefaultValue(profile, configuredModel) || ''
  const parts = []
  if (observed?.model) {
    parts.push(`Last turn ran on ${observed.model}${observed.effort ? ` at ${observed.effort} effort` : ''} (from the CLI transcript).`)
    if (configuredModel && observed.model !== configuredModel && !observed.model.includes(configuredModel)) {
      parts.push(`Configured: ${configuredModel}. The last recorded turn differs from this choice.`)
    }
  } else {
    parts.push(`Launch setting: ${configuredModel || 'CLI default model'}, ${configuredEffort ? `${configuredEffort} effort` : effortDefaultLabel(profile, configuredModel).toLowerCase()}.`)
  }
  return { model, effort, observed: Boolean(observed?.model), title: parts.join(' ') }
}

// "claude-sonnet-4-5-20250929" → "Sonnet 4.5", like the chat apps name their models.
export function shortModelName(model, options = []) {
  const id = String(model || '').trim()
  if (!id || id === 'default') return 'Default'
  const known = options.find((o) => o.value === id)
  if (known?.short && known.short !== id && known.short.length <= 24) return known.short
  const cap = (word) => word[0].toUpperCase() + word.slice(1)
  const claude = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d)(?!\d))?/i)
  if (claude) return `${cap(claude[1].toLowerCase())} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  if (/^(opus|sonnet|haiku|fable|mythos)$/i.test(id)) return cap(id.toLowerCase())
  const o = id.match(/^o(\d)(?:-(mini|pro))?$/i)
  if (o) return `o${o[1]}${o[2] ? ` ${cap(o[2])}` : ''}`
  const gpt = id.match(/^gpt-?(\d+(?:\.\d+)?)(?:-(mini|nano|codex|pro))?/i)
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${cap(gpt[2])}` : ''}`
  const gemini = id.match(/^gemini-(\d+(?:\.\d+)?)-?(pro|flash)?/i)
  if (gemini) return `Gemini ${gemini[1]}${gemini[2] ? ` ${cap(gemini[2])}` : ''}`
  return id.length > 24 ? `${id.slice(0, 22)}…` : id
}
