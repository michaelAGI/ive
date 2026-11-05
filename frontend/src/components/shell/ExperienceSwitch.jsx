import { MessageSquare, PanelsTopLeft } from 'lucide-react'
import useExperienceMode from '../../state/experienceMode'
import './experience.css'

export default function ExperienceSwitch({ className = '' }) {
  const mode = useExperienceMode(s => s.mode)
  const setMode = useExperienceMode(s => s.setMode)
  return <div role="group" aria-label="Experience mode" className={`ive-experience-switch ${className}`}>
    <button type="button" aria-pressed={mode === 'chat'} data-experience-mode="chat" onClick={() => setMode('chat')} title="Conversations with Claude or Codex">
      <MessageSquare size={14} aria-hidden="true" />Chat
    </button>
    <button type="button" aria-pressed={mode === 'dev'} data-experience-mode="dev" onClick={() => setMode('dev')} title="Terminals, projects and parallel agents">
      <PanelsTopLeft size={14} aria-hidden="true" />Dev
    </button>
  </div>
}
