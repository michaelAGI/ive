import { useEffect, useSyncExternalStore } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import { Button } from '../ui'
import Modal from '../ui/Modal'
import { desktopUpdates as updates } from '../../lib/desktopUpdates'

const useUpdates = () => useSyncExternalStore(updates.subscribe, updates.getSnapshot)
const busyText = phase => phase === 'checking' ? 'Checking…' : phase === 'installing' ? 'Installing and restarting…' : phase === 'saving' ? 'Saving…' : 'Downloading update…'

export function DesktopUpdateSettings() {
  const state = useUpdates()
  if (!state.supported) return null
  return <section data-desktop-update-settings className="border-b border-x-line pb-5 space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold">IVE updates</h3><p className="text-xs text-x-muted mt-1">{state.currentVersion ? `Version ${state.currentVersion}` : 'Mac app'}</p></div>
      <Button icon={RefreshCw} onClick={() => { updates.open(); updates.check() }}>Check for updates</Button>
    </div>
    <label className="flex items-start gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={state.automatic} disabled={state.phase !== 'idle'} onChange={e => updates.setAutomatic(e.target.checked)} className="mt-1" />
      <span>Automatic updates<span className="block text-xs text-x-muted mt-1">Download new versions in the background and install them the next time IVE starts.</span></span>
    </label>
    {state.error && !state.open && <p role="alert" className="text-xs text-x-muted">{state.error}</p>}
  </section>
}

export default function DesktopUpdates() {
  const state = useUpdates()
  useEffect(() => {
    if (!state.supported) return undefined
    updates.initialize()
    const first = setTimeout(() => updates.check(), 20000)
    const repeat = setInterval(() => updates.check(), 6 * 60 * 60 * 1000)
    const open = () => { updates.open(); updates.check() }
    window.addEventListener('ive-check-updates', open)
    return () => { clearTimeout(first); clearInterval(repeat); window.removeEventListener('ive-check-updates', open) }
  }, [state.supported])
  if (!state.supported) return null
  const busy = state.phase !== 'idle'
  const progress = state.progress?.total ? Math.min(100, Math.round(state.progress.downloaded / state.progress.total * 100)) : null
  return <>
    {!state.open && state.version && state.dismissed !== state.version && <div data-desktop-update-notice role="status" className="fixed bottom-5 right-5 z-40 flex items-center gap-3 rounded-xl border border-x-line bg-x-surface px-4 py-3 shadow-x-1 text-sm">
      <Download size={16} aria-hidden="true" />
      <span>IVE {state.version} {state.downloaded ? 'is ready' : 'is available'}</span>
      <Button size="sm" onClick={updates.open}>View update</Button>
      <button type="button" onClick={updates.dismiss} aria-label="Dismiss update notice"><X size={15}/></button>
    </div>}
    {state.open && <Modal size="sm" title={state.version ? `Update to IVE ${state.version}` : 'IVE updates'} icon={Download} onClose={busy ? undefined : updates.close} footer={<div className="flex justify-end gap-2">
      <Button onClick={updates.close} disabled={busy}>Later</Button>
      {state.restartRequired ? <Button onClick={updates.restart} disabled={busy}>Restart IVE</Button>
        : state.version ? <Button onClick={updates.install} disabled={busy}>Install and restart</Button>
        : <Button onClick={updates.check} disabled={busy}>Check again</Button>}
    </div>}>
      <div className="p-5 space-y-4 text-sm">
        <p className="text-x-muted">Installed: IVE {state.currentVersion}</p>
        {busy ? <div role="status"><p>{busyText(state.phase)}{state.phase === 'downloading' && progress !== null ? ` ${progress}%` : ''}</p>{state.phase === 'downloading' && <progress className="w-full mt-3" max="100" value={progress ?? undefined} aria-label="Update download" />}</div>
          : state.version ? <>
            <p>{state.downloaded ? 'The update is downloaded and verified.' : 'A new version of IVE is available.'}</p>
            <p>Installing now restarts IVE and stops running agents and terminals. Your saved chats, projects and settings stay on this Mac.</p>
            {state.downloaded && state.automatic && <p className="text-x-muted">Choose Later to install automatically the next time you open IVE.</p>}
          </> : !state.error && <p>{state.checked ? 'You’re up to date.' : 'Check for the latest version of IVE.'}</p>}
        {state.notes && <details><summary className="cursor-pointer text-x-muted">What’s new</summary><p className="whitespace-pre-wrap text-xs mt-3 max-h-48 overflow-auto">{state.notes}</p></details>}
        {state.error && <p role="alert" className="text-x-muted">{state.error}</p>}
      </div>
    </Modal>}
  </>
}
