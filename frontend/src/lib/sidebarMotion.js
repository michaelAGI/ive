// Shared by the sidebar's drag handle and the app shell: slide the sidebar out
// to the left or back in, like a macOS source list. Reduced motion jumps.
export const SIDEBAR_EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
export const SIDEBAR_EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)'

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function requestTerminalRefit() {
  for (const delay of [0, 150, 350]) setTimeout(() => window.dispatchEvent(new Event('cc-terminal-refit')), delay)
}

// Slides `aside` between its place (shown) and fully off to the left (hidden).
// Returns the Animation, or null when motion is reduced (the end state is set).
export function slideSidebar(aside, { hidden, duration = 220, easing } = {}) {
  if (!aside) return null
  const width = aside.getBoundingClientRect().width || aside.offsetWidth || 0
  const off = { marginLeft: `${-width}px`, opacity: 0.35 }
  const on = { marginLeft: '0px', opacity: 1 }
  if (prefersReducedMotion() || typeof aside.animate !== 'function') {
    aside.style.marginLeft = hidden ? `${-width}px` : ''
    return null
  }
  return aside.animate(hidden ? [on, off] : [off, on], {
    duration, easing: easing || (hidden ? SIDEBAR_EASE_IN : SIDEBAR_EASE_OUT), fill: 'forwards',
  })
}
