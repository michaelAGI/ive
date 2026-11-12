import { WifiOff } from 'lucide-react'
import useStore from '../../state/store'
import { ACTIVITY_FILTERS, activityCounts } from '../../lib/liveActivity'
import './live-activity.css'

// One slim row above the tiles: how many open sessions are working, need you
// or are done, and at the same time the filter for each. Its height is fixed
// and independent of the counts, because the terminals below re-fit on every
// change of the space above them.
export default function LiveActivity({ filter, onFilterChange }) {
  const sessions = useStore((s) => s.sessions)
  const openTabs = useStore((s) => s.openTabs)
  const workspaces = useStore((s) => s.workspaces)
  const tabScope = useStore((s) => s.tabScope)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const connected = useStore((s) => s.connected)
  const synced = useStore((s) => s.sessionStateSynced)
  const live = connected && synced

  const counts = activityCounts(openTabs, sessions, { tabScope, activeWorkspaceId }, sessionStarted)
  const scopeName = tabScope === 'workspace' && activeWorkspaceId
    ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name || 'This project'
    : 'All projects'
  const offline = live ? '' : connected ? 'Refreshing session state…' : 'Connection lost. Counts may have changed.'

  return (
    <section className="ive-overview-activity ive-status-row" aria-label="Open sessions by state" data-overview-activity="" data-live={live ? 'true' : 'false'}>
      <div className="ive-status-filters" role="group" aria-label="Filter open sessions">
        {ACTIVITY_FILTERS.map(({ value, label }) => (
          <button
            type="button"
            key={value}
            data-activity-filter={value}
            data-count={counts[value]}
            aria-pressed={filter === value}
            aria-label={`${label}: ${counts[value]} ${counts[value] === 1 ? 'session' : 'sessions'}`}
            // A second click on the pressed state shows everything again.
            onClick={() => onFilterChange(filter === value ? 'all' : value)}
          >
            {value !== 'all' && <i aria-hidden="true" />}
            <span>{label}</span>
            <b>{counts[value]}</b>
          </button>
        ))}
      </div>
      {/* Always mounted, so a screen reader announces the text when it appears. */}
      <span className="ive-status-offline" role="status" title={offline || undefined}>
        {offline && <><WifiOff size={13} aria-hidden="true" /><span>{offline}</span></>}
      </span>
      <span className="ive-status-scope" data-activity-scope="" title={scopeName}>{scopeName}</span>
    </section>
  )
}
