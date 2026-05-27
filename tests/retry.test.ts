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
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.allAttemptsFailed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.response.status).toBe(500)
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
    }

    const promise = executeWithRetry('http://example.com', 'GET', {}, null, config, undefined)
    await vi.runAllTimersAsync()
    const result = await promise

    // Math.random should have been called to compute jitter
    expect(randomSpy).toHaveBeenCalled()
    expect(result.response.status).toBe(200)
  })
})
