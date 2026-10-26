import { useState } from 'react'
import { SquareTerminal, Loader2, Plus } from 'lucide-react'
import useStore from '../../state/store'
import { openNewTerminal } from '../../lib/shellSession'
import { formatKeyCombo } from '../../lib/keybindings'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'

export default function NewTerminalButton({ sidebar = false, compact = false }) {
  const t = useT()
  const key = useStore((s) => s.keybindings?.newTerminal)
  const [busy, setBusy] = useState(false)
  const label = t('nav.newTerminal')
  const Icon = busy ? Loader2 : compact ? Plus : SquareTerminal
  return (
    <button type="button" data-new-terminal-button data-chrome-button
      className={sidebar ? 'ive-sidebar-new-chat' : 'ive-header-btn ive-header-btn--new'}
      aria-label={label} title={`${label}${key ? ` (${formatKeyCombo(key)})` : ''}`}
      disabled={busy} onClick={async () => {
        setBusy(true)
        try { await openNewTerminal() } finally { setBusy(false) }
      }}>
      <Icon size={sidebar ? 16 : 15} aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
      {!compact && <span className={sidebar ? undefined : 'ive-header-btn-label'}>{label}</span>}
      {sidebar && key && <kbd className="ive-kbd">{formatKeyCombo(key)}</kbd>}
    </button>
  )
}
