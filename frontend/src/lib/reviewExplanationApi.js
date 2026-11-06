import { request } from './api'

export const reviewExplanationApi = {
  context: (target, signal) => request(`/review/explanation/context?${new URLSearchParams(target)}`, { signal }),
  ask: (data) => request('/review/explanation/ask', { method: 'POST', body: JSON.stringify(data), signal: AbortSignal.timeout(15000) }),
  get: (id) => request(`/review/explanation/requests/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) }),
  cancel: (id) => request(`/review/explanation/requests/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) }),
}
