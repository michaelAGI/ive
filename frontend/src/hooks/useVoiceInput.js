import { useState, useRef, useCallback, useEffect } from 'react'
import useStore from '../state/store'
import { api } from '../lib/api'
import { noticeFromBrowserDenial } from '../lib/macPermissions'
import {
  startDictation, localDictationReady, refreshDictationStatus, subscribeDictationStatus,
  microphoneSupported, mediaErrorReason,
} from '../lib/dictation'

/**
 * Dictation for composers and forms.
 *
 * Engine order: on-device dictation through the backend (Settings → Dictation,
 * Parakeet on this Mac) when it is installed, otherwise the browser's Web Speech
 * API (Chrome, Edge, Safari; not available inside the desktop shell's WebView).
 *
 * Options:
 *   flushOnStop (default false)
 *     - false: `listening` turns false as soon as the user stops. Text that the
 *       recognizer still finalizes afterwards is delivered through onResult.
 *     - true:  `listening` stays true until the complete transcript has been
 *       delivered (local: the backend's "done"; browser: the recognizer's onend).
 *       Use this when a consumer acts on the listening → false transition.
 *   keepAlive: restart the browser recognizer when it ends on its own (local
 *       dictation runs until stopped anyway).
 *   onInterim(text): draft text; also exposed as `interim`.
 */
// A refused microphone is told once per refusal, with the button that opens
// the right System Settings pane in the desktop app. Callers with their own
// onError handle it themselves.
function reportMicrophoneRefusal(reason) {
  const notice = noticeFromBrowserDenial(reason, 'microphone')
  if (!notice) return
  useStore.getState().addNotification({
    type: 'warning',
    message: notice.sentence,
    ...(notice.pane ? { action: { label: notice.buttonLabel, onClick: () => api.openMacSettings(notice.pane) } } : {}),
  })
}

function browserRecognition() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function useVoiceInput(
  onResult,
  {
    flushOnStop = false,
    keepAlive = false,
    onInterim,
    onStart,
    onEnd,
    onError,
    lang,
  } = {},
) {
  const [listening, setListening] = useState(false)
  const [status, setStatus] = useState('idle') // idle | connecting | loading | ready | browser
  const [interim, setInterim] = useState('')
  const [localReady, setLocalReady] = useState(localDictationReady)
  const recRef = useRef(null)
  const sessionRef = useRef(null)
  const manualStopRef = useRef(false)
  const startRef = useRef(null)
  const callbacks = useRef({})
  callbacks.current = { onResult, onInterim, onStart, onEnd, onError }

  useEffect(() => {
    const unsubscribe = subscribeDictationStatus((value) => setLocalReady(value?.state === 'ready'))
    refreshDictationStatus()
    return unsubscribe
  }, [])

  useEffect(() => () => {
    // Unmount while dictating: release the microphone without delivering text.
    sessionRef.current?.abort?.()
    sessionRef.current = null
    const rec = recRef.current
    recRef.current = null
    try { rec?.abort() } catch { /* already stopped */ }
  }, [])

  const startBrowser = useCallback((restart = false) => {
    const SR = browserRecognition()
    if (!SR) {
      callbacks.current.onError?.('service-not-allowed')
      setListening(false)
      setStatus('idle')
      return
    }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = !!callbacks.current.onInterim
    rec.lang = lang || navigator.language || 'en-US'

    rec.onresult = (e) => {
      let finalText = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalText += e.results[i][0].transcript
        } else {
          interimText += e.results[i][0].transcript
        }
      }
      if (interimText) {
        setInterim(interimText)
        callbacks.current.onInterim?.(interimText)
      }
      if (finalText) {
        setInterim('')
        callbacks.current.onResult?.(finalText)
      }
    }

    rec.onerror = (e) => {
      // "aborted" fires every time toggle() calls rec.abort() to stop —
      // it's the documented stop path, not a real error.
      // "no-speech" fires when the user toggled the mic but didn't talk.
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        console.error('Speech recognition error:', e.error)
      }
      if (callbacks.current.onError) callbacks.current.onError(e.error)
      else reportMicrophoneRefusal(e.error)
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        manualStopRef.current = true
      }
      recRef.current = null
      if (!keepAlive || manualStopRef.current) {
        setListening(false)
        setStatus('idle')
      }
    }

    rec.onend = () => {
      recRef.current = null
      if (keepAlive && !manualStopRef.current) {
        setTimeout(() => {
          if (!manualStopRef.current && !recRef.current && !sessionRef.current) startRef.current?.(true)
        }, 250)
        return
      }
      setListening(false)
      setStatus('idle')
      setInterim('')
      callbacks.current.onEnd?.({ manual: manualStopRef.current, engine: 'browser' })
    }

    try {
      rec.start()
      recRef.current = rec
      setListening(true)
      setStatus('browser')
      callbacks.current.onStart?.({ restart, lang: rec.lang, engine: 'browser' })
    } catch (e) {
      console.error('Failed to start speech recognition:', e)
      callbacks.current.onError?.(e?.message || 'start_failed')
      recRef.current = null
      setListening(false)
      setStatus('idle')
    }
  }, [keepAlive, lang])

  startRef.current = startBrowser

  const startLocal = useCallback(async () => {
    setListening(true)
    setStatus('connecting')
    setInterim('')
    let session
    try {
      session = await startDictation({
        lang,
        onStatus: ({ state }) => setStatus(state),
        onInterim: (text) => {
          setInterim(text)
          callbacks.current.onInterim?.(text)
        },
        onFinal: (text) => callbacks.current.onResult?.(text),
        onEnd: ({ text, manual }) => {
          sessionRef.current = null
          if (text && text.trim()) callbacks.current.onResult?.(text)
          setInterim('')
          setListening(false)
          setStatus('idle')
          callbacks.current.onEnd?.({ manual: manual !== false, engine: 'local' })
        },
        onError: (reason, { fallback, message } = {}) => {
          sessionRef.current = null
          setInterim('')
          if (fallback && browserRecognition() && !manualStopRef.current) {
            console.warn('On-device dictation unavailable, using the browser recognizer:', message)
            startBrowser(false)
            return
          }
          setListening(false)
          setStatus('idle')
          if (message) console.warn('Dictation stopped:', message)
          if (callbacks.current.onError) callbacks.current.onError(reason)
          else reportMicrophoneRefusal(reason)
        },
      })
    } catch (error) {
      sessionRef.current = null
      setListening(false)
      setStatus('idle')
      const reason = error?.name === 'NotSupportedError' ? 'service-not-allowed' : mediaErrorReason(error)
      if (reason !== 'not-allowed') console.warn('Dictation could not start:', error)
      if (callbacks.current.onError) callbacks.current.onError(reason)
      else reportMicrophoneRefusal(reason)
      return
    }
    if (manualStopRef.current) {
      // Toggled off while the microphone prompt was open.
      session.abort()
      return
    }
    sessionRef.current = session
    callbacks.current.onStart?.({ restart: false, lang: lang || navigator.language, engine: 'local' })
  }, [lang, startBrowser])

  const toggle = useCallback(() => {
    // Use refs (not state) to avoid stale closures on rapid toggles.
    const session = sessionRef.current
    if (session) {
      manualStopRef.current = true
      session.stop()
      if (!flushOnStop) {
        // Instant release for the button; the tail text still arrives via onResult.
        setListening(false)
        setStatus('idle')
        setInterim('')
      }
      return
    }
    if (recRef.current) {
      manualStopRef.current = true
      if (flushOnStop) {
        // stop() lets the recognizer finalize pending interim results before
        // onend fires; listening stays true until then.
        recRef.current.stop()
      } else {
        recRef.current.abort() // discards in-flight speech, instant mic release
        recRef.current = null
        setListening(false)
        setStatus('idle')
        setInterim('')
        callbacks.current.onEnd?.({ manual: true, engine: 'browser' })
      }
      return
    }
    if (listening) {
      // Starting (microphone prompt open): cancel.
      manualStopRef.current = true
      setListening(false)
      setStatus('idle')
      callbacks.current.onEnd?.({ manual: true })
      return
    }

    manualStopRef.current = false
    if (localDictationReady() && microphoneSupported()) {
      startLocal()
    } else if (browserRecognition()) {
      startBrowser(false)
    } else {
      console.warn('Speech recognition is not available here. Install on-device dictation in Settings.')
      callbacks.current.onError?.('service-not-allowed')
    }
  }, [flushOnStop, listening, startBrowser, startLocal])

  const browserAvailable = !!browserRecognition()
  const localAvailable = localReady && microphoneSupported()
  return {
    listening,
    toggle,
    supported: localAvailable || browserAvailable,
    engine: status === 'browser' ? 'browser' : localAvailable ? 'local' : browserAvailable ? 'browser' : null,
    status,
    interim,
  }
}
