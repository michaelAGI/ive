import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X, Pencil, Copy, CopyPlus, ClipboardCopy, Download, Trash2, Sparkles, FileText, Square, ExternalLink, Archive, ArchiveRestore } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { closeSession, deleteSessionWithConfirm } from '../../lib/sessionActions'
import { requestSessionRename } from '../../lib/sessionRename'
import useEscapeToClose from '../../hooks/useEscapeToClose'

// The session menu, in one place: the project tree (right-click or "…"),
// board tiles and cards (useSessionChipMenu). Open, Rename, Clone, Learn
// from this, Copy output / last message, Export, Summary, Close / Restore,
// Stop, Delete.

// Keeps the menu on screen. offsetWidth/Height ignore the entrance scale, so
// the clamp holds while the menu is still animating in. The menu grows out of
// the corner that touches its anchor, also after it flipped up or left.
function clampTo(x, y, menuEl) {
  const pos = { left: x, top: y, transformOrigin: '0 0' }
  if (!menuEl) return pos
  const { offsetWidth: width, offsetHeight: height } = menuEl
  if (y + height > window.innerHeight) pos.top = Math.max(4, window.innerHeight - height - 8)
  if (x + width > window.innerWidth) pos.left = Math.max(4, window.innerWidth - width - 8)
  pos.transformOrigin = `${pos.left < x ? '100%' : '0'} ${pos.top < y ? '100%' : '0'}`
  return pos
}

// Closing fades the menu out first; the owner unmounts it when that animation
// ends (or after a short fallback, should it never run). Every close path —
// item, Escape, outside click — goes through `close`.
function useDeferredClose(onClose) {
  const [closing, setClosing] = useState(false)
  const latest = useRef(onClose)
  useEffect(() => { latest.current = onClose }, [onClose])
  const timer = useRef(null)
  const finish = useCallback(() => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    latest.current?.()
  }, [])
  const close = useCallback(() => {
    if (timer.current) return
    setClosing(true)
    timer.current = setTimeout(finish, 240)
  }, [finish])
  useEffect(() => () => clearTimeout(timer.current), [])
  return { closing, close, finish }
}

function MenuShell({ x, y, menu, children, summary }) {
  const menuRef = useRef(null)
  const [pos, setPos] = useState(() => clampTo(x, y, null))
  const { closing, close, finish } = menu

  useEffect(() => {
    const clickHandler = () => close()
    // React flushes this effect while the click that opened the menu is
    // still bubbling towards the window; listening from the next task keeps
    // that click from closing the menu it just opened.
    const timer = setTimeout(() => window.addEventListener('click', clickHandler), 0)
    return () => { clearTimeout(timer); window.removeEventListener('click', clickHandler) }
  }, [close])
  useEscapeToClose(true, close)
  useLayoutEffect(() => { setPos(clampTo(x, y, menuRef.current)) }, [x, y])

  return (
    <div
      ref={menuRef}
      role="menu"
      data-session-menu=""
      data-ive-popover=""
      className={`ive-session-context-menu x-panel scale-in${closing ? ' is-closing' : ''}`}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) finish() }}
    >
      {summary && <div className="ive-session-context-summary">{summary}</div>}
      {children}
    </div>
  )
}

function MenuItems({ items }) {
  return items.map((item, i) => item === null
    ? <div key={`sep-${i}`} className="ive-session-context-sep" />
    : (
      <button key={item.label} type="button" role="menuitem" onClick={item.action} className={`ive-session-context-item${item.danger ? ' is-danger' : ''}`}>
        <item.icon size={12} aria-hidden="true" />
        {item.label}
      </button>
    ))
}

// Full menu of the project tree.
export default function SessionContextMenu({ x, y, session, onClose, onOpenSummary, conversation = false }) {
  const menu = useDeferredClose(onClose)
  const { close } = menu
  const handleRename = () => { close(); requestSessionRename(session.id) }
  const handleCopyOutput = async () => {
    try {
      const data = await api.getSessionOutput(session.id, 200)
      await navigator.clipboard.writeText(data.output || data.text || '')
    } catch { /* silent */ }
    close()
  }
  const handleCopyMessages = async () => {
    try {
      const msgs = await api.getMessages(session.id)
      if (msgs.length > 0) await navigator.clipboard.writeText(msgs[msgs.length - 1].content || '')
    } catch { /* silent */ }
    close()
  }
  const handleStop = () => { useStore.getState().stopSession(session.id); close() }
  const handleOpen = () => { useStore.getState().goSession(session.id, { autoStart: !conversation }); close() }
  const handleExport = () => { window.open(`/api/sessions/${session.id}/export`, '_blank'); close() }
  const handleDelete = async () => { close(); await deleteSessionWithConfirm(session.id) }
  const handleArchive = async () => {
    close()
    if (!session.archived) { await closeSession(session.id); return }
    try {
      await api.updateSession(session.id, { archived: 0 })
      useStore.getState().setSessionArchived(session.id, 0)
      useStore.getState().openSession(session.id, { autoStart: !conversation })
    } catch (err) {
      useStore.getState().addNotification({ type: 'warning', message: `Could not restore "${session.name}": ${err?.message || 'unknown error'}` })
    }
  }
  const handleOpenSummary = () => { onOpenSummary?.(session); close() }
  const handleClone = async () => {
    try {
      const cloned = await api.cloneSession(session.id)
      if (cloned?.id) {
        useStore.getState().loadSessions([cloned])
        useStore.getState().openSession(cloned.id)
      }
    } catch { /* silent */ }
    close()
  }
  const handleLearn = () => { close(); learnFrom(session) }

  const isRunning = session.status === 'running'
  const items = [
    { icon: ExternalLink, label: 'Open', action: handleOpen },
    { icon: Pencil, label: 'Rename', action: handleRename },
    ...(!conversation ? [{ icon: CopyPlus, label: 'Clone', action: handleClone },
    { icon: Sparkles, label: 'Learn from this', action: handleLearn }] : []),
    null,
    ...(!conversation ? [{ icon: ClipboardCopy, label: 'Copy output', action: handleCopyOutput }] : []),
    { icon: Copy, label: 'Copy last message', action: handleCopyMessages },
    { icon: Download, label: 'Export', action: handleExport },
    null,
    ...(onOpenSummary ? [{ icon: FileText, label: 'Summary', action: handleOpenSummary }] : []),
    { icon: session.archived ? ArchiveRestore : Archive, label: session.archived ? (conversation ? 'Restore chat' : 'Restore session') : conversation ? 'Archive chat' : 'Close session', action: handleArchive },
    null,
    ...(isRunning ? [{ icon: Square, label: 'Stop', action: handleStop }] : []),
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return <MenuShell x={x} y={y} menu={menu} summary={session.summary}><MenuItems items={items} /></MenuShell>
}

async function learnFrom(session) {
  try {
    const model = session.model ? `${session.cli_type || 'claude'}:${session.model}` : undefined
    const res = await api.distillSession(session.id, { type: 'guideline', model })
    if (res.error) useStore.getState().addNotification({ type: 'warning', message: `Could not learn from "${session.name}": ${res.error}` })
    else useStore.getState().addNotification({ type: 'info', message: `Learning from "${session.name}" in background...` })
  } catch (e) {
    useStore.getState().addNotification({ type: 'warning', message: `Could not learn from "${session.name}": ${e.message || 'unknown error'}` })
  }
}

// Short menu of tiles and chips (formerly SessionTabs.ContextMenu).
export function ContextMenu({ x, y, session, onClose }) {
  const menu = useDeferredClose(onClose)
  const { close } = menu
  const handleRename = () => { close(); requestSessionRename(session.id) }
  const handleClone = async () => {
    const cloned = await api.cloneSession(session.id)
    useStore.getState().addSession(cloned)
    close()
  }
  const handleExport = () => { window.open(`/api/sessions/${session.id}/export`, '_blank'); close() }
  const handleDelete = async () => { close(); await deleteSessionWithConfirm(session.id) }
  const handleLearn = () => { close(); learnFrom(session) }

  const items = [
    { icon: Pencil, label: 'Rename', action: handleRename },
    { icon: Copy, label: 'Clone', action: handleClone },
    { icon: Sparkles, label: 'Learn from this', action: handleLearn },
    { icon: Download, label: 'Export', action: handleExport },
    { icon: X, label: 'Close session', action: () => { close(); closeSession(session.id) } },
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return <MenuShell x={x} y={y} menu={menu}><MenuItems items={items} /></MenuShell>
}
