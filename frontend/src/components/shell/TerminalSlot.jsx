import { useLayoutEffect, useRef, useState } from 'react'
import { getTerminalPortalNode, getTerminalSlot, registerTerminalSlot } from '../../lib/terminalSlots'
import { terminalControls } from '../../lib/terminalWriters'
import useStore from '../../state/store'
import { TerminalContextNotice } from '../session/SessionContextNotice'

// Where a session's terminal shows: a board tile, the session drawer or the
// full view. The slot adopts the session's stable portal node (rendered by
// TerminalKeepAlive) and gives it back to the parking container on unmount,
// so the TerminalView itself never remounts. Exactly one slot per session.
//   mode: 'tile' | 'drawer' | 'full'
export default function TerminalSlot({ sessionId, mode = 'full', focusOnMount = false, className = '', style }) {
  const ref = useRef(null)
  const [tileVisible, setTileVisible] = useState(false)
  const active = useStore(state => state.activeSessionId === sessionId)
  // A user-selected tile must accept the very next key, before the async
  // intersection callback runs. Other offscreen tiles stay parked.
  const visible = mode !== 'tile' || tileVisible || (focusOnMount && active)

  // Offscreen tiles retain their session and terminal buffer in KeepAlive's
  // parking area. Only near-viewport tiles adopt the expensive live renderer.
  // Full views and drawers are immediate, including newly created sessions.
  useLayoutEffect(() => {
    if (mode !== 'tile') return undefined
    const el = ref.current
    if (!el) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setTileVisible(true)
      return undefined
    }
    setTileVisible(false)
    const observer = new IntersectionObserver(([entry]) => {
      setTileVisible(entry.isIntersecting)
    }, { root: el.closest('[data-terminal-grid]'), rootMargin: '160px', threshold: 0 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [sessionId, mode])

  useLayoutEffect(() => {
    if (!visible) return undefined
    const el = ref.current
    const node = getTerminalPortalNode(sessionId)
    if (!el || !node) return undefined
    if (node.parentElement !== el) el.appendChild(node)
    const unregister = registerTerminalSlot(sessionId, { el, mode })
    // Focus in the layout commit, before a fast follow-up Enter can arrive.
    // Background tiles must never take the keyboard from the selected session.
    const activeElement = document.activeElement
    const preserveControlFocus = mode === 'tile' && activeElement?.matches?.('button, a[href], select, input:not(.xterm-helper-textarea), textarea:not(.xterm-helper-textarea), [contenteditable="true"], [role="button"], [role="tab"]')
    // Filtering the Overview can re-adopt the selected terminal. Its mount
    // must not steal the next key from the filter, another composer or menu.
    if (focusOnMount && !preserveControlFocus && useStore.getState().activeSessionId === sessionId) {
      window.dispatchEvent(new Event('cc-focus-terminal'))
    }
    // One slot reveal must not schedule a refit for every open terminal.
    const frame = requestAnimationFrame(() => terminalControls.get(sessionId)?.refit?.())
    return () => {
      cancelAnimationFrame(frame)
      unregister()
      // Detach the node for the rest of this commit. React restores the focus
      // it saw before the mutation phase to any element still in the document;
      // a parked terminal that gets its focus back would re-activate its
      // session (Terminal.jsx focus handler) and undo the switch. The parking
      // container (TerminalKeepAlive, layout phase) adopts the node right
      // after, so the terminal keeps its scrollback and sends no resize.
      node.remove()
      queueMicrotask(() => {
        if (node.parentElement || getTerminalSlot(sessionId)) return
        document.querySelector('[data-terminal-parked]')?.appendChild(node)
      })
    }
  }, [sessionId, mode, focusOnMount, visible])

  return (
    <>
    {visible && mode !== 'drawer' && <TerminalContextNotice key={sessionId} sessionId={sessionId} />}
    <div
      ref={ref}
      data-terminal-slot={sessionId}
      data-terminal-mode={mode}
      data-terminal-visible={visible ? 'true' : 'false'}
      className={`ive-terminal-slot${className ? ` ${className}` : ''}`}
      style={style}
    />
    </>
  )
}
