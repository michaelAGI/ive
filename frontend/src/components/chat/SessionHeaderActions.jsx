import { Activity, Clock, Hash, Info, Terminal } from 'lucide-react'
import HeaderPortal from '../shell/HeaderPortal'
import useStore from '../../state/store'
import { formatKeyCombo } from '../../lib/keybindings'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'

function compact(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

// Session-level switches in the app header (right side), so the conversation
// starts directly under the header like a chat app: the session overview,
// activity details, the history rail, token usage and the terminal drawer.
export default function SessionHeaderActions({
  showProcessing, onToggleProcessing,
  hasHistory, historyOpen, onToggleHistory,
  stats, briefOpen = false, onToggleBrief = null,
  isTerminalOpen, onToggleTerminal,
}) {
  const t = useT()
  const terminalKey = useStore((s) => s.keybindings?.toggleTerminal)
  const turns = stats ? (stats.turns === 1 ? t('header.turn') : t('header.turns', { n: stats.turns })) : ''
  const usage = stats ? t(stats.estimated ? 'header.usageEstimated' : 'header.usage', { tokens: compact(stats.tokens), turns }) : ''
  const combo = terminalKey ? formatKeyCombo(terminalKey) : '⌘J'
  return (
    <HeaderPortal slot="actions">
      <div className="ive-session-header-actions" data-session-header-actions="">
        {stats && stats.tokens > 0 && (
          <span className="ive-header-btn ive-header-usage" title={usage} data-session-usage="">
            <Hash size={14} aria-hidden="true" />
            <span className="ive-header-btn-label">{stats.estimated ? '~' : ''}{compact(stats.tokens)} · {turns}</span>
            <span className="sr-only">{usage}</span>
          </span>
        )}
        {onToggleBrief && (
          <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={briefOpen} onClick={onToggleBrief}
            title={t('header.overviewTitle')} aria-label={t('header.overview')}>
            <Info size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">{t('header.overview')}</span>
          </button>
        )}
        <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={showProcessing} onClick={onToggleProcessing}
          title={t('header.detailsTitle')} aria-label={t('header.details')}>
          <Activity size={15} aria-hidden="true" />
          <span className="ive-header-btn-label">{t('header.details')}</span>
        </button>
        {hasHistory && (
          <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={historyOpen} onClick={onToggleHistory}
            title={t('header.historyTitle')} aria-label={t('header.history')}>
            <Clock size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">{t('header.history')}</span>
          </button>
        )}
        {onToggleTerminal && (
          <button type="button" data-chrome-button className="ive-header-btn" aria-pressed={isTerminalOpen} onClick={onToggleTerminal}
            title={t('header.terminalToggle')} aria-label={`${t('header.terminal')} (${combo})`}>
            <Terminal size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">{t('header.terminal')}</span>
          </button>
        )}
      </div>
    </HeaderPortal>
  )
}
