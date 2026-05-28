import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkCircuit, recordCircuitOutcome } from '../src/policies/circuitBreaker'
import type { CircuitBreakerConfig } from '../src/config/schema'
import type { ServiceMemoryState } from '../src/state/memory'
import type { CircuitState } from '../src/state/db'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockGetState = vi.fn()
const mockSetState = vi.fn()
const mockAppendCircuitLog = vi.fn()

vi.mock('../src/state/memory', () => ({
  getState: (...args: unknown[]) => mockGetState(...args),
  setState: (...args: unknown[]) => mockSetState(...args),
}))

vi.mock('../src/state/db', () => ({
  appendCircuitLog: (...args: unknown[]) => mockAppendCircuitLog(...args),
}))

vi.mock('../src/state/redis', () => ({
  hasRedis: () => false,
  getSharedCircuitState: vi.fn(),
  setSharedCircuitState: vi.fn(),
  claimTestInFlight: vi.fn(),
  clearTestInFlight: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeState(overrides: Partial<ServiceMemoryState> = {}): ServiceMemoryState {
  return {
    circuitState: 'closed',
    openedAt: null,
    testInFlight: false,
    requestWindow: [],
    rateLimitWindow: [],
    perCallerWindows: new Map(),
    ...overrides,
  }
}

const policy: CircuitBreakerConfig = {
  threshold: 50,  // 50% failure rate opens the circuit
  windowMs: 5000,
  cooldownMs: 1000,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// checkCircuit
// ---------------------------------------------------------------------------
describe('checkCircuit', () => {
  it('returns allowed=true when circuit is closed', async () => {
    mockGetState.mockReturnValue(makeState({ circuitState: 'closed' }))
    const result = await checkCircuit('svc', policy)
    expect(result).toEqual({ allowed: true, isTestRequest: false })
  })

  it('returns allowed=false when circuit is open and cooldown not expired', async () => {
    mockGetState.mockReturnValue(
      makeState({ circuitState: 'open', openedAt: Date.now() - 100 })
    )
    const result = await checkCircuit('svc', policy) // cooldownMs=1000, only 100ms elapsed
    expect(result).toEqual({ allowed: false, isTestRequest: false })
  })

  it('transitions to half-open after cooldown expires', async () => {
    // After transition setState is called; subsequent getState should return half-open
    mockGetState
      .mockReturnValueOnce(
        makeState({ circuitState: 'open', openedAt: Date.now() - 2000 })
      )
      .mockReturnValueOnce(
        makeState({ circuitState: 'half-open', testInFlight: false })
      )

    const result = await checkCircuit('svc', policy)
    // Should have transitioned to half-open and returned the probe request
    expect(mockSetState).toHaveBeenCalledWith('svc', {
      circuitState: 'half-open',
      testInFlight: false,
    })
    expect(result.allowed).toBe(true)
    expect(result.isTestRequest).toBe(true)
  })

  it('in half-open: first checkCircuit returns isTestRequest=true', async () => {
    mockGetState
      .mockReturnValueOnce(makeState({ circuitState: 'half-open', testInFlight: false }))
      .mockReturnValueOnce(makeState({ circuitState: 'half-open', testInFlight: false }))

    const result = await checkCircuit('svc', policy)
    expect(result).toEqual({ allowed: true, isTestRequest: true })
    expect(mockSetState).toHaveBeenCalledWith('svc', { testInFlight: true })
  })

  it('in half-open: concurrent checkCircuit (testInFlight=true) returns allowed=false', async () => {
    mockGetState
      .mockReturnValueOnce(makeState({ circuitState: 'half-open', testInFlight: true }))
      .mockReturnValueOnce(makeState({ circuitState: 'half-open', testInFlight: true }))

    const result = await checkCircuit('svc', policy)
    expect(result).toEqual({ allowed: false, isTestRequest: false })
  })
})

// ---------------------------------------------------------------------------
// recordCircuitOutcome
// ---------------------------------------------------------------------------
describe('recordCircuitOutcome', () => {
  it('after enough failures crosses threshold, circuit opens', async () => {
    // 2 prior failures, 2 totals => 100% failure rate, threshold=50
    const now = Date.now()
    mockGetState
      .mockReturnValueOnce(
        makeState({
          circuitState: 'closed',
          requestWindow: [
            { timestamp: now - 100, failed: true },
            { timestamp: now - 200, failed: true },
          ],
        })
      )
      .mockReturnValueOnce(
        makeState({
          circuitState: 'closed',
          requestWindow: [
            { timestamp: now - 100, failed: true },
            { timestamp: now - 200, failed: true },
            { timestamp: now, failed: true },
          ],
        })
      )

    await recordCircuitOutcome('svc', policy, true, false)

    const openCall = mockSetState.mock.calls.find(
      (c) => c[1].circuitState === 'open'
    )
    expect(openCall).toBeDefined()
    expect(mockAppendCircuitLog).toHaveBeenCalledWith('svc', 'open')
  })

  it('test success closes the circuit', async () => {
    mockGetState.mockReturnValue(
      makeState({ circuitState: 'half-open', testInFlight: true })
    )

    await recordCircuitOutcome('svc', policy, false, true)

    expect(mockSetState).toHaveBeenCalledWith('svc', {
      circuitState: 'closed',
      openedAt: null,
      testInFlight: false,
    })
    expect(mockAppendCircuitLog).toHaveBeenCalledWith('svc', 'closed')
  })

  it('test failure reopens the circuit', async () => {
    mockGetState.mockReturnValue(
      makeState({ circuitState: 'half-open', testInFlight: true, openedAt: Date.now() - 2000 })
    )

    await recordCircuitOutcome('svc', policy, true, true)

    const reopenCall = mockSetState.mock.calls.find(
      (c) => c[1].circuitState === 'open'
    )
    expect(reopenCall).toBeDefined()
    expect(reopenCall![1].testInFlight).toBe(false)
    expect(mockAppendCircuitLog).toHaveBeenCalledWith('svc', 'open')
  })
})
