import assert from 'node:assert/strict'
import test from 'node:test'
import { getOpenTabIds, moveOpenTab } from '../src/lib/sessionTabs.js'

test('positions only count the live tabs that the user can see', () => {
  const state = {
    openTabs: ['missing', 'old', 'b', 'a', 'b'],
    sessions: { old: { archived: 1 }, a: { archived: 0 }, b: {} },
  }
  assert.deepEqual(getOpenTabIds(state), ['b', 'a'])
  state.sessions.b.archived = 1
  assert.deepEqual(getOpenTabIds(state), ['a'])
  state.openTabs.push('c')
  state.sessions.c = {}
  assert.deepEqual(getOpenTabIds(state), ['a', 'c'])
})

test('drag uses identities after a preceding tab closes or a new one opens', () => {
  const beforeDrag = ['a', 'b', 'c', 'd']
  const whileDragging = ['b', 'c', 'd', 'e']
  assert.deepEqual(moveOpenTab(whileDragging, 'd', 'b', 'before'), ['d', 'b', 'c', 'e'])
  assert.deepEqual(beforeDrag, ['a', 'b', 'c', 'd'])
  assert.deepEqual(whileDragging, ['b', 'c', 'd', 'e'])
})

test('both drop edges and both directions preserve every other tab', () => {
  const tabs = ['a', 'hidden', 'b', 'c']
  assert.deepEqual(moveOpenTab(tabs, 'a', 'b', 'after'), ['hidden', 'b', 'a', 'c'])
  assert.deepEqual(moveOpenTab(tabs, 'c', 'b', 'before'), ['a', 'hidden', 'c', 'b'])
})

test('closing a drag source or destination cancels the move', () => {
  const tabs = ['a', 'b']
  assert.equal(moveOpenTab(tabs, 'closed', 'b'), tabs)
  assert.equal(moveOpenTab(tabs, 'a', 'closed'), tabs)
  assert.equal(moveOpenTab(tabs, 'a', 'a'), tabs)
  assert.equal(moveOpenTab(tabs, 'a', 'b', 'unknown'), tabs)
  assert.equal(moveOpenTab(tabs, 'a', 'b', 'before'), tabs)
})
