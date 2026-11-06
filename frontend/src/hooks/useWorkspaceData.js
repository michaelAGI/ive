import { useEffect } from 'react'
import { api } from '../lib/api'
import useStore from '../state/store'

// The initial workspace/session snapshot belongs to the shared shell. Chat
// history must load even when the Dev project tree is never mounted. Reading
// these records does not open tabs or start any saved worker.
export default function useWorkspaceData() {
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const workspaces = await api.getWorkspaces()
        if (cancelled) return
        useStore.getState().setWorkspaces(workspaces)
        if (workspaces.length && !useStore.getState().activeWorkspaceId) {
          useStore.getState().setActiveWorkspace(workspaces[0].id)
        }
        const lists = await Promise.all(workspaces.map(ws => api.getSessions(ws.id).catch(() => [])))
        if (cancelled) return
        for (const sessions of lists) useStore.getState().loadSessions(sessions)
        const tasks = await api.getTasks()
        if (cancelled) return
        if (Array.isArray(tasks)) useStore.getState().loadTasks(tasks)
        const store = useStore.getState()
        store.loadGridTemplates()
        store.loadTabGroups()
        store.loadPrompts()
        store.loadCascades()
        api.getCliFeatures().then(data => {
          if (!cancelled && data?.profiles) useStore.getState().loadCliProfiles(data.profiles)
        }).catch(() => {})
      } catch (error) {
        console.error('Failed to load workspace data:', error)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])
}
