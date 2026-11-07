import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readContextWarnings, CONTEXT_WARNINGS_KEY } from '../src/state/contextWarnings.js'

const storage = (value) => ({ getItem: (key) => (key === CONTEXT_WARNINGS_KEY ? value : null) })

test('context warnings are on unless switched off', () => {
  assert.equal(readContextWarnings(storage(null)), true)
  assert.equal(readContextWarnings(storage('on')), true)
  assert.equal(readContextWarnings(storage('off')), false)
  assert.equal(readContextWarnings({ getItem() { throw new Error('blocked') } }), true)
})
