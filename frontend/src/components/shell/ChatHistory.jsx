import { useState } from 'react'
import { MessageSquare, MoreHorizontal, Archive } from 'lucide-react'
import useStore from '../../state/store'
import { recentSessions } from '../../lib/visibleSessions'
import { getSessionDisplayStatus, isShellSession } from '../../lib/sessionStatus'
import SessionContextMenu from './SessionContextMenu'

export default function ChatHistory({ filter = '', compact = false }) {
  const sessions = useStore(s => s.sessions)
  const activeId = useStore(s => s.showHome ? null : s.activeSessionId)
  const started = useStore(s => s.sessionStarted)
  const [archive, setArchive] = useState(false)
  const [limit, setLimit] = useState(compact ? 3 : 40)
  const [menu, setMenu] = useState(null)
  const query = filter.trim().toLowerCase()
  const rows = recentSessions(sessions, { limit: Infinity, includeArchived: archive, includeReadOnly: true })
    .filter(s => !isShellSession(s) && (!archive || s.archived))
    .filter(s => !query || `${s.name || ''} ${s.cli_type || ''} ${s.model || ''}`.toLowerCase().includes(query))
  return <section className={`ive-chat-history${compact ? ' is-compact' : ''}`} aria-label={archive ? 'Archived chats' : 'Recent chats'}>
    <div className="ive-chat-history-heading"><span>{archive ? 'Archived chats' : 'Recent chats'}</span>
      {!compact && <button type="button" aria-pressed={archive} title={archive ? 'Show recent chats' : 'Show archived chats'} aria-label={archive ? 'Show recent chats' : 'Show archived chats'} onClick={() => setArchive(v => !v)}><Archive size={14} /></button>}
    </div>
    {!rows.length && <p className="ive-chat-history-empty">{query ? 'No chats match this name or assistant.' : archive ? 'No archived chats.' : 'Your conversations will appear here.'}</p>}
    {rows.slice(0, limit).map(session => {
      const status = getSessionDisplayStatus(session, started)
      return <div key={session.id} className={`ive-chat-history-row${activeId === session.id ? ' is-active' : ''}`}>
        <button type="button" className="ive-chat-history-open" aria-current={activeId === session.id ? 'page' : undefined}
          onClick={() => useStore.getState().goSession(session.id, { autoStart: false })} title={session.name || 'Untitled chat'}>
          <MessageSquare size={14} aria-hidden="true" />
          <span><strong>{session.name || 'Untitled chat'}</strong><small>{session.cli_type === 'codex' ? 'Codex' : session.cli_type === 'claude' ? 'Claude' : session.cli_type} · {status.state === 'waiting' ? 'Needs your reply' : status.label}</small></span>
        </button>
        <button type="button" className="ive-chat-history-more" aria-label={`More actions for ${session.name || 'chat'}`} onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ session, x: r.right, y: r.bottom }) }}><MoreHorizontal size={15} /></button>
      </div>
    })}
    {rows.length > limit && !compact && <button type="button" className="ive-chat-history-load" onClick={() => setLimit(n => n + 40)}>Show more chats</button>}
    {menu && <SessionContextMenu x={menu.x} y={menu.y} session={menu.session} conversation onClose={() => setMenu(null)} />}
  </section>
}
