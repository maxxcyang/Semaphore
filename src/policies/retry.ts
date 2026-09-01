import { RetryConfig } from '../config/schema'

export interface RetryOutcome {
  response: Response
  allAttemptsFailed: boolean
  timedOut: boolean
}

export interface RetryScheduledEvent {
  attempt: number
  nextAttempt: number
  reason: 'status' | 'timeout' | 'network_error'
  statusCode?: number
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

function sleepUntilBudget(ms: number, budgetDeadline: number | undefined): Promise<void> {
  const clamped = budgetDeadline !== undefined
    ? Math.min(ms, Math.max(0, budgetDeadline - Date.now()))
    : ms
  return sleep(clamped)
}

export async function executeWithRetry(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  retryConfig: RetryConfig | undefined,
  timeoutMs: number | undefined,
  failureOn?: number[],
  onRetry?: (event: RetryScheduledEvent) => void
): Promise<RetryOutcome> {
  const maxAttempts = retryConfig?.attempts ?? 1
  const retryOn: number[] = retryConfig?.retryOn ?? []
  const retryOnTimeout = retryConfig?.retryOnTimeout ?? true
  const budgetDeadline = retryConfig?.budgetMs !== undefined
    ? Date.now() + retryConfig.budgetMs
    : undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (budgetDeadline !== undefined && Date.now() >= budgetDeadline) {
      return {
        response: syntheticTimeoutResponse(),
        allAttemptsFailed: true,
        timedOut: true,
      }
    }

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

      const isFailed = failureOn && failureOn.length > 0
        ? failureOn.includes(response.status)
        : response.status >= 500 && response.status < 600
      const shouldRetry = retryOn.includes(response.status) && !isLastAttempt

      if (shouldRetry) {
        onRetry?.({ attempt: attempt + 1, nextAttempt: attempt + 2, reason: 'status', statusCode: response.status })
        await sleepUntilBudget(computeDelay(retryConfig!, attempt), budgetDeadline)
        continue
      }

      return {
        response,
        allAttemptsFailed: isFailed,
        timedOut: false,
      }
    } catch (err: unknown) {
      clearTimeout(timeoutHandle)

      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')

      if (isAbort) {
        if (!isLastAttempt && retryOnTimeout) {
          onRetry?.({ attempt: attempt + 1, nextAttempt: attempt + 2, reason: 'timeout' })
          await sleepUntilBudget(computeDelay(retryConfig!, attempt), budgetDeadline)
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
        onRetry?.({ attempt: attempt + 1, nextAttempt: attempt + 2, reason: 'network_error' })
        await sleepUntilBudget(computeDelay(retryConfig!, attempt), budgetDeadline)
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
