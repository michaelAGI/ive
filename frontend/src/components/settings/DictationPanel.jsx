import { useEffect, useState } from 'react'
import { Mic, Download, Trash2, X, RotateCw, Loader2 } from 'lucide-react'
import { Button } from '../ui'
import { dictationApi, dictationStatus, refreshDictationStatus, subscribeDictationStatus } from '../../lib/dictation'

const STEP_LABELS = { python: 'Python runtime', packages: 'Speech packages', model: 'Speech model' }
const STATE_LABELS = {
  loading: 'Checking…', unknown: 'Status unknown', unsupported: 'Not available on this Mac',
  not_installed: 'Not installed', installing: 'Installing…', ready: 'Ready', error: 'Installation failed',
}

export function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

export default function DictationPanel() {
  const [status, setStatus] = useState(() => dictationStatus() || { state: 'loading' })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const unsubscribe = subscribeDictationStatus((value) => { if (value) setStatus(value) })
    refreshDictationStatus({ force: true })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (status.state !== 'installing') return undefined
    const timer = setInterval(() => { if (!document.hidden) refreshDictationStatus({ force: true }) }, 1500)
    return () => clearInterval(timer)
  }, [status.state])

  const act = async (name, action) => {
    if (busy) return
    setBusy(name)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e?.message || 'The action did not complete.')
    } finally {
      setBusy('')
    }
  }

  const state = status.state || 'unknown'
  const progress = status.progress
  const model = status.model || {}
  const worker = status.worker || {}

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Mic size={16} className={state === 'ready' ? 'text-x-accent' : 'text-x-muted'} />
            <span className="text-sm text-x-ink font-medium">On-device dictation</span>
          </div>
          <span className="text-xs text-x-ink-secondary" role="status">{STATE_LABELS[state] || state}</span>
        </div>

        <p className="text-xs leading-relaxed text-x-ink-secondary">
          The microphone button in the composer transcribes on this Mac with NVIDIA Parakeet,
          which understands 25 European languages including English and German. Audio never
          leaves the computer. Without it, dictation uses the browser's own speech service,
          which is not available inside the IVE app and sends audio to its provider in a browser.
        </p>

        {state === 'unsupported' && (
          <p className="text-xs text-x-ink-secondary">{status.reason || 'Dictation needs an Apple silicon Mac with macOS 14 or newer.'}</p>
        )}

        {(state === 'not_installed' || state === 'error') && (
          <div className="space-y-3">
            {state === 'error' && (
              <p className="text-xs text-x-danger" role="alert">{status.error || 'The installation failed.'}</p>
            )}
            <p className="text-xs text-x-ink-secondary">
              Installing downloads about {formatBytes(status.download_bytes) || '2.7 GB'} once: the speech model
              ({formatBytes(model.bytes)}), its packages and, in the Mac app, a pinned Python runtime.
              Every file is checked against a pinned checksum before use.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={state === 'error' ? RotateCw : Download} loading={busy === 'install'}
                onClick={() => act('install', dictationApi.install)}>
                {state === 'error' ? 'Try again' : 'Install dictation'}
              </Button>
              {state === 'error' && (
                <Button icon={Trash2} loading={busy === 'uninstall'} onClick={() => act('uninstall', dictationApi.uninstall)}>
                  Remove files
                </Button>
              )}
            </div>
          </div>
        )}

        {state === 'installing' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-x-ink-secondary font-medium">
                {progress?.step ? STEP_LABELS[progress.step] || progress.step : 'Preparing'}
                {progress?.detail ? ` · ${progress.detail}` : ''}
              </span>
              <span className="text-x-muted tabular-nums">
                {progress?.total ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}` : ''}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-x-surface-2" aria-hidden="true">
              {progress?.total ? (
                <div className="h-full rounded-full bg-x-accent transition-[width] duration-300" style={{ width: `${progress.percent}%` }} />
              ) : (
                <div className="h-full w-full animate-pulse rounded-full bg-x-accent/40" />
              )}
            </div>
            {progress?.line && <p className="truncate text-xs text-x-muted">{progress.line}</p>}
            <Button icon={X} loading={busy === 'cancel'} onClick={() => act('cancel', dictationApi.cancel)}>Cancel</Button>
          </div>
        )}

        {state === 'ready' && (
          <div className="space-y-3">
            <p className="text-xs text-x-ink-secondary">
              {model.name || 'Parakeet'} is installed. The model loads when you press the microphone
              {typeof worker.load_ms === 'number' ? ` (last time in ${(worker.load_ms / 1000).toFixed(1)} s)` : ''} and
              unloads after ten idle minutes.
              {worker.loaded ? ' It is loaded right now.' : ''}
            </p>
            <Button icon={Trash2} loading={busy === 'uninstall'} onClick={() => act('uninstall', dictationApi.uninstall)}>
              Remove dictation
            </Button>
          </div>
        )}

        {(state === 'loading' || state === 'unknown') && (
          <div className="flex items-center gap-2 text-xs text-x-muted">
            <Loader2 size={12} className="animate-spin" />
            <span>{state === 'loading' ? 'Checking the dictation status…' : (status.error || 'The backend did not answer.')}</span>
          </div>
        )}

        {error && <p className="text-xs text-x-danger" role="alert">{error}</p>}

        <div className="border-t border-x-line-subtle" />

        <p className="text-xs leading-relaxed text-x-ink-secondary">
          Model: {model.name || 'Parakeet TDT 0.6B v3'} by {model.publisher || 'NVIDIA'}, {model.license || 'CC-BY-4.0'},
          from the Hugging Face repository {model.repo || 'mlx-community/parakeet-tdt-0.6b-v3'} at a pinned revision.
          Files live in {status.dir || 'the IVE data folder'}.
        </p>
      </div>
    </div>
  )
}
