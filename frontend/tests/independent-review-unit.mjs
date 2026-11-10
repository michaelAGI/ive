import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeIndependentReview, sendReviewRequest } from '../src/lib/independentReview.js'

test('new reviewers receive the composed source context unchanged', async () => {
  const calls = []
  const api = { composeReviewBrief: async args => { calls.push(args); return { brief: 'Original requirement\nIndependent review policy\nActual diff' } } }
  assert.equal(await composeIndependentReview(api, 'Actual diff', 'worker'), 'Original requirement\nIndependent review policy\nActual diff')
  assert.deepEqual(calls, [{ instructions: 'Actual diff', reviewed_session_id: 'worker' }])
})

test('failed or incomplete context prevents an independent review from starting', async () => {
  for (const composeReviewBrief of [async () => { throw new Error('offline') }, async () => ({}), async () => ({ brief: '  ' })]) {
    await assert.rejects(composeIndependentReview({ composeReviewBrief }, 'diff', 'worker'), /Could not prepare the original task/)
  }
})

test('explicit existing-conversation feedback can still be sent when enrichment fails', async () => {
  const api = { composeReviewBrief: async () => { throw new Error('offline') } }
  assert.equal(await composeIndependentReview(api, 'Please inspect this boundary case', 'worker', 'current'), 'Please inspect this boundary case')
})

test('a reviewer startup failure sends no input and is surfaced to setup', async () => {
  const sent = []
  await assert.rejects(sendReviewRequest({ store: { ensureSessionRunning: async () => false }, sessionId: 'new-reviewer', prompt: 'inspect', start: true, send: (...args) => sent.push(args) }), /reviewer could not start/)
  assert.deepEqual(sent, [])
})

test('a rejected queue submission is not reported as a started review', async () => {
  await assert.rejects(sendReviewRequest({ store: { ensureSessionRunning: async () => true }, sessionId: 'new-reviewer', prompt: 'inspect', start: true, send: () => false }), /Could not queue/)
})
