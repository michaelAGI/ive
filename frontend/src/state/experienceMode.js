import { create } from 'zustand'

export const EXPERIENCE_KEY = 'ive.experience-mode.v1'

export function readExperience(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(EXPERIENCE_KEY) || 'null') || {}
    const previousTerminalPreference = storage?.getItem('cc-terminalBoardMode') === '1'
    return {
      mode: saved.mode === 'dev' || (!saved.mode && previousTerminalPreference) ? 'dev' : 'chat',
      provider: saved.provider === 'codex' ? 'codex' : 'claude',
      homeDraft: typeof saved.homeDraft === 'string' ? saved.homeDraft : '',
      workspaceId: typeof saved.workspaceId === 'string' ? saved.workspaceId : null,
    }
  } catch { return { mode: 'chat', provider: 'claude', homeDraft: '', workspaceId: null } }
}

// Presentation preferences only. Never start/stop a process, change permission
// policy, switch a running session's provider, or overwrite its layout here.
const useExperienceMode = create((set, get) => {
  const update = (patch) => {
    set(patch)
    const { mode, provider, homeDraft, workspaceId } = get()
    try { localStorage.setItem(EXPERIENCE_KEY, JSON.stringify({ mode, provider, homeDraft, workspaceId })) } catch { /* private mode */ }
  }
  return {
    ...readExperience(),
    setMode: (mode) => update({ mode: mode === 'dev' ? 'dev' : 'chat' }),
    setProvider: (provider) => update({ provider: provider === 'codex' ? 'codex' : 'claude' }),
    setHomeDraft: (homeDraft) => update({ homeDraft: String(homeDraft || '') }),
    setWorkspaceId: (workspaceId) => update({ workspaceId: workspaceId || null }),
  }
})

export default useExperienceMode
