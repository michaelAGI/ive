import { useEffect, useRef } from 'react'
import { useHomeStart } from '../components/home/HomeStartControls'
import ContinueWork from '../components/home/ContinueWork'
import { currentProjectId, projectWorkspaces } from '../lib/quickStart'
import useStore from '../state/store'
import { getLanguage } from '../lib/i18n'
import '../lib/i18n/shell'
import useExperienceMode from '../state/experienceMode'
import ChatHistory from '../components/shell/ChatHistory'
import ProjectTargetSelect from '../components/session/ProjectTargetSelect'

// Scaffold stub: date, the composer (Enter starts a session in the current
// project or the start folder) and the recent sessions. The home agent
// replaces this with chips, "Needs you", recent sessions and projects.
export default function HomeScreen({ onPlan, onAddProject, onFindProject, onOpenPanel, onOpenSession, onReviewTask }) {
  const mode = useExperienceMode(s => s.mode)
  const provider = useExperienceMode(s => s.provider)
  const text = useExperienceMode(s => s.homeDraft)
  const setText = useExperienceMode(s => s.setHomeDraft)
  const workspaceId = useExperienceMode(s => s.workspaceId)
  const chat = mode === 'chat'
  const textareaRef = useRef(null)
  const homeStart = useHomeStart()
  void onPlan
  void onAddProject
  void onOpenSession
  void onReviewTask
  const today = new Date().toLocaleDateString(getLanguage() === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  useEffect(() => {
    const focus = () => textareaRef.current?.focus()
    window.addEventListener('ive-focus-new-chat', focus)
    return () => window.removeEventListener('ive-focus-new-chat', focus)
  }, [])

  const submit = async (e) => {
    e?.preventDefault()
    if (homeStart.busy) return
    const submitted = text
    const state = useStore.getState()
    const chatProject = projectWorkspaces(state.workspaces, state.quickStart).some(ws => ws.id === workspaceId) ? workspaceId : null
    if (await homeStart.start({ text: submitted, workspaceId: chat ? chatProject : currentProjectId(), ...(chat ? { cliType: provider } : {}) })) {
      if (useExperienceMode.getState().homeDraft === submitted) setText('')
    }
  }

  return (
    <div className={`ive-home flex-1 overflow-y-auto${chat ? ' ive-chat-home' : ''}`} data-home-screen="">
      <h1 className="sr-only">Home</h1>
      <div className="ive-home-inner">
        <p className="t-meta ive-home-date">{today}</p>
        {chat && <h2 className="ive-chat-home-heading">What can we work on?</h2>}
        <form className="x-composer ive-home-composer" onSubmit={submit}>
          <textarea
            ref={textareaRef}
            data-home-composer
            aria-label="What do you want to work on?"
            placeholder={chat ? `Message ${provider === 'codex' ? 'Codex' : 'Claude'}…` : 'What do you want to work on? Type / for commands, @ for files'}
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e) }
            }}
          />
          <div className="ive-home-composer-row">
            {chat && <>
              <div role="group" aria-label="Chat assistant" className="ive-chat-assistant">
                {['claude', 'codex'].map(id => <button key={id} type="button" aria-pressed={provider === id} disabled={homeStart.busy} onClick={() => useExperienceMode.getState().setProvider(id)}>{id === 'claude' ? 'Claude' : 'Codex'}</button>)}
              </div>
              <ProjectTargetSelect value={workspaceId} onChange={id => useExperienceMode.getState().setWorkspaceId(id)} onFindProject={onFindProject} className="ive-chat-project" label="Chat project (optional)" emptyLabel="No project" />
            </>}
            <span className="ive-header-fill" />
            <button type="submit" data-home-start className="ive-btn ive-btn--primary" disabled={homeStart.busy || !text.trim()}>{homeStart.busy ? 'Starting…' : chat ? 'Send' : 'Start'}</button>
          </div>
        </form>
        {chat ? <><p className="ive-chat-home-hint">Ask a question, work with your files, or describe a task. You can review requests and results right here.</p><ChatHistory compact /></> : <ContinueWork onAction={onOpenPanel} />}
      </div>
    </div>
  )
}
