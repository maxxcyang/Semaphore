import { getState, setState } from '../state/memory'
import { RateLimitConfig } from '../config/schema'

export function checkRateLimit(service: string, policy: RateLimitConfig): boolean {
  const state = getState(service)
  const now = Date.now()

  // Evict entries outside the sliding window
  const windowStart = now - policy.windowMs
  const filtered = state.rateLimitWindow.filter(ts => ts > windowStart)

  // Reject if at or over the limit
  if (filtered.length >= policy.requests) {
    setState(service, { rateLimitWindow: filtered })
    return false
  }

  // Allow: record this request timestamp
  filtered.push(now)
  setState(service, { rateLimitWindow: filtered })
  return true
}
