import { useEffect, useRef, useState } from 'react'
import { SquareTerminal, MessageSquare } from 'lucide-react'
import useStore from '../../state/store'
import { isShellSession } from '../../lib/sessionStatus'
import { formatKeyCombo, getTabSwitchCombo } from '../../lib/keybindings'
import { getOpenTabIds } from '../../lib/sessionTabs'
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
  const listRef = useRef(null)
  const dragging = useRef(null)
  const dragFrame = useRef(null)
  const suppressClick = useRef(false)
  const [dragId, setDragId] = useState(null)
  const [drop, setDrop] = useState(null)
  const tabs = getOpenTabIds({ openTabs: ids, sessions }).map((id) => sessions[id])
  const moveTab = (fromId, toId, position) => useStore.getState().moveTab(fromId, toId, position)
  const finishDrag = () => {
    const drag = dragging.current
    dragging.current = null
    cancelAnimationFrame(dragFrame.current)
    if (drag?.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
    setDragId(null)
    setDrop(null)
  }
  const targetAt = (x, y) => {
    const list = listRef.current
    const hit = document.elementFromPoint(x, y)
    if (!list?.contains(hit)) return null
    const tab = hit.closest('.ive-terminal-tab')
    if (!tab) {
      const last = list.querySelector('.ive-terminal-tab:last-child [data-tab-id]')
      return last ? { id: last.dataset.tabId, position: 'after' } : null
    }
    const rect = tab.getBoundingClientRect()
    return { id: tab.querySelector('[data-tab-id]').dataset.tabId, position: x < rect.left + rect.width / 2 ? 'before' : 'after' }
  }
  const trackDrag = () => {
    const drag = dragging.current
    const list = listRef.current
    if (!drag?.active || !list) return
    const rect = list.getBoundingClientRect()
    if (drag.y >= rect.top && drag.y <= rect.bottom) {
      if (drag.x >= rect.left && drag.x < rect.left + 28) list.scrollLeft -= 12
      else if (drag.x <= rect.right && drag.x > rect.right - 28) list.scrollLeft += 12
    }
    const target = targetAt(drag.x, drag.y)
    setDrop((previous) => previous?.id === target?.id && previous?.position === target?.position ? previous : target)
    dragFrame.current = requestAnimationFrame(trackDrag)
  }
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [activeId, ids])
  useEffect(() => {
    const id = dragging.current?.id
    if (id && (!ids.includes(id) || !sessions[id] || sessions[id].archived)) finishDrag()
  }, [ids, sessions])
  useEffect(() => () => { cancelAnimationFrame(dragFrame.current); dragging.current = null }, [])
  if (!tabs.length) return null
  // One open chat is the common case: the conversation starts right under the
  // header, like a chat app. The bar appears for terminals and once a second
  // tab is open (the sidebar and Command-1..9 still switch sessions).
  if (tabs.length < 2 && !tabs.some(isShellSession)) return null
  return (
    <div className="ive-terminal-tabs" data-terminal-tabs>
      <div ref={listRef} className="ive-terminal-tabs-list" role="tablist" aria-label="Open terminals and sessions">
        {tabs.map((session, index) => {
          const selected = session.id === activeId && !showHome && sessionFocus
          const Icon = isShellSession(session) ? SquareTerminal : MessageSquare
          const project = workspaces.find((w) => w.id === session.workspace_id)
          const shortcut = index < 9 ? formatKeyCombo(getTabSwitchCombo(String(index + 1))) : ''
          const combo = index < 9 ? getTabSwitchCombo(String(index + 1)) : null
          return <div key={session.id}
            className={`ive-terminal-tab${selected ? ' is-active' : ''}${dragId === session.id ? ' is-dragging' : ''}${drop?.id === session.id && dragId !== session.id ? ` is-drop-${drop.position}` : ''}`}
            role="presentation">
            <button type="button" role="tab" data-tab-id={session.id} data-chrome-button
              ref={session.id === activeId ? activeRef : null} aria-selected={selected}
              aria-keyshortcuts={combo ? `${combo.ctrl ? 'Control' : 'Meta'}+${index + 1}` : undefined}
              tabIndex={session.id === activeId || (!activeId && index === 0) ? 0 : -1}
              title={[session.name, project?.path, shortcut, 'Drag to reorder (or Alt+Shift+Left/Right)'].filter(Boolean).join(' · ')}
              // Pointer dragging also works in the desktop app, whose native
              // Finder-file handler consumes HTML5 drag/drop events.
              draggable={false}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                suppressClick.current = false
                dragging.current = { id: session.id, pointerId: event.pointerId, element: event.currentTarget,
                  startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const drag = dragging.current
                if (!drag || drag.pointerId !== event.pointerId) return
                drag.x = event.clientX; drag.y = event.clientY
                if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
                  drag.active = true
                  suppressClick.current = true
                  setDragId(drag.id)
                  trackDrag()
                }
                if (drag.active) event.preventDefault()
              }}
              onPointerUp={(event) => {
                const drag = dragging.current
                if (!drag || drag.pointerId !== event.pointerId) return
                if (drag.active) {
                  event.preventDefault()
                  const target = targetAt(event.clientX, event.clientY)
                  if (target) moveTab(drag.id, target.id, target.position)
                }
                finishDrag()
              }}
              onPointerCancel={finishDrag}
              onLostPointerCapture={() => { if (dragging.current) finishDrag() }}
              onClick={(event) => {
                if (suppressClick.current && event.detail !== 0) {
                  suppressClick.current = false
                  event.preventDefault()
                  return
                }
                useStore.getState().goSession(session.id)
              }}
              onKeyDown={(event) => {
                if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey
                    && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                  event.preventDefault()
                  event.stopPropagation()
                  const neighbor = tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)]
                  if (neighbor) moveTab(session.id, neighbor.id, event.key === 'ArrowLeft' ? 'before' : 'after')
                  return
                }
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
              {shortcut && <kbd className="ive-terminal-tab-shortcut" aria-hidden="true">{shortcut}</kbd>}
            </button>
            <SessionCloseButton sessionId={session.id} name={session.name} />
          </div>
        })}
      </div>
      <NewTerminalButton compact />
    </div>
  )
}
