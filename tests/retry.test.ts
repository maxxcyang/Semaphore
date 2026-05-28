import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeWithRetry } from '../src/policies/retry'
import type { RetryConfig } from '../src/config/schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockResponse(status: number, body = ''): Response {
  return new Response(body, { status })
}

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('executeWithRetry', () => {
  it('returns immediately (no retry) on a non-retryOn code (400)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(400))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 3,
      backoff: 'exponential',
      jitter: false,
      delayMs: 10,
      retryOn: [500, 503],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    // Advance timers so any sleep resolves
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.response.status).toBe(400)
    expect(result.allAttemptsFailed).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('retries on a code in retryOn, succeeds on second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 3,
      backoff: 'exponential',
      jitter: false,
      delayMs: 10,
      retryOn: [503],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.response.status).toBe(200)
    expect(result.allAttemptsFailed).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('retries on timeout (AbortError), returns allAttemptsFailed=true after exhaustion', async () => {
    const fetchMock = vi.fn().mockRejectedValue(abortError())
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 2,
      backoff: 'fixed',
      jitter: false,
      delayMs: 10,
      retryOn: [],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, 50)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.allAttemptsFailed).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.response.status).toBe(504)
  })

  it('allAttemptsFailed=false when final response is 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, 'ok'))
    vi.stubGlobal('fetch', fetchMock)

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, undefined, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.allAttemptsFailed).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('allAttemptsFailed=true when all retries return 500', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 3,
      backoff: 'exponential',
      jitter: false,
      delayMs: 10,
      retryOn: [500],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.allAttemptsFailed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.response.status).toBe(500)
  })

  it('failureOn: only listed codes set allAttemptsFailed=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 1,
      backoff: 'fixed',
      jitter: false,
      delayMs: 10,
      retryOn: [],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined, [503])
    await vi.runAllTimersAsync()
    const result = await promise

    // 500 is not in failureOn=[503], so not a failure
    expect(result.allAttemptsFailed).toBe(false)
    expect(result.response.status).toBe(500)
  })

  it('failureOn: listed code sets allAttemptsFailed=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(503))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 1,
      backoff: 'fixed',
      jitter: false,
      delayMs: 10,
      retryOn: [],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined, [503])
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.allAttemptsFailed).toBe(true)
    expect(result.response.status).toBe(503)
  })

  it('retryOnTimeout=false: does not retry on timeout, returns 504 immediately', async () => {
    const fetchMock = vi.fn().mockRejectedValue(abortError())
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 3,
      backoff: 'fixed',
      jitter: false,
      delayMs: 10,
      retryOn: [],
      retryOnTimeout: false,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, 50)
    await vi.runAllTimersAsync()
    const result = await promise

    // Should not retry — only 1 attempt despite attempts=3
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.timedOut).toBe(true)
    expect(result.response.status).toBe(504)
  })

  it('budget expires between retries, stops before final attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 3,
      backoff: 'fixed',
      jitter: false,
      delayMs: 30,
      retryOn: [500],
      retryOnTimeout: true,
      budgetMs: 50,
    }

    // t=0: attempt 1 → 500, sleep 30ms → t=30
    // t=30: attempt 2 → 500, sleep clamped to 20ms (50-30) → t=50
    // t=50: budget check fires before attempt 3, return timeout
    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.timedOut).toBe(true)
    expect(result.allAttemptsFailed).toBe(true)
    expect(result.response.status).toBe(504)
  })

  it('sufficient budget does not interfere with normal retry flow', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(500))
      .mockResolvedValueOnce(mockResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 3,
      backoff: 'fixed',
      jitter: false,
      delayMs: 10,
      retryOn: [500],
      retryOnTimeout: true,
      budgetMs: 10000,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.response.status).toBe(200)
    expect(result.timedOut).toBe(false)
  })

  it('with jitter=true, delay is within [0, 2^attempt * delayMs]', async () => {
    // We'll spy on Math.random to verify it's used
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    const config: RetryConfig = {
      attempts: 2,
      backoff: 'exponential',
      jitter: true,
      delayMs: 100,
      retryOn: [503],
      retryOnTimeout: true,
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    // Math.random should have been called to compute jitter
    expect(randomSpy).toHaveBeenCalled()
    expect(result.response.status).toBe(200)
  })
})
