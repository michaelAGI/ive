// AudioWorklet for on-device dictation: mono, 16 kHz, int16 frames to the main thread.
// Loaded from /dictation-worklet.js by src/lib/dictation.js. Standalone on purpose:
// worklets cannot import from the app bundle. The resampler mirrors
// createPcmResampler() in src/lib/dictation.js (tested there).
class IveDictationCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const settings = (options && options.processorOptions) || {}
    this.inputRate = settings.inputRate || sampleRate
    this.outputRate = settings.outputRate || 16000
    this.frameSize = settings.frameSize || 2560 // 160 ms at 16 kHz
    this.ratio = this.inputRate / this.outputRate
    this.phase = 0
    this.prev = null
    this.frame = new Int16Array(this.frameSize)
    this.fill = 0
    this.closed = false
    this.port.onmessage = (event) => {
      if (event.data === 'close') {
        this.flush()
        this.closed = true
      }
    }
  }

  push(sample) {
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
    this.frame[this.fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    if (this.fill === this.frameSize) this.flush()
  }

  flush() {
    if (!this.fill) return
    const out = this.frame.slice(0, this.fill)
    this.port.postMessage(out.buffer, [out.buffer])
    this.fill = 0
  }

  process(inputs) {
    if (this.closed) return false
    const channels = inputs[0]
    if (!channels || !channels.length || !channels[0].length) return true
    const length = channels[0].length
    let mono = channels[0]
    if (channels.length > 1) {
      mono = new Float32Array(length)
      for (let c = 0; c < channels.length; c++) {
        const data = channels[c]
        for (let i = 0; i < length; i++) mono[i] += data[i] / channels.length
      }
    }
    if (this.ratio === 1) {
      for (let i = 0; i < length; i++) this.push(mono[i])
      return true
    }
    // Linear interpolation; index -1 is the last sample of the previous block.
    let pos = this.phase
    while (pos + 1 <= length) {
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const a = i0 < 0 ? (this.prev === null ? mono[0] : this.prev) : mono[i0]
      const b = i0 + 1 < length ? mono[i0 + 1] : mono[length - 1]
      this.push(a + (b - a) * frac)
      pos += this.ratio
    }
    this.phase = pos - length
    this.prev = mono[length - 1]
    return true
  }
}

registerProcessor('ive-dictation-capture', IveDictationCapture)
