import { isTauri } from './platform.js'

// One shared update state for the background check, settings and dialog.
// Installation is only called by the explicit confirmation in the dialog.
export function createUpdateController(transport) {
  let state = { supported: transport.supported, currentVersion: '', automatic: false, version: null, downloaded: false, restartRequired: false, phase: 'idle', error: '', open: false, dismissed: null, progress: null, checked: false }
  const listeners = new Set()
  const set = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
  let busy = false
  const run = async (phase, action) => {
    if (busy) return false
    busy = true; set({ phase, error: '' })
    try { await action(); return true }
    catch (error) {
      const message = typeof error === 'string' ? error : error?.message || 'The update could not be completed. Try again.'
      // The native app remains reachable if installation stopped the backend.
      try { set(await transport.invoke('desktop_update_status')) } catch { /* keep current state */ }
      set({ error: message }); return false
    } finally { busy = false; set({ phase: 'idle' }) }
  }
  const download = async () => {
    if (!state.version || state.downloaded) return
    set({ phase: 'downloading', progress: null })
    const progress = await transport.channel(value => set({ progress: value }))
    set(await transport.invoke('desktop_update_download', { version: state.version, progress }))
  }
  return {
    getSnapshot: () => state,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    open: () => set({ open: true }),
    close: () => { if (!busy) set({ open: false, dismissed: state.version }) },
    dismiss: () => set({ dismissed: state.version }),
    async initialize() {
      if (!state.supported) return
      try { set(await transport.invoke('desktop_update_status')) }
      catch { set({ supported: false }) }
    },
    check: () => run('checking', async () => {
      set({ ...await transport.invoke('desktop_update_check'), checked: true })
      if (state.automatic && state.version && !state.downloaded) await download()
    }),
    setAutomatic: enabled => run('saving', async () => {
      set({ automatic: enabled })
      set(await transport.invoke('desktop_update_automatic', { enabled }))
      if (enabled && state.version && !state.downloaded) await download()
    }),
    install: () => run('downloading', async () => {
      if (!state.version) throw new Error('Check for updates first.')
      await download()
      set({ phase: 'installing' })
      await transport.invoke('desktop_update_install', { version: state.version })
    }),
    restart: () => run('installing', () => transport.invoke('desktop_update_restart')),
  }
}

export const desktopUpdates = createUpdateController({
  supported: isTauri(),
  async invoke(command, args) { const { invoke } = await import('@tauri-apps/api/core'); return invoke(command, args) },
  async channel(onmessage) { const { Channel } = await import('@tauri-apps/api/core'); return new Channel(onmessage) },
})
