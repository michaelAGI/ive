import { useState } from 'react'
import { api } from '../../lib/api'
import { Button } from '../ui'

export async function openMacPermissionSettings(notice) {
  if (!notice?.pane) return false
  try {
    await api.openMacSettings(notice.pane)
    return true
  } catch {
    return false
  }
}

// One sentence, one button that opens the right System Settings pane, and a
// second chance. Shown wherever macOS refused IVE something.
export default function MacPermissionNotice({ notice, onRetry, onDismiss, compact = false, autoFocus = false, className = '' }) {
  const [busy, setBusy] = useState(false)
  if (!notice) return null
  const open = async () => {
    setBusy(true)
    try { await openMacPermissionSettings(notice) } finally { setBusy(false) }
  }
  return (
    <div role="alert" data-mac-permission={notice.reason} className={`rounded-lg border border-x-tint-line bg-x-tint p-3 text-x-ink ${compact ? 'text-[11px]' : 'text-xs'} ${className}`}>
      <p className="leading-relaxed">{notice.sentence}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {notice.pane && <Button variant="primary" size="sm" onClick={open} disabled={busy} autoFocus={autoFocus} data-mac-permission-open>{notice.buttonLabel}</Button>}
        {onRetry && <Button size="sm" onClick={onRetry} data-mac-permission-retry>Try again</Button>}
        {onDismiss && <Button size="sm" onClick={onDismiss}>Close</Button>}
      </div>
    </div>
  )
}
