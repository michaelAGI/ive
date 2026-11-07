import useDialogDrag from '../../hooks/useDialogDrag'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cx } from './cx'
import { IconButton } from './Button'

// ── Modal — the shared overlay shell ─────────────────────────────────────────
// Replaces the copy-pasted backdrop + x-panel + header pattern. Header shows
// an icon tile + title + subtitle + close. Body is a flex column that fills the
// remaining height (children manage their own scroll). Optional footer.
// Opening: the scrim fades in, the sheet rises and fades in. Closing from the
// X, Escape or the scrim fades both out first; the owner unmounts on `onClose`
// when that fade ends.
const SIZES = {
  sm: 'w-[min(520px,calc(100vw-1.5rem))] max-h-[min(660px,calc(100vh-1.5rem))]',
  md: 'w-[min(820px,calc(100vw-1.5rem))] h-[min(720px,calc(100vh-1.5rem))]',
  lg: 'w-[min(1100px,calc(100vw-1.5rem))] h-[min(820px,calc(100vh-1.5rem))]',
  xl:
    'w-[min(1320px,calc(100vw-1.5rem))] h-[min(900px,calc(100vh-1.5rem))] ' +
    'md:w-[min(1320px,calc(100vw-2.5rem))] md:h-[min(900px,calc(100vh-2.5rem))]',
}

export function Modal({
  open = true,
  onClose,
  icon: Icon,
  title,
  subtitle,
  size = 'lg',
  footer,
  className,
  bodyClassName,
  children,
}) {
  const panelRef = useRef(null)
  const titleId = useId()
  const drag = useDialogDrag(panelRef, open)
  const [closing, setClosing] = useState(false)
  const latestClose = useRef(onClose)
  useEffect(() => { latestClose.current = onClose }, [onClose])
  const closeTimer = useRef(null)
  const finishClose = useCallback(() => {
    if (!closeTimer.current) return
    clearTimeout(closeTimer.current)
    closeTimer.current = null
    latestClose.current?.()
  }, [])
  const requestClose = useCallback(() => {
    if (!latestClose.current || closeTimer.current) return
    setClosing(true)
    closeTimer.current = setTimeout(finishClose, 240)
  }, [finishClose])
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useEffect(() => {
    const previous = document.activeElement
    panelRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    if (!onClose) return
    const onKey = (e) => { if (e.key === 'Escape') requestClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, requestClose])

  if (!open) return null

  return (
    <div
      className={cx('x-modal-shell fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-3 md:p-5 animate-in', closing && 'is-closing')}
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const items = [...panelRef.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((el) => el.getClientRects().length)
          const first = items[0], last = items.at(-1)
          if (!first) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) { event.preventDefault(); first.focus() }
        }}
        className={cx(
          'relative x-panel shadow-[var(--x-shadow-3)] flex flex-col outline-none scale-in x-modal-in',
          SIZES[size] || SIZES.lg,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) finishClose() }}
      >
        {(title || Icon || onClose) && (
          <header {...drag.headerProps} className="flex items-center justify-between gap-3 px-5 py-4 border-b border-x-line shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {Icon && (
                <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-x-accent/10 text-x-accent shrink-0">
                  <Icon size={15} strokeWidth={1.75} />
                </span>
              )}
              <div className="min-w-0">
                {title && (
                  <h2 id={titleId} className="text-[18px] font-semibold text-x-ink leading-tight truncate">{title}</h2>
                )}
                {subtitle && <p className="text-xs text-x-muted truncate mt-0.5">{subtitle}</p>}
              </div>
            </div>
            {onClose && <IconButton icon={X} label="Close" onClick={requestClose} />}
          </header>
        )}

        <div className={cx('flex-1 min-h-0 flex flex-col', bodyClassName)}>{children}</div>

        {footer && (
          <footer className="px-5 py-3.5 border-t border-x-line shrink-0">{footer}</footer>
        )}
      </div>
    </div>
  )
}

export default Modal
