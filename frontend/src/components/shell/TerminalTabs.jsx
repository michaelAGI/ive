import { useEffect, useRef } from 'react'
import { SquareTerminal, MessageSquare } from 'lucide-react'
import useStore from '../../state/store'
import { isShellSession } from '../../lib/sessionStatus'
import { formatKeyCombo, getTabSwitchCombo } from '../../lib/keybindings'
import SessionCloseButton from '../session/SessionCloseButton'
import NewTerminalButton from '../session/NewTerminalButton'
import '../session/sessionIdentity.css'
import './terminal-tabs.css'

export default function TerminalTabs() {
  const ids = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSessionId)
  const workspaces = useStore((s) => s.workspaces)
  const showHome = useStore((s) => s.showHome)
  const sessionFocus = useStore((s) => s.sessionFocus)
  const activeRef = useRef(null)
  const tabs = ids.map((id) => sessions[id]).filter((s) => s && !s.archived)
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [activeId, ids])
  if (!tabs.length) return null
  return (
    <div className="ive-terminal-tabs" data-terminal-tabs>
      <div className="ive-terminal-tabs-list" role="tablist" aria-label="Open terminals and sessions">
        {tabs.map((session, index) => {
          const selected = session.id === activeId && !showHome && sessionFocus
          const Icon = isShellSession(session) ? SquareTerminal : MessageSquare
          const project = workspaces.find((w) => w.id === session.workspace_id)
          const shortcut = index < 9 ? formatKeyCombo(getTabSwitchCombo(String(index + 1))) : ''
          return <div key={session.id} className={`ive-terminal-tab${selected ? ' is-active' : ''}`} role="presentation">
            <button type="button" role="tab" data-tab-id={session.id} data-chrome-button
              ref={session.id === activeId ? activeRef : null} aria-selected={selected}
              tabIndex={session.id === activeId || (!activeId && index === 0) ? 0 : -1}
              title={[session.name, project?.path, shortcut].filter(Boolean).join(' · ')}
              onClick={() => useStore.getState().goSession(session.id)}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey) return
                const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
                if (next === null) return
                event.preventDefault()
                useStore.getState().goSession(tabs[next].id)
              }}>
              <Icon size={14} aria-hidden="true" />
              <span>{session.name || (isShellSession(session) ? 'Terminal' : 'Session')}</span>
            </button>
            <SessionCloseButton sessionId={session.id} name={session.name} />
          </div>
        })}
      </div>
      <NewTerminalButton compact />
    </div>
  )
}
