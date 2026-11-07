// HTTP snapshots can arrive after newer WebSocket events, or out of request
// order. Keep their causal context outside JSON/store data (no React renders).
const live = new Map()
const applied = new Map()
const context = new WeakMap()
let sequence = 0

export function touchSession(id) {
  if (id) live.set(id, (live.get(id) || 0) + 1)
}

export function beginSessionSnapshot() {
  return { sequence: ++sequence, live: new Map(live) }
}

export function tagSessionSnapshot(value, stamp) {
  if (value && typeof value === 'object') {
    context.set(value, stamp)
    if (Array.isArray(value)) for (const row of value) {
      if (row && typeof row === 'object') context.set(row, stamp)
    }
  }
  return value
}

export function staleSessionSnapshot(value, id = value?.id) {
  const stamp = context.get(value)
  return !!stamp && ((stamp.live.get(id) || 0) !== (live.get(id) || 0)
    || stamp.sequence < (applied.get(id) || 0))
}

export function acceptSessionSnapshot(value, id = value?.id) {
  const stamp = context.get(value)
  if (stamp) applied.set(id, Math.max(stamp.sequence, applied.get(id) || 0))
  else touchSession(id)
}
