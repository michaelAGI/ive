import { create } from 'zustand'

// Whether sessions show the "Large context" banner and the context-low toast.
// People with generous context limits turn it off; the compaction indicator
// in the session header stays.
export const CONTEXT_WARNINGS_KEY = 'ive.context-warnings.v1'

export function readContextWarnings(storage = globalThis.localStorage) {
  try { return storage?.getItem(CONTEXT_WARNINGS_KEY) !== 'off' } catch { return true }
}

const useContextWarnings = create((set) => ({
  enabled: readContextWarnings(),
  setEnabled: (enabled) => {
    set({ enabled: !!enabled })
    try { localStorage.setItem(CONTEXT_WARNINGS_KEY, enabled ? 'on' : 'off') } catch { /* private mode */ }
  },
}))

export default useContextWarnings
