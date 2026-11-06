import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import useStore from '../../state/store'
import TerminalView from '../chat/Terminal'
import { getTerminalPortalNode, getTerminalSlot, releaseTerminalPortalNode, subscribeTerminalSlots } from '../../lib/terminalSlots'
import { pendingPtyStarts, startedSessions } from '../../lib/terminalWriters'

// One stable TerminalView for each live or previously displayed open session.
// Stopped sessions need no renderer until their first visible slot, so opening
// a large saved history does not eagerly construct hundreds of xterms.
// A <TerminalSlot> (tile, drawer, full view) adopts the node;
// nodes nobody shows wait in the parking container below, 1×1 px and
// invisible, where Terminal.jsx sends no resize (fitLayout stops < 20 px).
// Desktop only; the phone keeps rendering TerminalView directly (App.jsx).
let slotVersion = 0
const subscribe = (fn) => subscribeTerminalSlots(() => { slotVersion += 1; fn() })
const getSlotVersion = () => slotVersion

export default function TerminalKeepAlive() {
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  useSyncExternalStore(subscribe, getSlotVersion, getSlotVersion)
  const parkedRef = useRef(null)
  const previousIds = useRef([])
  const initializedIds = useRef(new Set())

  const openIds = openTabs.filter((id) => !!sessions[id])
  const ids = openIds.filter((id) => (
    initializedIds.current.has(id) || getTerminalSlot(id)
    // Be conservative for older/partial session snapshots: only an explicit
    // stopped PTY can be deferred. Live attachment/replay stays unchanged.
    || sessions[id].pty_alive !== false || sessionStarted[id]
    || startedSessions.has(id) || pendingPtyStarts.has(id)
  ))

  // Park every node without a slot before the terminals' own effects open
  // xterm in it (layout effects of this parent run after the children's
  // layout effects, but before any passive effect).
  useLayoutEffect(() => {
    const parked = parkedRef.current
    for (const id of ids) {
      initializedIds.current.add(id)
      const node = getTerminalPortalNode(id)
      if (!node || getTerminalSlot(id)) continue
      if (parked && node.parentElement !== parked) parked.appendChild(node)
    }
    // Closed tabs: React has unmounted the portal children already; drop the node.
    const stillOpen = new Set(openIds)
    for (const id of previousIds.current) {
      if (!stillOpen.has(id)) {
        initializedIds.current.delete(id)
        releaseTerminalPortalNode(id)
      }
    }
    previousIds.current = openIds
  })

  return (
    <>
      <div
        data-terminal-parked=""
        ref={parkedRef}
        aria-hidden="true"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
      />
      {ids.map((id) => {
        const node = getTerminalPortalNode(id)
        if (!node) return null
        const mode = getTerminalSlot(id)?.mode || null
        return createPortal(
          <TerminalView key={id} sessionId={id} slotMode={mode} overviewPreview={mode === 'tile'} inDrawer={mode === 'drawer'} />,
          node,
          id,
        )
      })}
    </>
  )
}
