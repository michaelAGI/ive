import { User, MessageCircle, Folder, ExternalLink } from 'lucide-react'

// Plain words for the four note types. The agent-facing prompt uses its own
// headings (memory_manager.export_for_prompt); these labels are for people.
export const ENTRY_TYPE_HINT = {
  user: 'Who you are and what you prefer.',
  feedback: 'How you want the agent to work: rules, corrections, approaches that worked.',
  project: 'Facts about this project: decisions, structure, gotchas.',
  reference: 'Links, tickets, dashboards and other external sources.',
}

export const ENTRY_TYPE_META = {
  user:      { icon: User,          label: 'About you',  color: 'text-x-accent', bg: 'bg-x-tint' },
  feedback:  { icon: MessageCircle, label: 'How to work', color: 'text-x-accent', bg: 'bg-x-tint' },
  project:   { icon: Folder,        label: 'Project',    color: 'text-x-accent', bg: 'bg-x-tint' },
  reference: { icon: ExternalLink,  label: 'References', color: 'text-x-accent', bg: 'bg-x-tint' },
}
