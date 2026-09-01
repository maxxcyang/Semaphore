import { getState, setState } from '../state/memory'
import { appendCircuitLog, CircuitState } from '../state/db'
import { CircuitBreakerConfig } from '../config/schema'
import {
  hasRedis,
  getSharedCircuitState,
  setSharedCircuitState,
  claimTestInFlight,
  clearTestInFlight,
} from '../state/redis'
import { publishResilienceEvent } from '../events/kafka'

export interface CircuitCheckResult {
  allowed: boolean
  isTestRequest: boolean
}

export async function checkCircuit(
  service: string,
  policy?: CircuitBreakerConfig
): Promise<CircuitCheckResult> {
  const redis = hasRedis()

  let circuitState: CircuitState
  let openedAt: number | null

  if (redis) {
    const shared = await getSharedCircuitState(service)
    circuitState = shared?.circuitState ?? 'closed'
    openedAt = shared?.openedAt ?? null
  } else {
    const state = getState(service)
    circuitState = state.circuitState
    openedAt = state.openedAt
  }

  if (circuitState === 'closed') {
    return { allowed: true, isTestRequest: false }
  }

  if (circuitState === 'open') {
    if (!policy || (Date.now() - openedAt!) < policy.cooldownMs) {
      return { allowed: false, isTestRequest: false }
    }
    // Cooldown expired — transition to half-open
    if (redis) {
      await setSharedCircuitState(service, 'half-open', openedAt)
    } else {
      setState(service, { circuitState: 'half-open', testInFlight: false })
    }
    circuitState = 'half-open'
  }

  // half-open: one instance claims the probe slot
  if (redis) {
    const claimed = await claimTestInFlight(service)
    if (!claimed) {
      return { allowed: false, isTestRequest: false }
    }
    return { allowed: true, isTestRequest: true }
  } else {
    const freshState = getState(service)
    if (freshState.testInFlight) {
      return { allowed: false, isTestRequest: false }
    }
    setState(service, { testInFlight: true })
    return { allowed: true, isTestRequest: true }
  }
}

export async function recordCircuitOutcome(
  service: string,
  policy: CircuitBreakerConfig,
  failed: boolean,
  isTestRequest: boolean
): Promise<void> {
  const state = getState(service)
  const now = Date.now()
  const redis = hasRedis()

  // Rolling failure window is always local
  const windowStart = now - policy.windowMs
  const updatedWindow = state.requestWindow.filter(r => r.timestamp > windowStart)
  updatedWindow.push({ timestamp: now, failed })
  setState(service, { requestWindow: updatedWindow })

  if (isTestRequest) {
    if (!failed) {
      if (redis) {
        await setSharedCircuitState(service, 'closed', null)
        await clearTestInFlight(service)
      } else {
        setState(service, { circuitState: 'closed', openedAt: null, testInFlight: false })
      }
      appendCircuitLog(service, 'closed')
      publishResilienceEvent({ type: 'circuit.closed', service })
    } else {
      if (redis) {
        await setSharedCircuitState(service, 'open', now)
        await clearTestInFlight(service)
      } else {
        setState(service, { circuitState: 'open', openedAt: now, testInFlight: false })
      }
      appendCircuitLog(service, 'open')
      publishResilienceEvent({ type: 'circuit.opened', service, details: { reason: 'half_open_probe_failed' } })
    }
    return
  }

  // Normal request: check failure rate against threshold
  let currentCircuitState: CircuitState
  if (redis) {
    const shared = await getSharedCircuitState(service)
    currentCircuitState = shared?.circuitState ?? 'closed'
  } else {
    currentCircuitState = getState(service).circuitState
  }

  if (currentCircuitState === 'closed') {
    const total = updatedWindow.length
    const failures = updatedWindow.filter(r => r.failed).length
    if (total >= 1 && (failures / total) * 100 >= policy.threshold) {
      if (redis) {
        await setSharedCircuitState(service, 'open', now)
      } else {
        setState(service, { circuitState: 'open', openedAt: now })
      }
      appendCircuitLog(service, 'open')
      publishResilienceEvent({
        type: 'circuit.opened',
        service,
        details: { failureRate: (failures / total) * 100, failures, total },
      })
    }
  }
}
