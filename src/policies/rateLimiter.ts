import { getState, setState } from '../state/memory'
import { RateLimitConfig } from '../config/schema'

export function checkRateLimit(
  service: string,
  policy: RateLimitConfig,
  callerIp?: string
): boolean {
  const state = getState(service)
  const now = Date.now()

  // --- Global sliding window ---
  let globalFiltered: number[] | undefined
  if (policy.requests !== undefined && policy.windowMs !== undefined) {
    const windowStart = now - policy.windowMs
    globalFiltered = state.rateLimitWindow.filter(ts => ts > windowStart)
    if (globalFiltered.length >= policy.requests) {
      setState(service, { rateLimitWindow: globalFiltered })
      return false
    }
  }

  // --- Per-caller sliding window ---
  if (policy.perCaller && callerIp) {
    const { requests, windowMs } = policy.perCaller
    const windowStart = now - windowMs
    const callerWindow = (state.perCallerWindows.get(callerIp) ?? []).filter(ts => ts > windowStart)
    if (callerWindow.length >= requests) {
      if (globalFiltered !== undefined) {
        setState(service, { rateLimitWindow: globalFiltered })
      }
      state.perCallerWindows.set(callerIp, callerWindow)
      return false
    }
    callerWindow.push(now)
    state.perCallerWindows.set(callerIp, callerWindow)
  }

  // --- Both passed — record global timestamp ---
  if (globalFiltered !== undefined) {
    globalFiltered.push(now)
    setState(service, { rateLimitWindow: globalFiltered })
  }

  return true
}
