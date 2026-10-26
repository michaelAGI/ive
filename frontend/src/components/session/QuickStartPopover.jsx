import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, SquareTerminal, ArrowRight, Plus, X } from 'lucide-react'
import useStore from '../../state/store'
import { formatKeyCombo } from '../../lib/keybindings'
import { describeTarget, loadQuickStart, openSessionSetup, updateQuickStartRoot } from '../../lib/quickStart'
import { startQuickTerminal } from '../../lib/shellSession'
import ProjectTargetSelect from './ProjectTargetSelect'
import WorkspacePicker from '../workspace/WorkspacePicker'
import { connectProject } from '../../lib/taskFlow'

/** A new tab is either a login shell or a configured agent session. */
export default function QuickStartPopover({ onClose }) {
  const quickStart = useStore((s) => s.quickStart)
  const keybindings = useStore((s) => s.keybindings)
  const workspaces = useStore((s) => s.workspaces)
  const [target, setTarget] = useState(() => useStore.getState().quickStartWorkspaceId || null)
  const [findingProject, setFindingProject] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editingRoot, setEditingRoot] = useState(false)
  const [rootDraft, setRootDraft] = useState('')
  const terminalRef = useRef(null)
  const rootRef = useRef(null)
  const where = describeTarget(target, { workspaces, quickStart })
  const rootLabel = where.short || '~/Projekte'

  useEffect(() => { loadQuickStart().catch(() => {}) }, [])
  useEffect(() => {
    if (!findingProject && !editingRoot) terminalRef.current?.focus()
    if (editingRoot) rootRef.current?.focus()
  }, [findingProject, editingRoot])

  const start = async (kind) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const workspaceId = where.isProject ? target : null
      if (kind === 'terminal') {
        await startQuickTerminal({ workspaceId })
        onClose()
      } else {
        await openSessionSetup(workspaceId)
      }
    } catch (err) {
      setError(err?.message || 'The tab could not be opened.')
    } finally { setBusy(false) }
  }

  const saveRoot = async (event) => {
    event.preventDefault()
    if (busy || !rootDraft.trim()) return
    setBusy(true)
    setError('')
    try {
      await updateQuickStartRoot(rootDraft.trim())
      setEditingRoot(false)
    } catch (err) { setError(err?.message || 'That folder does not exist.') }
    finally { setBusy(false) }
  }

  if (findingProject) return <WorkspacePicker
    title="Add a project"
    subtitle="Choose the folder for your terminal or session."
    onClose={() => setFindingProject(false)}
    onSelect={async (project) => {
      const { workspace } = await connectProject(project)
      setTarget(workspace.id)
      useStore.getState().setActiveWorkspace(workspace.id)
      setFindingProject(false)
    }}
  />

  return (
    <div className="fixed inset-0 z-[60] flex justify-center px-4 pt-[16vh]" style={{ background: 'color-mix(in srgb, var(--x-scrim) 45%, transparent)' }} onMouseDown={busy ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="New tab" data-quick-start
        className="x-panel scale-in h-fit max-h-[80dvh] w-[min(560px,100%)] overflow-y-auto shadow-[var(--x-shadow-3)]"
        onMouseDown={(event) => event.stopPropagation()}>
        <header className="ive-session-entry-heading">
          <div><h2>New tab</h2></div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={17} /></button>
        </header>
        <div className="ive-session-entry">
          <p>Open a terminal or work with an agent.</p>
          <div className="ive-session-entry-project">
            <label htmlFor="session-entry-project">Project</label>
            <div><ProjectTargetSelect id="session-entry-project" value={target} onChange={setTarget} onFindProject={() => setFindingProject(true)} /><button type="button" disabled={busy} onClick={() => setFindingProject(true)}><Plus size={14} /> Add project</button></div>
            {!where.isProject && <>
              <span>Your tab starts in {rootLabel}.</span>
              {editingRoot ? <form onSubmit={saveRoot} className="flex gap-2" data-quick-start-root>
                <input ref={rootRef} aria-label="Start folder" value={rootDraft} disabled={busy}
                  className="flex-1 min-w-0 rounded border border-x-line bg-x-bg px-2 py-1 text-sm"
                  onChange={(event) => setRootDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditingRoot(false) } }} />
                <button type="submit" disabled={busy || !rootDraft.trim()}>Save</button>
                <button type="button" disabled={busy} onClick={() => setEditingRoot(false)}>Cancel</button>
              </form> : <button type="button" disabled={busy} className="text-xs text-x-muted underline underline-offset-2 self-start"
                onClick={() => { setRootDraft(quickStart?.root || ''); setEditingRoot(true) }}>Change start folder</button>}
            </>}
          </div>
          <button ref={terminalRef} type="button" className="ive-session-entry-option is-primary" disabled={busy} onClick={() => start('terminal')}>
            <SquareTerminal size={20} /><span><strong>Terminal</strong><span>Your shell, ready for commands. Opens directly in a new tab.</span></span>
            {keybindings?.newTerminal && <kbd className="ive-kbd">{formatKeyCombo(keybindings.newTerminal)}</kbd>}<ArrowRight size={17} />
          </button>
          <button type="button" className="ive-session-entry-option" disabled={busy} onClick={() => start('session')}>
            <SlidersHorizontal size={20} /><span><strong>Session</strong><span>Choose an agent, model, permissions and tools for your task.</span></span><ArrowRight size={17} />
          </button>
          {error && <p role="alert" className="text-x-danger">{error}</p>}
        </div>
      </div>
    </div>
  )
}
