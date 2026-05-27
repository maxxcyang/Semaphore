import { z } from 'zod'

export interface RetryConfig {
  attempts: number
  backoff: 'exponential' | 'fixed'
  jitter: boolean
  delayMs: number
  retryOn: number[]
}

export interface CircuitBreakerConfig {
  threshold: number   // 0–100, failure percentage
  windowMs: number    // rolling window in ms
  cooldownMs: number  // time to stay open before half-open in ms
}

export interface RateLimitConfig {
  requests: number
  windowMs: number
}

export interface ServicePolicy {
  target: string
  retry?: RetryConfig
  circuit_breaker?: CircuitBreakerConfig
  rate_limit?: RateLimitConfig
  timeoutMs?: number
}

export interface ParsedConfig {
  policies: Record<string, ServicePolicy>
}

function parseDuration(s: string): number {
  if (s.endsWith('ms')) {
    return parseInt(s.slice(0, -2), 10)
  } else if (s.endsWith('m')) {
    return parseInt(s.slice(0, -1), 10) * 60 * 1000
  } else if (s.endsWith('s')) {
    return parseInt(s.slice(0, -1), 10) * 1000
  }
  throw new Error(`Invalid duration string: "${s}". Expected format like "500ms", "5s", or "1m".`)
}

const durationStringSchema = z.string().transform((s, ctx) => {
  try {
    return parseDuration(s)
  } catch (e) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: (e as Error).message,
    })
    return z.NEVER
  }
})

const retryRawSchema = z.object({
  attempts: z.number().int().positive(),
  backoff: z.enum(['exponential', 'fixed']),
  jitter: z.boolean(),
  delay: durationStringSchema,
  retryOn: z.array(z.number().int()),
})

const circuitBreakerRawSchema = z.object({
  threshold: z.number().min(0).max(100),
  window: durationStringSchema,
  cooldown: durationStringSchema,
})

const rateLimitRawSchema = z.object({
  requests: z.number().int().positive(),
  window: durationStringSchema,
})

const servicePolicyRawSchema = z.object({
  target: z.string(),
  retry: retryRawSchema.optional(),
  circuit_breaker: circuitBreakerRawSchema.optional(),
  rate_limit: rateLimitRawSchema.optional(),
  timeout: durationStringSchema.optional(),
})

const rawConfigSchema = z.object({
  policies: z.record(z.string(), servicePolicyRawSchema),
})

export function validateConfig(raw: unknown): ParsedConfig {
  const result = rawConfigSchema.safeParse(raw)

  if (!result.success) {
    throw new Error(`Config validation failed: ${result.error.message}`)
  }

  const { policies: rawPolicies } = result.data

  const policies: Record<string, ServicePolicy> = {}

  for (const [name, rawPolicy] of Object.entries(rawPolicies)) {
    const policy: ServicePolicy = {
      target: rawPolicy.target,
    }

    if (rawPolicy.retry !== undefined) {
      policy.retry = {
        attempts: rawPolicy.retry.attempts,
        backoff: rawPolicy.retry.backoff,
        jitter: rawPolicy.retry.jitter,
        delayMs: rawPolicy.retry.delay,
        retryOn: rawPolicy.retry.retryOn,
      }
    }

    if (rawPolicy.circuit_breaker !== undefined) {
      policy.circuit_breaker = {
        threshold: rawPolicy.circuit_breaker.threshold,
        windowMs: rawPolicy.circuit_breaker.window,
        cooldownMs: rawPolicy.circuit_breaker.cooldown,
      }
    }

    if (rawPolicy.rate_limit !== undefined) {
      policy.rate_limit = {
        requests: rawPolicy.rate_limit.requests,
        windowMs: rawPolicy.rate_limit.window,
      }
    }

    if (rawPolicy.timeout !== undefined) {
      policy.timeoutMs = rawPolicy.timeout
    }

    policies[name] = policy
  }

  return { policies }
}
