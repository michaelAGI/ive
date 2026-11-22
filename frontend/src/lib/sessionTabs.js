// One order for the visible tab strip, its position labels and Cmd/Ctrl+1–9.
// A snapshot can briefly retain an archived/missing id while sessions reconcile.
export function getOpenTabIds({ openTabs = [], sessions = {} } = {}) {
  return [...new Set(openTabs)].filter((id) => sessions[id] && !sessions[id].archived)
}

// Resolve identities at drop time: a tab may have closed or opened during a drag.
// Never insert an undefined/closed tab or move a different tab at an old index.
export function moveOpenTab(openTabs, fromId, toId, position = 'before') {
  if (fromId === toId || !openTabs.includes(fromId) || !openTabs.includes(toId)
      || !['before', 'after'].includes(position)) return openTabs
  const next = openTabs.filter((id) => id !== fromId)
  const index = next.indexOf(toId) + (position === 'after' ? 1 : 0)
  next.splice(index, 0, fromId)
  return next.every((id, i) => id === openTabs[i]) ? openTabs : next
}
