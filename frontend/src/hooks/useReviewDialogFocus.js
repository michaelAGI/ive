import { useEffect, useRef } from 'react'

export default function useReviewDialogFocus(onClose, busy) {
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onClose()
    }
    if (event.key !== 'Tab') return
    const panel = ref.current
    const items = [...panel.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter((element) => element.getClientRects().length)
    const first = items[0], last = items.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
      event.preventDefault(); first.focus()
    }
  }
  return { ref, tabIndex: -1, onKeyDown, 'data-ive-review-dialog': '' }
}
