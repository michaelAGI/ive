import { useEffect } from 'react'
import useStore, { attentionStamp } from '../state/store'
import { api, request } from '../lib/api'
import { detectTerminalAttention } from '../lib/sessionAttention'
import { staleSessionSnapshot } from '../lib/sessionSnapshots'

export default function useSessionAttention() {
  useEffect(() => {
    let stopped = false, timer, controller
    async function refresh() {
      controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12000)
      const versions = Object.fromEntries(Object.values(useStore.getState().sessions).map((s) => [s.id, attentionStamp(s)]))
      try {
        const sessions = await api.getSessions(undefined, { signal: controller.signal })
        if (stopped || !Array.isArray(sessions)) return
        // Status and attention describe the same backend snapshot. Apply them
        // together with the same race guards used at reconnect; polling only
        // attention used to leave missed lifecycle events stuck indefinitely.
        useStore.getState().resyncSessions(sessions, { knownSessionIdsAtRequest: Object.keys(versions) })
        // Older servers lack attention data: read their current terminal as a
        // compatibility fallback, without overriding newer state meanwhile.
        const queue = sessions.filter(session => !Object.hasOwn(session, 'attention'))
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length && !stopped) {
            const session = queue.shift()
            try {
              let attention = session.attention
              if (!Object.hasOwn(session, 'attention') && session.pty_alive && ['claude', 'codex'].includes(session.cli_type)) {
                const output = await request(`/sessions/${encodeURIComponent(session.id)}/output?lines=80`, { signal: controller.signal })
                attention = detectTerminalAttention(output.screen || output.text)
                // Old servers do not have a durable snapshot. Absence of a
                // terminal match cannot clear a structured hook request.
                if (!attention && useStore.getState().sessions[session.id]?.attention?.source !== 'terminal') continue
              }
              if (stopped || attention === undefined) continue
              const store = useStore.getState(), current = store.sessions[session.id]
              // Never let an HTTP response undo a newer WebSocket event.
              if (!current || staleSessionSnapshot(session) || attentionStamp(current) !== (versions[session.id] || '0:0')) continue
              if (attention?.source === 'terminal' && attention.context === current.resolvedAttentionContext) continue
              if (JSON.stringify(current.attention || null) !== JSON.stringify(attention || null)) store.setSessionAttention(session.id, attention || null)
            } catch { /* A single vanished session must not hide other requests. */ }
          }
        }))
      } catch { /* Connection status is already displayed by the app. */ }
      finally {
        clearTimeout(timeout)
        if (!stopped) timer = setTimeout(refresh, 5000)
      }
    }
    refresh()
    return () => { stopped = true; clearTimeout(timer); controller?.abort() }
  }, [])
}
