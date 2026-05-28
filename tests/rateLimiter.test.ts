import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkRateLimit } from '../src/policies/rateLimiter'
import type { RateLimitConfig } from '../src/config/schema'
import type { ServiceMemoryState } from '../src/state/memory'

// ---------------------------------------------------------------------------
// Mock ../src/state/memory
// ---------------------------------------------------------------------------
const mockGetState = vi.fn()
const mockSetState = vi.fn()

vi.mock('../src/state/memory', () => ({
  getState: (...args: unknown[]) => mockGetState(...args),
  setState: (...args: unknown[]) => mockSetState(...args),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeState(rateLimitWindow: number[], perCallerWindows = new Map<string, number[]>()): ServiceMemoryState {
  return {
    circuitState: 'closed',
    openedAt: null,
    testInFlight: false,
    requestWindow: [],
    rateLimitWindow,
    perCallerWindows,
  }
}

const policy: RateLimitConfig = { requests: 3, windowMs: 1000 }

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('checkRateLimit', () => {
  it('allows requests when under the limit', () => {
    mockGetState.mockReturnValue(makeState([Date.now() - 100, Date.now() - 200]))
    const allowed = checkRateLimit('svc', policy)
    expect(allowed).toBe(true)
    expect(mockSetState).toHaveBeenCalledOnce()
    const savedWindow: number[] = mockSetState.mock.calls[0][1].rateLimitWindow
    expect(savedWindow).toHaveLength(3)
  })

  it('rejects the request that would exceed the limit', () => {
    const now = Date.now()
    // Window already full (3 entries, all within windowMs)
    mockGetState.mockReturnValue(makeState([now - 100, now - 200, now - 300]))
    const allowed = checkRateLimit('svc', policy)
    expect(allowed).toBe(false)
    // setState is still called to persist the eviction result
    expect(mockSetState).toHaveBeenCalledOnce()
    const savedWindow: number[] = mockSetState.mock.calls[0][1].rateLimitWindow
    // No new entry should have been pushed
    expect(savedWindow).toHaveLength(3)
  })

  it('per-caller: allows when caller is under the per-caller limit', () => {
    const perCallerWindows = new Map([['1.2.3.4', [Date.now() - 100]]])
    mockGetState.mockReturnValue(makeState([], perCallerWindows))

    const perCallerPolicy: RateLimitConfig = { perCaller: { requests: 3, windowMs: 1000 } }
    const allowed = checkRateLimit('svc', perCallerPolicy, '1.2.3.4')

    expect(allowed).toBe(true)
    expect(perCallerWindows.get('1.2.3.4')).toHaveLength(2)
  })

  it('per-caller: rejects when caller is at the per-caller limit', () => {
    const now = Date.now()
    const perCallerWindows = new Map([['1.2.3.4', [now - 300, now - 200, now - 100]]])
    mockGetState.mockReturnValue(makeState([], perCallerWindows))

    const perCallerPolicy: RateLimitConfig = { perCaller: { requests: 3, windowMs: 1000 } }
    const allowed = checkRateLimit('svc', perCallerPolicy, '1.2.3.4')

    expect(allowed).toBe(false)
    expect(perCallerWindows.get('1.2.3.4')).toHaveLength(3)
  })

  it('per-caller: different callers have independent windows', () => {
    const now = Date.now()
    const perCallerWindows = new Map([['1.2.3.4', [now - 300, now - 200, now - 100]]])
    mockGetState.mockReturnValue(makeState([], perCallerWindows))

    const perCallerPolicy: RateLimitConfig = { perCaller: { requests: 3, windowMs: 1000 } }
    const allowed = checkRateLimit('svc', perCallerPolicy, '5.6.7.8')

    expect(allowed).toBe(true)
    expect(perCallerWindows.get('5.6.7.8')).toHaveLength(1)
  })

  it('global passes but per-caller rejects — returns false without recording global', () => {
    const now = Date.now()
    const perCallerWindows = new Map([['1.2.3.4', [now - 300, now - 200, now - 100]]])
    mockGetState.mockReturnValue(makeState([], perCallerWindows))

    const combinedPolicy: RateLimitConfig = {
      requests: 100,
      windowMs: 1000,
      perCaller: { requests: 3, windowMs: 1000 },
    }
    const allowed = checkRateLimit('svc', combinedPolicy, '1.2.3.4')

    expect(allowed).toBe(false)
    // Global window should have been saved (eviction) but without the new entry
    const savedGlobal: number[] = mockSetState.mock.calls[0][1].rateLimitWindow
    expect(savedGlobal).toHaveLength(0)
  })

  it('allows again after window slides (old timestamps evicted)', () => {
    const now = Date.now()
    // All 3 entries are older than windowMs (1000 ms) and should be evicted
    mockGetState.mockReturnValue(
      makeState([now - 2000, now - 1500, now - 1100])
    )
    const allowed = checkRateLimit('svc', policy)
    expect(allowed).toBe(true)
    const savedWindow: number[] = mockSetState.mock.calls[0][1].rateLimitWindow
    // Old ones evicted + 1 new entry
    expect(savedWindow).toHaveLength(1)
  })
})
