import { Bot, Copy, Send } from 'lucide-react'
import './review-context.css'

export default function ReviewActions({ annotationsCount, sessionName, providerLabel, onFeedback, onStartReview, onCopy, disabled = false }) {
  return <div className="ive-review-actions" data-review-actions>
    <button type="button" disabled={disabled || !annotationsCount} onClick={onFeedback} title={`Send selected feedback to ${sessionName || 'this conversation'}`}><Send size={13} /> Send feedback to this chat{annotationsCount ? ` (${annotationsCount})` : ''}</button>
    <button type="button" disabled={disabled} onClick={onStartReview}><Bot size={13} /> Start review with {providerLabel}…</button>
    <button type="button" disabled={disabled} onClick={onCopy}><Copy size={12} /> Copy changes</button>
  </div>
}
