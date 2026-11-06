// On-device dictation: microphone → 16 kHz PCM → backend WebSocket → Parakeet (see
// backend/dictation.py). useVoiceInput prefers this when the backend reports it ready
// and falls back to the browser's Web Speech API otherwise.
import { request } from './api'
import { wsBase } from './platform'
import { floatTo16BitPCM, createPcmResampler, mediaErrorReason, microphoneSupported } from './dictationAudio.js'

export { floatTo16BitPCM, createPcmResampler, mediaErrorReason, microphoneSupported }

const TARGET_RATE = 16000
const FRAME_SAMPLES = 2560 // 160 ms
const MAX_QUEUED_BYTES = 2 * 1024 * 1024 // audio kept while the socket connects
const STATUS_TIMEOUT = 10000

// ─── Status (shared by every hook instance and the settings panel) ──────────
let statusCache = null
let statusPromise = null
const listeners = new Set()

export function dictationStatus() {
  return statusCache
}

export function localDictationReady() {
  return statusCache?.state === 'ready'
}

export function subscribeDictationStatus(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setDictationStatus(status) {
  statusCache = status
  for (const listener of listeners) {
    try { listener(status) } catch { /* a listener must not break the others */ }
  }
}

export function refreshDictationStatus({ force = false } = {}) {
  if (statusPromise && !force) return statusPromise
  statusPromise = request('/dictation/status', { signal: AbortSignal.timeout(STATUS_TIMEOUT) })
    .then((status) => { setDictationStatus(status); return status })
    .catch((error) => {
      // Keep the last known status; a missing backend only means "not now".
      if (!statusCache) setDictationStatus({ state: 'unknown', error: error?.message || '' })
      return statusCache
    })
    .finally(() => { statusPromise = null })
  return statusPromise
}

export const dictationApi = {
  status: () => refreshDictationStatus({ force: true }),
  install: () => request('/dictation/install', { method: 'POST' }).then((s) => { setDictationStatus(s); return s }),
  cancel: () => request('/dictation/install/cancel', { method: 'POST' }).then((s) => { setDictationStatus(s); return s }),
  uninstall: () => request('/dictation/uninstall', { method: 'POST' }).then((s) => { setDictationStatus(s); return s }),
}

function workletUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/'
  return `${base.endsWith('/') ? base : `${base}/`}dictation-worklet.js`
}

// ─── Session ────────────────────────────────────────────────────────────────
// startDictation() resolves once the microphone is open. Callbacks:
//   onStatus({state})  'connecting' | 'loading' | 'ready'
//   onInterim(text)    the draft that may still change
//   onFinal(text)      text that will not change (word-aligned chunk)
//   onEnd({text, manual}) after stop(): the remaining text; or after abort()
//   onError(reason, {fallback, message})  'not-allowed' | 'audio-capture' | 'network' | 'service-not-allowed'
export async function startDictation({ onStatus, onInterim, onFinal, onEnd, onError, lang } = {}) {
  if (!microphoneSupported()) {
    const error = new Error('Microphone capture is not available in this browser')
    error.name = 'NotSupportedError'
    throw error
  }
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const Context = window.AudioContext || window.webkitAudioContext
  let context
  try {
    context = new Context({ sampleRate: TARGET_RATE })
  } catch {
    context = new Context()
  }
  const sampleRate = context.sampleRate
  const session = {
    ended: false,
    stopping: false,
    gotText: false,
    queue: [],
    queued: 0,
    ws: null,
    finalTimer: null,
    stop: null,
    abort: null,
    engine: 'local',
    sampleRate,
  }

  const closeAudio = () => {
    try { session.node?.port?.postMessage('close') } catch { /* worklet already gone */ }
    try { session.node?.disconnect() } catch { /* already disconnected */ }
    try { session.processor?.disconnect() } catch { /* already disconnected */ }
    try { session.source?.disconnect() } catch { /* already disconnected */ }
    for (const track of media.getTracks()) { try { track.stop() } catch { /* already stopped */ } }
    if (context.state !== 'closed') context.close().catch(() => {})
  }

  const finish = (result) => {
    if (session.ended) return
    session.ended = true
    if (session.finalTimer) { clearTimeout(session.finalTimer); session.finalTimer = null }
    closeAudio()
    const ws = session.ws
    session.ws = null
    if (ws && ws.readyState <= WebSocket.OPEN) { try { ws.close() } catch { /* ignore */ } }
    onEnd?.(result)
  }

  const fail = (reason, detail = {}) => {
    if (session.ended) return
    session.ended = true
    if (session.finalTimer) { clearTimeout(session.finalTimer); session.finalTimer = null }
    closeAudio()
    const ws = session.ws
    session.ws = null
    if (ws && ws.readyState <= WebSocket.OPEN) { try { ws.close() } catch { /* ignore */ } }
    onError?.(reason, { fallback: !!detail.fallback && !session.gotText, message: detail.message || '' })
  }

  const sendAudio = (buffer) => {
    if (session.ended || session.stopping) return
    const ws = session.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buffer)
      return
    }
    if (session.queued + buffer.byteLength > MAX_QUEUED_BYTES) return
    session.queue.push(buffer)
    session.queued += buffer.byteLength
  }

  // Microphone → PCM frames
  session.source = context.createMediaStreamSource(media)
  const silent = context.createGain()
  silent.gain.value = 0
  silent.connect(context.destination)
  let usedWorklet = false
  if (context.audioWorklet) {
    try {
      await context.audioWorklet.addModule(workletUrl())
      session.node = new AudioWorkletNode(context, 'ive-dictation-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { inputRate: sampleRate, outputRate: TARGET_RATE, frameSize: FRAME_SAMPLES },
      })
      session.node.port.onmessage = (event) => sendAudio(event.data)
      session.source.connect(session.node)
      session.node.connect(silent)
      usedWorklet = true
    } catch (error) {
      console.warn('dictation: AudioWorklet unavailable, using ScriptProcessor', error)
    }
  }
  if (!usedWorklet) {
    const resample = createPcmResampler(sampleRate, TARGET_RATE)
    let pending = new Int16Array(0)
    session.processor = context.createScriptProcessor(4096, 1, 1)
    session.processor.onaudioprocess = (event) => {
      const pcm = floatTo16BitPCM(resample(event.inputBuffer.getChannelData(0)))
      const merged = new Int16Array(pending.length + pcm.length)
      merged.set(pending); merged.set(pcm, pending.length)
      let offset = 0
      while (merged.length - offset >= FRAME_SAMPLES) {
        sendAudio(merged.slice(offset, offset + FRAME_SAMPLES).buffer)
        offset += FRAME_SAMPLES
      }
      pending = merged.slice(offset)
    }
    session.source.connect(session.processor)
    session.processor.connect(silent)
  }
  if (context.state === 'suspended') context.resume().catch(() => {})

  // Backend socket
  onStatus?.({ state: 'connecting' })
  let ws
  try {
    ws = new WebSocket(`${wsBase()}/api/dictation/stream`)
  } catch (error) {
    closeAudio()
    throw error
  }
  ws.binaryType = 'arraybuffer'
  session.ws = ws
  ws.onopen = () => {
    if (session.ended) { ws.close(); return }
    ws.send(JSON.stringify({ type: 'start', sample_rate: TARGET_RATE, lang: lang || navigator.language || '' }))
    for (const buffer of session.queue) ws.send(buffer)
    session.queue = []
    session.queued = 0
    if (session.stopping) ws.send(JSON.stringify({ type: 'stop' }))
  }
  ws.onmessage = (event) => {
    if (session.ended || typeof event.data !== 'string') return
    let data
    try { data = JSON.parse(event.data) } catch { return }
    switch (data.type) {
      case 'status':
        onStatus?.({ state: data.state === 'loading' ? 'loading' : 'connecting' })
        break
      case 'ready':
        onStatus?.({ state: 'ready' })
        break
      case 'interim':
        if (data.text) session.gotText = true
        onInterim?.(data.text || '')
        break
      case 'final':
        if (data.text && data.text.trim()) {
          session.gotText = true
          onFinal?.(data.text)
        }
        break
      case 'done':
        finish({ text: data.text || '', manual: true, seconds: data.seconds })
        break
      case 'aborted':
        finish({ text: '', manual: true })
        break
      case 'error':
        fail(data.fallback ? 'service-not-allowed' : 'network', { fallback: data.fallback, message: data.error })
        break
      default:
        break
    }
  }
  ws.onerror = () => {
    if (!session.ended && !session.stopping) fail('network', { fallback: true, message: 'Dictation service unreachable' })
  }
  ws.onclose = () => {
    if (session.ended) return
    if (session.stopping) finish({ text: '', manual: true })
    else fail('network', { fallback: true, message: 'Dictation connection closed' })
  }

  session.stop = () => {
    if (session.ended || session.stopping) return
    session.stopping = true
    // Let the last frame leave the worklet, then ask the backend to finalize.
    try { session.node?.port?.postMessage('close') } catch { /* ignore */ }
    for (const track of media.getTracks()) { try { track.stop() } catch { /* ignore */ } }
    const socket = session.ws
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' }))
      session.finalTimer = setTimeout(() => finish({ text: '', manual: true, timedOut: true }), 8000)
    } else if (!socket || socket.readyState !== WebSocket.CONNECTING) {
      finish({ text: '', manual: true })
    }
  }
  session.abort = () => {
    const socket = session.ws
    if (socket && socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify({ type: 'abort' })) } catch { /* ignore */ } }
    finish({ text: '', manual: true, aborted: true })
  }
  return session
}
