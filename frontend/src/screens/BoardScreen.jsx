import { useState } from 'react'
import useStore from '../state/store'
import HeaderPortal from '../components/shell/HeaderPortal'
import SessionGrid from '../components/overview/SessionGrid'
import GridToolbar from '../components/overview/GridToolbar'
import LiveActivity from '../components/overview/LiveActivity'

// A live activity lane separates active turns from merely open terminals.
// Filters change only the tiles shown, never the session's running state.
export default function BoardScreen({ onOpenSession, onOpenPanel }) {
  const overviewMode = useStore((s) => s.overviewMode)
  const [activityFilter, setActivityFilter] = useState('all')
  void onOpenSession
  void onOpenPanel
  return (
    <div className="ive-board-screen flex-1 flex flex-col min-h-0 min-w-0 relative" data-board-screen="" data-overview-mode={overviewMode}>
      <HeaderPortal slot="actions"><GridToolbar /></HeaderPortal>
      <LiveActivity filter={activityFilter} onFilterChange={setActivityFilter} />
      <SessionGrid activityFilter={activityFilter} onClearFilter={() => setActivityFilter('all')} />
    </div>
  )
}
