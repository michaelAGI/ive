// Pure audio helpers for on-device dictation. No imports, so node --test can load
// this file directly (tests/dictation-unit.mjs). src/lib/dictation.js re-exports them.
const TARGET_RATE = 16000

export function floatTo16BitPCM(samples) {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i]
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

// Chunk-wise linear resampler that stays continuous across chunk borders.
// Same algorithm as public/dictation-worklet.js; this copy serves the
// ScriptProcessor fallback and the tests.
export function createPcmResampler(inputRate, outputRate = TARGET_RATE) {
  const ratio = inputRate / outputRate
  let phase = 0
  let prev = null
  return (mono) => {
    const length = mono.length
    if (!length) return new Float32Array(0)
    if (ratio === 1) return mono
    const out = []
    let pos = phase
    while (pos + 1 <= length) {
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const a = i0 < 0 ? (prev === null ? mono[0] : prev) : mono[i0]
      const b = i0 + 1 < length ? mono[i0 + 1] : mono[length - 1]
      out.push(a + (b - a) * frac)
      pos += ratio
    }
    phase = pos - length
    prev = mono[length - 1]
    return Float32Array.from(out)
  }
}

export function mediaErrorReason(error) {
  const name = error?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'not-allowed'
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' || name === 'AbortError') return 'audio-capture'
  return 'audio-capture'
}

export function microphoneSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    && typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)
}
