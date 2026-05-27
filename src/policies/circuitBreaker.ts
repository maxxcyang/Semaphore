import { getState, setState } from '../state/memory'
import { appendCircuitLog } from '../state/db'
import { CircuitBreakerConfig } from '../config/schema'

export interface CircuitCheckResult {
  allowed: boolean
  isTestRequest: boolean
}

export function checkCircuit(service: string, policy?: CircuitBreakerConfig): CircuitCheckResult {
  const state = getState(service)

  if (state.circuitState === 'closed') {
    return { allowed: true, isTestRequest: false }
  }

  if (state.circuitState === 'open') {
    if (!policy || (Date.now() - state.openedAt!) < policy.cooldownMs) {
      return { allowed: false, isTestRequest: false }
    }

    // Cooldown has expired — transition to half-open
    setState(service, { circuitState: 'half-open', testInFlight: false })
    // Fall through to half-open logic below
  }

  // half-open state (either arrived here naturally or just transitioned)
  const freshState = getState(service)
  if (freshState.testInFlight) {
    return { allowed: false, isTestRequest: false }
  }

  setState(service, { testInFlight: true })
  return { allowed: true, isTestRequest: true }
}

export function recordCircuitOutcome(
  service: string,
  policy: CircuitBreakerConfig,
  failed: boolean,
  isTestRequest: boolean
): void {
  const state = getState(service)
  const now = Date.now()

  // Evict entries outside the rolling window
  const windowStart = now - policy.windowMs
  const updatedWindow = state.requestWindow.filter(r => r.timestamp > windowStart)

  // Record this outcome
  updatedWindow.push({ timestamp: now, failed })
  setState(service, { requestWindow: updatedWindow })

  if (isTestRequest) {
    if (!failed) {
      // Test probe succeeded — close the circuit
      setState(service, {
        circuitState: 'closed',
        openedAt: null,
        testInFlight: false,
      })
      appendCircuitLog(service, 'closed')
    } else {
      // Test probe failed — reopen the circuit
      setState(service, {
        circuitState: 'open',
        openedAt: now,
        testInFlight: false,
      })
      appendCircuitLog(service, 'open')
    }
    return
  }

  // Normal request: check whether failure rate crosses threshold
  const currentState = getState(service)
  if (currentState.circuitState === 'closed') {
    const total = updatedWindow.length
    const failures = updatedWindow.filter(r => r.failed).length
    if (total >= 1 && (failures / total) * 100 >= policy.threshold) {
      setState(service, { circuitState: 'open', openedAt: now })
      appendCircuitLog(service, 'open')
    }
  }
}
