// node --test tests/dictation-unit.mjs
// PCM helpers of src/lib/dictation.js and the shared resampler contract with
// public/dictation-worklet.js (same algorithm, so the worklet is exercised here
// through a tiny AudioWorklet shim).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const { floatTo16BitPCM, createPcmResampler, mediaErrorReason } = await import('../src/lib/dictationAudio.js')

function sine(rate, seconds, hz = 440) {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

function interpReference(signal, ratio) {
  const out = []
  for (let pos = 0; pos + 1 <= signal.length; pos += ratio) {
    const i0 = Math.floor(pos)
    const a = signal[i0]
    const b = i0 + 1 < signal.length ? signal[i0 + 1] : signal[signal.length - 1]
    out.push(a + (b - a) * (pos - i0))
  }
  return out
}

test('floatTo16BitPCM clamps and scales', () => {
  const pcm = floatTo16BitPCM(Float32Array.from([-2, -1, 0, 0.5, 1, 2]))
  assert.deepEqual(Array.from(pcm), [-32768, -32768, 0, 16383, 32767, 32767])
})

test('resampler 48k → 16k is continuous across chunk borders', () => {
  const signal = sine(48000, 1)
  const resample = createPcmResampler(48000, 16000)
  const chunks = []
  for (let i = 0; i < signal.length; i += 1000) chunks.push(resample(signal.subarray(i, i + 1000)))
  const out = chunks.flatMap((c) => Array.from(c))
  const reference = interpReference(signal, 3)
  assert.equal(out.length, reference.length)
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - reference[i]) < 1e-5, `sample ${i}`)
})

test('resampler at equal rates passes samples through', () => {
  const resample = createPcmResampler(16000, 16000)
  const input = Float32Array.from([0.1, 0.2, 0.3])
  assert.equal(resample(input), input)
})

test('worklet processor produces the same stream as the lib resampler', () => {
  const source = readFileSync(join(here, '../public/dictation-worklet.js'), 'utf8')
  const posted = []
  const registry = {}
  const context = {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (buf) => posted.push(new Int16Array(buf)), onmessage: null } } },
    registerProcessor: (name, cls) => { registry[name] = cls },
  }
  vm.runInNewContext(source, context)
  const Processor = registry['ive-dictation-capture']
  assert.ok(Processor, 'processor registered')
  const processor = new Processor({ processorOptions: { inputRate: 48000, outputRate: 16000, frameSize: 160 } })
  const signal = sine(48000, 0.5)
  for (let i = 0; i < signal.length; i += 128) {
    const block = signal.subarray(i, Math.min(i + 128, signal.length))
    assert.equal(processor.process([[block]]), true)
  }
  processor.port.onmessage({ data: 'close' })
  const workletOut = posted.flatMap((frame) => Array.from(frame))
  const resample = createPcmResampler(48000, 16000)
  const libOut = []
  for (let i = 0; i < signal.length; i += 128) libOut.push(...floatTo16BitPCM(resample(signal.subarray(i, Math.min(i + 128, signal.length)))))
  assert.equal(workletOut.length, libOut.length)
  for (let i = 0; i < workletOut.length; i++) assert.ok(Math.abs(workletOut[i] - libOut[i]) <= 1, `sample ${i}`)
  assert.ok(posted.slice(0, -1).every((frame) => frame.length === 160), 'full frames before the flush')
  assert.equal(processor.process([[signal.subarray(0, 128)]]), false, 'closed processors stop')
})

test('media errors map to the Web Speech error vocabulary', () => {
  assert.equal(mediaErrorReason({ name: 'NotAllowedError' }), 'not-allowed')
  assert.equal(mediaErrorReason({ name: 'NotFoundError' }), 'audio-capture')
  assert.equal(mediaErrorReason(new Error('x')), 'audio-capture')
})
