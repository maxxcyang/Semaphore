import { RetryConfig } from '../config/schema'

export interface RetryOutcome {
  response: Response
  allAttemptsFailed: boolean
  timedOut: boolean
}

function syntheticTimeoutResponse(): Response {
  return new Response(JSON.stringify({ error: 'upstream_timeout' }), {
    status: 504,
    headers: { 'content-type': 'application/json' },
  })
}

function computeDelay(retryConfig: RetryConfig, attemptIndex: number): number {
  const base = retryConfig.delayMs ?? 100
  if (retryConfig.backoff === 'fixed') {
    return retryConfig.jitter ? Math.random() * base : base
  }
  // exponential
  const ceiling = Math.pow(2, attemptIndex) * base
  return retryConfig.jitter ? Math.random() * ceiling : ceiling
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function executeWithRetry(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  retryConfig: RetryConfig | undefined,
  timeoutMs: number | undefined
): Promise<RetryOutcome> {
  const maxAttempts = retryConfig?.attempts ?? 1
  const retryOn: number[] = retryConfig?.retryOn ?? []

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1

    // Set up per-attempt abort controller for timeout
    const controller = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    }

    try {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
      })

      clearTimeout(timeoutHandle)

      const is5xx = response.status >= 500 && response.status < 600
      const shouldRetry = retryOn.includes(response.status) && !isLastAttempt

      if (shouldRetry) {
        await sleep(computeDelay(retryConfig!, attempt))
        continue
      }

      return {
        response,
        allAttemptsFailed: is5xx,
        timedOut: false,
      }
    } catch (err: unknown) {
      clearTimeout(timeoutHandle)

      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')

      if (isAbort) {
        if (!isLastAttempt) {
          await sleep(computeDelay(retryConfig!, attempt))
          continue
        }
        return {
          response: syntheticTimeoutResponse(),
          allAttemptsFailed: true,
          timedOut: true,
        }
      }

      // Non-abort network error — treat as fatal on this attempt
      if (!isLastAttempt) {
        await sleep(computeDelay(retryConfig!, attempt))
        continue
      }
      throw err
    }
  }

  // Should be unreachable
  return {
    response: syntheticTimeoutResponse(),
    allAttemptsFailed: true,
    timedOut: true,
  }
}
