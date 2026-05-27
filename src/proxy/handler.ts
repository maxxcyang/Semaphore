import { ParsedConfig } from '../config/schema'
import { checkRateLimit } from '../policies/rateLimiter'
import { checkCircuit, recordCircuitOutcome } from '../policies/circuitBreaker'
import { executeWithRetry } from '../policies/retry'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
  'host',
])

function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
      result[k] = v
    }
  }
  return result
}

export async function handleProxyRequest(
  serviceName: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null,
  config: ParsedConfig
): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer | string }> {
  // 1. Look up policy
  const policy = config.policies[serviceName]
  if (!policy) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'service_not_found', service: serviceName }),
    }
  }

  // 2. Rate limit check
  if (policy.rate_limit) {
    const allowed = checkRateLimit(serviceName, policy.rate_limit)
    if (!allowed) {
      return {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'rate_limit_exceeded', service: serviceName }),
      }
    }
  }

  // 3. Circuit breaker check
  let circuitResult = { allowed: true, isTestRequest: false }
  if (policy.circuit_breaker) {
    circuitResult = checkCircuit(serviceName, policy.circuit_breaker)
    if (!circuitResult.allowed) {
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'circuit_breaker_open', service: serviceName }),
      }
    }
  }

  // 4. Build target URL
  const targetUrl = policy.target + path

  // 5. Strip hop-by-hop headers before forwarding
  const forwardHeaders = stripHopByHop(headers)

  // 6. Execute with retry
  const outcome = await executeWithRetry(
    targetUrl,
    method,
    forwardHeaders,
    body,
    policy.retry,
    policy.timeoutMs
  )

  // 7. Record circuit outcome
  if (policy.circuit_breaker) {
    const failed = outcome.allAttemptsFailed || outcome.timedOut
    recordCircuitOutcome(serviceName, policy.circuit_breaker, failed, circuitResult.isTestRequest)
  }

  // 8. Return response
  const rawResponseHeaders: Record<string, string> = {}
  outcome.response.headers.forEach((value, key) => {
    rawResponseHeaders[key] = value
  })
  const responseHeaders = stripHopByHop(rawResponseHeaders)

  const responseBuffer = Buffer.from(await outcome.response.arrayBuffer())

  return {
    statusCode: outcome.response.status,
    headers: responseHeaders,
    body: responseBuffer,
  }
}
