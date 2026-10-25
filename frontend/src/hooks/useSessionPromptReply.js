import { useCallback, useEffect, useRef, useState } from 'react'
import { answerPrompt, fetchPromptSnapshot, isTerminalRequiredError, promptChoices, promptErrorMessage } from '../lib/promptAnswer'
import { menuKey } from '../lib/promptMenu'

const SENT_NOTICE_MS = 1500

// Polls the current native dialog of a session and answers it against that
// exact dialog. Shared by SessionPromptActions (chat card, terminal tile band)
// and the plan buttons. reply() sends {choice, expected_identity} when the
// snapshot carries the backend's identity, else the legacy {message,
// expected_screen}. After a 409 (stale prompt) the snapshot is reloaded and
// the answer is never resent.
const snapshotKey = (snapshot) => (snapshot?.menu ? menuKey(snapshot.menu) : snapshot?.screen || '')

export default function useSessionPromptReply(sessionId, { active = true, pollMs = 1500 } = {}) {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [sending, setSending] = useState(false)
  const [answeredKey, setAnsweredKey] = useState('')
  const [answeredChoice, setAnsweredChoice] = useState('')
  const [sentAt, setSentAt] = useState(0)
  const [justSent, setJustSent] = useState(false)
  // The guard said terminal_required for this question: it stays "Open terminal" across polls.
  const [terminalOnlyKey, setTerminalOnlyKey] = useState('')
  const requestRef = useRef(0)
  const generationRef = useRef(0)
  const sendingRef = useRef(false)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    const generation = generationRef.current
    try {
      const next = await fetchPromptSnapshot(sessionId)
      if (request !== requestRef.current || generation !== generationRef.current) return
      setSnapshot(next)
      setLoadError('')
    } catch (err) {
      if (request !== requestRef.current || generation !== generationRef.current) return
      setLoadError(err?.message || 'Could not load the current request. Refresh to try again.')
      setSnapshot(null)
    } finally {
      if (request === requestRef.current && generation === generationRef.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    generationRef.current++
    requestRef.current++
    setSnapshot(null)
    setError('')
    setLoadError('')
    setAnsweredKey('')
    setAnsweredChoice('')
    setSentAt(0)
    setTerminalOnlyKey('')
    setSending(false)
    sendingRef.current = false
    setLoading(true)
    if (!active || !sessionId) return undefined
    let stopped = false
    let timer
    const poll = async () => {
      if (!sendingRef.current && !(typeof document !== 'undefined' && document.hidden)) await refresh()
      if (!stopped) timer = setTimeout(poll, pollMs)
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      generationRef.current++
      requestRef.current++
    }
  }, [active, sessionId, pollMs, refresh])

  // "Sent, continuing…" stays for a moment after a successful reply.
  useEffect(() => {
    if (!sentAt) { setJustSent(false); return undefined }
    setJustSent(true)
    const timer = setTimeout(() => setJustSent(false), SENT_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [sentAt])

  const current = snapshot?.sessionId === sessionId ? snapshot : null
  const terminalOnly = !!current?.menu && !!terminalOnlyKey && terminalOnlyKey === snapshotKey(current)
  const menu = current?.menu ? (terminalOnly ? { ...current.menu, answerable: false } : current.menu) : null
  const answered = !!current?.screen && !!answeredKey && answeredKey === snapshotKey(current)
  const unavailable = sending || loading || !current?.screen?.trim() || !!current?.incomplete || answered || menu?.answerable === false

  const reply = useCallback(async (value, { manual = false } = {}) => {
    if (unavailable || sendingRef.current || !current) return false
    const key = snapshotKey(current)
    const generation = generationRef.current
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      await answerPrompt(sessionId, current, value, { manual })
      if (generation !== generationRef.current) return true
      setAnsweredKey(key)
      setAnsweredChoice(manual ? '' : String(value ?? '').trim())
      setSentAt(Date.now())
      window.dispatchEvent(new CustomEvent('cc-session-messages-refresh', { detail: { sessionId } }))
      await refresh()
      return true
    } catch (err) {
      if (generation !== generationRef.current) return false
      setError(promptErrorMessage(err))
      if (isTerminalRequiredError(err)) setTerminalOnlyKey(key)
      await refresh()
      return false
    } finally {
      if (generation === generationRef.current) {
        sendingRef.current = false
        setSending(false)
      }
    }
  }, [unavailable, current, sessionId, refresh])

  const clearError = useCallback(() => { setError(''); setLoadError('') }, [])

  return {
    snapshot: current,
    menu,
    viewState: current?.viewState || null,
    choices: promptChoices(current),
    loading,
    error: error || loadError,
    sending,
    answered,
    answeredChoice: answered ? answeredChoice : '',
    justSent,
    sentAt,
    unavailable,
    refresh,
    reply,
    clearError,
  }
}
