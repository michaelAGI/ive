import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, FolderOpen, MessageSquare, Bot, Laptop, X } from 'lucide-react'
import './interactive-onboarding.css'

// The first launch explains the first task, without creating practice sessions,
// sending prompts, or requiring a tour through advanced features.
export default function InteractiveOnboarding({ profile, onFinish, onNavigate }) {
  const panel = useRef(null)
  const primary = useRef(null)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const owner = profile.owner

  useEffect(() => {
    const previous = document.activeElement
    const shell = document.querySelector('.x-app-shell')
    const wasInert = shell?.inert
    if (shell) shell.inert = true
    primary.current?.focus()
    return () => {
      if (shell) shell.inert = wasInert
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const finish = async (destination = null, localOnly = false) => {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    setError(false)
    setPendingAction(destination)
    try {
      await onFinish({ name: profile.name || '', skip: !destination, localOnly })
      if (destination) onNavigate(destination)
    } catch {
      setError(true)
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  const handleKeyDown = (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      finish()
    }
    if (event.key !== 'Tab') return
    const items = [...panel.current.querySelectorAll('button:not(:disabled)')]
      .filter((item) => item.getClientRects().length)
    if (!items.length) { event.preventDefault(); return }
    // Safari's default Tab policy skips buttons. Own the full cycle so the
    // same controls stay reachable in the Mac WebView and other browsers.
    event.preventDefault()
    const index = items.indexOf(document.activeElement)
    const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length
    items[next].focus()
  }

  const steps = owner ? [
    [FolderOpen, 'Projekt öffnen', 'Wähle den Ordner, an dem du arbeiten möchtest.'],
    [Bot, 'KI wählen', 'Starte einen Dialog mit Claude oder Codex. Du nutzt dein eigenes KI-Konto.'],
    [MessageSquare, 'Aufgabe beschreiben', 'Zum Beispiel: „Erkläre mir dieses Projekt.“ Du kannst direkt im Chat nachfragen.'],
    [Laptop, 'Deckel zu, weiterarbeiten', 'Optional: Der Mac bleibt mit geschlossenem Deckel wach, die Terminals laufen weiter und du erreichst sie vom iPhone. Einmal unter Einstellungen → Mac & Power einschalten.'],
  ] : [
    [FolderOpen, 'Projekt ansehen', 'Öffne ein Projekt, das mit dir geteilt wurde.'],
    [MessageSquare, 'Dialog öffnen', 'Lies die Unterhaltung und sieh, woran die KI arbeitet.'],
    [Bot, 'Zusammenarbeiten', 'Was du bearbeiten kannst, hängt von deinem freigegebenen Zugang ab.'],
  ]

  return createPortal(
    <div className="ive-welcome-backdrop" lang="de" data-ive-onboarding onKeyDown={handleKeyDown}>
      <section ref={panel} className="ive-welcome" role="dialog" aria-modal="true"
        aria-labelledby="ive-welcome-title" aria-describedby="ive-welcome-description" aria-busy={saving}>
        <button type="button" className="ive-welcome-close" aria-label="Einführung schließen" disabled={saving} onClick={() => finish()}><X size={18} /></button>
        <header className="ive-welcome-heading">
          <img src="/favicon.svg" width="36" height="36" alt="" />
          <h1 id="ive-welcome-title">Willkommen bei IVE</h1>
          <p id="ive-welcome-description">{owner ? 'Dein Projekt und deine KI an einem Ort.' : 'Deine Projekte und KI-Dialoge an einem Ort.'}</p>
        </header>
        <ol className="ive-welcome-steps">
          {steps.map(([Icon, title, description]) => <li key={title}>
            <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
            <div><h2>{title}</h2><p>{description}</p></div>
          </li>)}
        </ol>
        {error && <div className="ive-welcome-error" role="alert">
          <p>Die Einführung konnte nicht als gelesen gespeichert werden.</p>
          <div><button type="button" disabled={saving} onClick={() => finish(pendingAction)}>Erneut versuchen</button>
          <button type="button" disabled={saving} onClick={() => finish(pendingAction, true)}>Ohne Speichern fortfahren</button></div>
        </div>}
        <footer className="ive-welcome-footer">
          <div className="ive-welcome-actions">
            <button ref={primary} type="button" className="ive-welcome-primary" disabled={saving} onClick={() => finish(owner ? 'project' : 'home')}>
              {saving ? 'Einen Moment …' : owner ? 'Projekt öffnen' : 'Zur Übersicht'}<ArrowRight size={16} aria-hidden="true" />
            </button>
            {owner && <button type="button" className="ive-welcome-secondary" disabled={saving} onClick={() => finish('accounts')}>KI einrichten</button>}
            {owner && <button type="button" className="ive-welcome-secondary" disabled={saving} onClick={() => finish('mac-power')}>Deckel-zu-Modus</button>}
          </div>
          <p>Jederzeit unter „?“ wieder öffnen.</p>
        </footer>
      </section>
    </div>, document.body,
  )
}
