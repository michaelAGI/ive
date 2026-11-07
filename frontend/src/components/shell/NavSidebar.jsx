import { visibleSessions } from '../../lib/visibleSessions'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Command, Plus, SquarePen, Search, X, House, Columns3, GitCompareArrows, BookOpen, Settings, Plug, Smartphone, PanelLeftClose } from 'lucide-react'
import useStore from '../../state/store'
import { requestTerminalRefit, slideSidebar } from '../../lib/sidebarMotion'
import useView from '../../hooks/useView'
import { selectCounts } from '../../state/selectors'
import { isSurfaceAvailable } from '../../lib/extensionRegistry'
import Sidebar from '../layout/Sidebar'
import NewTerminalButton from '../session/NewTerminalButton'
import { formatKeyCombo } from '../../lib/keybindings'
import SidebarFoot from './SidebarFoot'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'
import markLight from '../../assets/ive-mark-light.svg'
import markDark from '../../assets/ive-mark-dark.svg'
import useExperienceMode from '../../state/experienceMode'
import ChatHistory from './ChatHistory'

// The sidebar: brand, filter, Work (Home · Overview · Changes · Knowledge), the
// project tree, Set up (Settings · Connectors · Phone), the foot and, on the
// desktop, the drag handle on its right edge. Helper sessions (Commander,
// Brainstormer) never appear here.
function NavItem({ id, icon: Icon, label, current, onClick, children, title }) {
  return (
    <button
      type="button"
      data-nav={id}
      data-chrome-button
      className="ive-nav-item"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      title={title || label}
    >
      <Icon size={15} aria-hidden="true" />
      <span className="ive-nav-label">{label}</span>
      {children}
    </button>
  )
}

// ── Sidebar width ───────────────────────────────────────────────────────────
// The right edge drags like a Finder sidebar. The width is the CSS variable
// `--ive-sidebar-w` on the <aside>: while dragging it is written straight to
// the element (no React render per frame) and committed to state and
// localStorage on release. Terminals re-fit through `cc-terminal-refit`, the
// event the drawer and the grid already use.
export const SIDEBAR_WIDTH_KEY = 'ive.sidebar-width.v1'
export const SIDEBAR_WIDTH = Object.freeze({ min: 200, max: 440, default: 240, step: 16 })

export function clampSidebarWidth(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH.default
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, n))
}

function readSidebarWidth() {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    return raw === null ? SIDEBAR_WIDTH.default : clampSidebarWidth(raw)
  } catch { return SIDEBAR_WIDTH.default }
}

function writeSidebarWidth(width) {
  try {
    if (width === SIDEBAR_WIDTH.default) localStorage.removeItem(SIDEBAR_WIDTH_KEY)
    else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
  } catch { /* privacy mode */ }
}

// Dragging the edge this far below the minimum width closes the sidebar, the
// way a Finder or Mail sidebar snaps shut; dragging back out reopens it.
const COLLAPSE_AT = SIDEBAR_WIDTH.min - 72

const RESIZE_KEYS = { ArrowLeft: -SIDEBAR_WIDTH.step, ArrowRight: SIDEBAR_WIDTH.step }

function SidebarResizeHandle() {
  const [width, setWidth] = useState(readSidebarWidth)
  const [dragging, setDragging] = useState(false)
  const handleRef = useRef(null)
  const drag = useRef(null)

  // The handle sits inside the <aside>; its own ref is attached before this
  // layout effect runs, so the width is on screen with the first paint.
  const apply = useCallback((next) => {
    const handle = handleRef.current
    handle?.closest('.x-sidebar')?.style.setProperty('--ive-sidebar-w', `${next}px`)
    handle?.setAttribute('aria-valuenow', String(next))
  }, [])
  useLayoutEffect(() => { apply(width) }, [apply, width])

  const commit = useCallback((value) => {
    const next = clampSidebarWidth(value)
    apply(next)
    setWidth(next)
    writeSidebarWidth(next)
    requestTerminalRefit()
  }, [apply])

  const endDrag = (event) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    drag.current = null
    document.body.classList.remove('ive-sidebar-resizing', 'ive-sidebar-collapsing')
    setDragging(false)
    try { if (event.currentTarget.hasPointerCapture(d.pointerId)) event.currentTarget.releasePointerCapture(d.pointerId) } catch { /* already released */ }
    if (d.collapsed) {
      // Already slid out: mark it so the shell unmounts it without a second
      // animation, keep the stored width for the next time it opens.
      const aside = handleRef.current?.closest('.x-sidebar')
      if (aside) aside.dataset.collapsedByDrag = '1'
      useStore.setState({ sidebarVisible: false })
      requestTerminalRefit()
      return
    }
    d.slide?.cancel()
    handleRef.current?.closest('.x-sidebar')?.style.removeProperty('margin-left')
    commit(d.width)
  }

  const preview = (d, collapsed) => {
    d.collapsed = collapsed
    d.slide?.cancel()
    const aside = handleRef.current?.closest('.x-sidebar')
    if (!collapsed) aside?.style.removeProperty('margin-left')
    d.slide = slideSidebar(aside, { hidden: collapsed, duration: 180 })
    document.body.classList.toggle('ive-sidebar-collapsing', collapsed)
  }

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize. Drag to the left to close the sidebar. Double-click resets the width."
      aria-controls="ive-project-sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      data-sidebar-resize=""
      className={`ive-sidebar-resize${dragging ? ' is-dragging' : ''}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return
        drag.current = { pointerId: event.pointerId, x: event.clientX, start: width, width, collapsed: false, slide: null }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* moves still arrive while over the handle */ }
        document.body.classList.add('ive-sidebar-resizing')
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const d = drag.current
        if (!d || event.pointerId !== d.pointerId) return
        const raw = d.start + event.clientX - d.x
        if (raw < COLLAPSE_AT) { if (!d.collapsed) preview(d, true); return }
        if (d.collapsed) preview(d, false)
        const next = clampSidebarWidth(raw)
        if (next === d.width) return
        d.width = next
        apply(next)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => commit(SIDEBAR_WIDTH.default)}
      onKeyDown={(event) => {
        if (Object.hasOwn(RESIZE_KEYS, event.key)) { event.preventDefault(); commit(width + RESIZE_KEYS[event.key]) }
        else if (event.key === 'Home') { event.preventDefault(); commit(SIDEBAR_WIDTH.min) }
        else if (event.key === 'End') { event.preventDefault(); commit(SIDEBAR_WIDTH.max) }
      }}
    />
  )
}

export default function NavSidebar({
  onOpenPanel, onNewSession, onGoHome, onGoBoard, onOpenAttention, onOpenReview, onOpenKnowledge,
  activeOverlay = null, attentionCount = 0, catchUp = null,
  onHideSidebar, isMobile = false,
}) {
  const t = useT()
  const mode = useExperienceMode(s => s.mode)
  const view = useView()
  const newSessionKey = useStore((s) => s.keybindings?.newSession)
  const sidebarKey = useStore((s) => s.keybindings?.sidebar)
  const counts = useStore(selectCounts)
  const sessions = useStore(s=>s.sessions)
  const waitingSessions = visibleSessions(sessions).filter(sessionNeedsAttention)
  const [filter, setFilter] = useState('')
  const filterRef = useRef(null)
  const waiting = waitingSessions.length + (attentionCount || 0)

  return (
    <aside id="ive-project-sidebar" aria-label="Projects and sessions" className="x-sidebar">
      <div className="ive-sidebar-head">
        <div className="ive-sidebar-brand">
          <img src={markLight} alt="" className="ive-brand-mark ive-brand-mark--light" width="20" height="20" aria-hidden="true" />
          <img src={markDark} alt="" className="ive-brand-mark ive-brand-mark--dark" width="20" height="20" aria-hidden="true" />
          <span className="ive-brand-name">IVE</span>
        </div>
        <div className="ive-sidebar-head-actions">
          <button type="button" data-sidebar-dismiss className="ive-sidebar-icon-btn"
            aria-label={isMobile ? 'Close sidebar' : 'Hide sidebar'}
            aria-controls="ive-project-sidebar"
            title={isMobile ? 'Close sidebar' : `Hide sidebar${sidebarKey ? ` (${formatKeyCombo(sidebarKey)})` : ''}`} onClick={onHideSidebar}>
            {isMobile ? <X size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
          </button>
          <button
            type="button"
            data-chrome-button
            className="ive-sidebar-icon-btn"
            aria-label={t('nav.searchCommands')}
            title={`${t('nav.searchCommands')} (⌘K)`}
            onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          >
            <Command size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {mode === 'dev' && <NewTerminalButton sidebar />}
      <button type="button" data-sidebar-new-chat className="ive-sidebar-new-chat" onClick={onNewSession}>
        <SquarePen size={16} aria-hidden="true" /><span>{mode === 'chat' ? 'New chat' : t('nav.newSession')}</span>{newSessionKey && <kbd className="ive-kbd">{formatKeyCombo(newSessionKey)}</kbd>}
      </button>

      <div className="ive-sidebar-filter">
        <Search size={14} aria-hidden="true" className="ive-sidebar-filter-icon" />
        <input
          ref={filterRef}
          type="search"
          aria-label={mode === 'chat' ? 'Filter chats by name or assistant' : 'Filter sessions by name or model'}
          value={filter}
          placeholder={t('nav.search')}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) { e.preventDefault(); e.stopPropagation(); setFilter(''); return }
            if (e.key === 'Enter' && !filter.trim()) { e.preventDefault(); window.dispatchEvent(new CustomEvent('open-command-palette')) }
          }}
        />
        {filter ? (
          <button type="button" className="ive-sidebar-filter-clear" aria-label="Clear session filter" title="Clear filter (Esc)" onClick={() => { setFilter(''); filterRef.current?.focus() }}>
            <X size={13} aria-hidden="true" />
          </button>
        ) : (
          <kbd className="ive-kbd" aria-hidden="true">⌘K</kbd>
        )}
      </div>

      <nav className="ive-nav-group" aria-label={t('nav.work')}>
        <div className="t-label ive-nav-group-title">{t('nav.work')}</div>
        <NavItem id="home" icon={House} label={t('nav.home')} current={!activeOverlay && view === 'home'} onClick={onGoHome} />
        {mode === 'dev' && <NavItem id="board" icon={Columns3} label={t('nav.board')} current={!activeOverlay && view === 'board'} onClick={onGoBoard}>
          {counts.running > 0 && <span className="ive-nav-badge" data-board-badge>{counts.running} running</span>}
          {catchUp?.stale && (
            <span
              className="ive-nav-dot"
              data-catchup-badge=""
              title={`${catchUp.count} events while you were away`}
              onClick={(e) => { e.stopPropagation(); catchUp.open?.() }}
              aria-hidden="true"
            />
          )}
        </NavItem>}
        {waiting > 0 && (
          <button type="button" className="ive-needs-you" onClick={onOpenAttention}
            aria-haspopup="dialog">
            {waiting} {waiting === 1 ? 'item needs' : 'items need'} your attention
            <span aria-hidden="true">→</span>
          </button>
        )}
        {mode === 'dev' && <NavItem id="review" icon={GitCompareArrows} label="Review changes" current={activeOverlay === 'review'} onClick={onOpenReview} />}
        <NavItem id="knowledge" icon={BookOpen} label={t('nav.knowledge')} current={activeOverlay === 'knowledge'} onClick={onOpenKnowledge} />
      </nav>

      {mode === 'chat' ? <ChatHistory filter={filter} /> : <div className="ive-nav-group ive-nav-group--projects">
        <div className="t-label ive-nav-group-title ive-project-heading">
          <span>{t('nav.projects')}</span>
          <button type="button" className="ive-sidebar-icon-btn" aria-label={t('nav.addProject')} title={t('nav.addProject')} onClick={() => window.dispatchEvent(new CustomEvent('open-add-workspace'))}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <Sidebar filter={filter} />
      </div>}

      <nav className="ive-nav-group ive-nav-group--setup" aria-label={t('nav.setup')}>
        <div className="t-label ive-nav-group-title">{t('nav.setup')}</div>
        <NavItem id="settings" icon={Settings} label={t('nav.settings')} current={activeOverlay === 'settings'} onClick={() => onOpenPanel?.('general-settings')} />
        <NavItem id="connectors" icon={Plug} label={t('nav.connectors')} current={activeOverlay === 'connectors'} onClick={() => onOpenPanel?.('connectors')} />
        {isSurfaceAvailable('phone-access') && (
          <NavItem id="phone" icon={Smartphone} label={t('nav.phone')} current={activeOverlay === 'phone'} onClick={() => onOpenPanel?.('phone-access')} />
        )}
      </nav>

      <SidebarFoot />
      {!isMobile && <SidebarResizeHandle />}
    </aside>
  )
}
