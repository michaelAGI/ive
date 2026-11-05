import { Activity, Clock, Hash, Info, Terminal } from 'lucide-react'
import HeaderPortal from '../shell/HeaderPortal'
import useStore from '../../state/store'
import { formatKeyCombo } from '../../lib/keybindings'

function compact(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

// Session-level switches in the app header (right side), so the conversation
// starts directly under the header like a chat app: activity details, the
// history rail, token usage and the terminal drawer.
export default function SessionHeaderActions({
  showProcessing, onToggleProcessing,
  hasHistory, historyOpen, onToggleHistory,
  stats, briefOpen = false, onToggleBrief = null,
  isTerminalOpen, onToggleTerminal,
}) {
  const terminalKey = useStore((s) => s.keybindings?.toggleTerminal)
  const usageTitle = stats
    ? stats.estimated
      ? `About ${compact(stats.tokens)} tokens (estimated from the visible text) · ${stats.turns} ${stats.turns === 1 ? 'turn' : 'turns'}`
      : `${compact(stats.tokens)} tokens${stats.cachedTokens > 0 ? ` + ${compact(stats.cachedTokens)} cached` : ''} · ${stats.turns} ${stats.turns === 1 ? 'turn' : 'turns'}`
    : ''
  return (
    <HeaderPortal slot="actions">
      <div className="ive-session-header-actions" data-session-header-actions="">
        {stats && stats.tokens > 0 && (
          <span className="ive-header-btn ive-header-usage" title={usageTitle} aria-label={usageTitle}>
            <Hash size={14} aria-hidden="true" />
            <span className="ive-header-btn-label">{stats.estimated ? '~' : ''}{compact(stats.tokens)}</span>
          </span>
        )}
        {onToggleBrief && (
          <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={briefOpen} onClick={onToggleBrief}
            title="Session overview: status, latest reply, changed files, checks" aria-label="Session overview">
            <Info size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">Overview</span>
          </button>
        )}
        <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={showProcessing} onClick={onToggleProcessing}
          title="Show every step the agent takes (tools, results)" aria-label="Show activity details">
          <Activity size={15} aria-hidden="true" />
          <span className="ive-header-btn-label">Details</span>
        </button>
        {hasHistory && (
          <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={historyOpen} onClick={onToggleHistory}
            title="Jump through this conversation" aria-label="History">
            <Clock size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">History</span>
          </button>
        )}
        {onToggleTerminal && (
          <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={isTerminalOpen} onClick={onToggleTerminal}
            title={`Terminal${terminalKey ? ` (${formatKeyCombo(terminalKey)})` : ' (⌘J)'}`} aria-label="Terminal">
            <Terminal size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">Terminal</span>
          </button>
        )}
      </div>
    </HeaderPortal>
  )
}
