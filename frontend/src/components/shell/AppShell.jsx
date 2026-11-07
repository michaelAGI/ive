import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import useStore from '../../state/store'
import { requestTerminalRefit, slideSidebar } from '../../lib/sidebarMotion'
import MobileDrawer from '../layout/MobileDrawer'
import TerminalKeepAlive from './TerminalKeepAlive'
import TerminalTabs from './TerminalTabs'
import useExperienceMode from '../../state/experienceMode'
import ExperienceSwitch from './ExperienceSwitch'
import useWorkspaceData from '../../hooks/useWorkspaceData'

// The frame every screen sits in. Desktop: [sidebar 240 px | main: header
// 44 px › screen › footer 28 px (only when set)] plus the side chat next to
// main and one TerminalKeepAlive at the end of main. Phone: the drawer with
// the sidebar, the phone header and the screen. `prelude` (install prompts,
// cost panel …) and `overlays` (modals, toasts) stay inside .x-app-shell so
// the onboarding's `inert` covers them.
function useVisualViewport(isMobile) {
  // Soft keyboard: the visual viewport is clearly shorter than the tallest one
  // seen at this width. Mobile then hides secondary chrome so the input and
  // terminal keep their room (see [data-keyboard-open] in index.css). iOS
  // scrolls the layout viewport to show a focused input above the keyboard;
  // the phone shell follows the visual viewport's top as well.
  const [vvHeight, setVvHeight] = useState(null)
  const [vvTop, setVvTop] = useState(0)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  useEffect(() => {
    const refit = () => window.dispatchEvent(new Event('cc-terminal-refit'))
    let timer = null
    let tallest = { width: 0, height: 0 }
    const update = () => {
      const vv = window.visualViewport
      setVvHeight(vv ? vv.height : null)
      if (!vv) return
      setVvTop(Math.max(0, Math.round(vv.offsetTop || 0)))
      if (vv.width !== tallest.width || vv.height > tallest.height) tallest = { width: vv.width, height: vv.height }
      setKeyboardOpen(vv.height < tallest.height * 0.75)
    }
    const debounced = () => {
      update()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { refit(); setTimeout(refit, 250) }, 60)
    }
    const vv = window.visualViewport
    if (vv) {
      vv.addEventListener('resize', debounced)
      vv.addEventListener('scroll', debounced)
      update()
    }
    window.addEventListener('orientationchange', debounced)
    return () => {
      if (timer) clearTimeout(timer)
      if (vv) {
        vv.removeEventListener('resize', debounced)
        vv.removeEventListener('scroll', debounced)
      }
      window.removeEventListener('orientationchange', debounced)
    }
  }, [])
  return { vvHeight, vvTop, keyboardOpen: isMobile && keyboardOpen }
}

// Keeps the sidebar mounted while it slides out, and slides it in when it
// comes back. The first paint never animates. A sidebar the drag handle has
// already slid out (data-collapsed) unmounts at once.
function AnimatedSidebar({ visible, children }) {
  const host = useRef(null)
  const [phase, setPhase] = useState(visible ? 'open' : 'hidden')
  useLayoutEffect(() => {
    if (visible && (phase === 'hidden' || phase === 'closing')) setPhase('opening')
    else if (!visible && (phase === 'open' || phase === 'opening')) setPhase('closing')
  }, [visible, phase])
  useLayoutEffect(() => {
    const aside = host.current?.firstElementChild
    if (phase !== 'opening' && phase !== 'closing') return undefined
    const opening = phase === 'opening'
    const draggedShut = aside?.dataset.collapsedByDrag === '1'
    if (aside) delete aside.dataset.collapsedByDrag
    if (!opening && (!aside || draggedShut)) { setPhase('hidden'); requestTerminalRefit(); return undefined }
    const slide = slideSidebar(aside, { hidden: !opening, duration: opening ? 240 : 200 })
    const done = () => {
      setPhase((current) => (current === phase ? (opening ? 'open' : 'hidden') : current))
      if (opening && aside) { slide?.cancel(); aside.style.removeProperty('margin-left') }
      requestTerminalRefit()
    }
    if (!slide) { done(); return undefined }
    slide.finished.then(done, () => {})
    return () => slide.cancel()
  }, [phase])
  if (phase === 'hidden') return null
  return <div ref={host} className="contents" data-sidebar-phase={phase}>{children}</div>
}

// With the sidebar hidden, the left window edge pulls it back out.
function SidebarEdge() {
  const start = useRef(null)
  const show = () => useStore.setState({ sidebarVisible: true })
  return (
    <div
      className="ive-sidebar-edge"
      aria-hidden="true"
      title="Drag to show the sidebar"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        start.current = { id: event.pointerId, x: event.clientX }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* moves still arrive over the edge */ }
      }}
      onPointerMove={(event) => {
        const s = start.current
        if (!s || s.id !== event.pointerId) return
        if (event.clientX - s.x > 24) { start.current = null; show() }
      }}
      onPointerUp={() => { start.current = null }}
      onPointerCancel={() => { start.current = null }}
      onDoubleClick={show}
    />
  )
}

export default function AppShell({
  isMobile = false, sidebarVisible = true, mobileDrawerOpen = false, onMobileDrawerClose,
  mobileView, phoneLevel,
  sidebar, header, mobileHeader, footer, prelude, sideChat, overlays, children,
}) {
  useWorkspaceData()
  const { vvHeight, vvTop, keyboardOpen } = useVisualViewport(isMobile)
  const mode = useExperienceMode(s => s.mode)

  return (
    <div
      className="x-app-shell flex flex-col overflow-hidden x-canvas"
      data-mobile-view={isMobile ? mobileView : undefined}
      data-experience={mode}
      data-phone-level={isMobile ? phoneLevel : undefined}
      data-keyboard-open={keyboardOpen ? '' : undefined}
      style={{
        ...(isMobile ? { position: 'fixed', left: 0, right: 0, top: vvTop } : {}),
        // On mobile, bind to visualViewport.height so the layout shrinks when
        // the soft keyboard opens; `100dvh` stays the full screen height and
        // would let the keyboard cover the terminal input.
        height: isMobile && vvHeight ? `${vvHeight}px` : '100dvh',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: keyboardOpen ? 0 : 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      {prelude}
      <div className="relative flex flex-1 min-h-0">
        {!isMobile && <AnimatedSidebar visible={sidebarVisible}>{sidebar}</AnimatedSidebar>}
        {!isMobile && !sidebarVisible && <SidebarEdge />}
        {isMobile && (
          <MobileDrawer open={mobileDrawerOpen} onClose={onMobileDrawerClose}>
            {sidebar}
          </MobileDrawer>
        )}
        <main className="x-app-main flex-1 flex flex-col min-w-0 min-h-0">
          {isMobile ? mobileHeader : header}
          {isMobile && <ExperienceSwitch className="ive-experience-mobile" />}
          {!isMobile && mode === 'dev' && <TerminalTabs />}
          <div className="ive-main-body flex-1 flex flex-col min-h-0 min-w-0 relative">
            {children}
          </div>
          {!isMobile && footer}
          {!isMobile && <TerminalKeepAlive />}
        </main>
        {sideChat}
      </div>
      {overlays}
    </div>
  )
}
