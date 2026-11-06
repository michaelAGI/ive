import { useEffect, useRef } from 'react'
import { PanelLeftOpen } from 'lucide-react'
import useStore from '../../state/store'
import { formatKeyCombo } from '../../lib/keybindings'
import './sidebar-toggle.css'

// The open sidebar carries its own "Hide sidebar" button in its head, so the
// app bar shows nothing while navigation is visible. Once it is hidden, this
// recovery control appears in its place; it stays mounted across Home and
// sessions and shares the store field with the configurable keyboard shortcut.
export default function SidebarToggle() {
  const visible = useStore((state) => state.sidebarVisible)
  const binding = useStore((state) => state.keybindings.sidebar)
  const button = useRef(null)
  const wasVisible = useRef(visible)

  useEffect(() => {
    // Hiding with the shortcut while a sidebar field is focused removes that
    // field. Give focus an accessible destination, without stealing it from
    // a surviving editor or chat input.
    if (wasVisible.current && !visible && document.activeElement === document.body) button.current?.focus()
    wasVisible.current = visible
  }, [visible])

  if (visible) return null
  const label = 'Show sidebar'
  return (
    <div className="ive-sidebar-toggle-slot">
      <button ref={button} type="button" className="ive-sidebar-toggle" data-sidebar-toggle data-chrome-button
        aria-label={label} aria-expanded={false}
        title={`${label}${binding ? ` (${formatKeyCombo(binding)})` : ''}`}
        onClick={() => useStore.setState({ sidebarVisible: true })}>
        <PanelLeftOpen size={18} aria-hidden="true" />
        <span>Sidebar</span>
      </button>
    </div>
  )
}
