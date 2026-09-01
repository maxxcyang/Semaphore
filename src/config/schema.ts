import { z } from 'zod'

export interface RetryConfig {
  attempts: number
  backoff: 'exponential' | 'fixed'
  jitter: boolean
  delayMs: number
  retryOn: number[]
  retryOnTimeout: boolean
  budgetMs?: number
}

export interface CircuitBreakerConfig {
  threshold: number   // 0–100, failure percentage
  windowMs: number    // rolling window in ms
  cooldownMs: number  // time to stay open before half-open in ms
}

export interface PerCallerRateLimitConfig {
  requests: number
  windowMs: number
}

export interface RateLimitConfig {
  requests?: number
  windowMs?: number
  perCaller?: PerCallerRateLimitConfig
}

export interface ServicePolicy {
  target: string
  failureOn?: number[]
  retry?: RetryConfig
  circuit_breaker?: CircuitBreakerConfig
  rate_limit?: RateLimitConfig
  timeoutMs?: number
}

export interface GlobalConfig {
  maxBodySizeBytes?: number
  kafka?: KafkaConfig
}

export interface KafkaConfig {
  brokers: string[]
  clientId: string
  topic: string
}

export interface ParsedConfig {
  global?: GlobalConfig
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

function parseBytes(s: string): number {
  const lower = s.toLowerCase()
  if (lower.endsWith('gb')) return parseFloat(lower) * 1024 * 1024 * 1024
  if (lower.endsWith('mb')) return parseFloat(lower) * 1024 * 1024
  if (lower.endsWith('kb')) return parseFloat(lower) * 1024
  if (lower.endsWith('b')) return parseFloat(lower)
  throw new Error(`Invalid byte size: "${s}". Expected format like "512kb", "10mb", "1gb".`)
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

const bytesStringSchema = z.string().transform((s, ctx) => {
  try {
    return parseBytes(s)
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
  retryOnTimeout: z.boolean().optional(),
  budget: durationStringSchema.optional(),
})

const circuitBreakerRawSchema = z.object({
  threshold: z.number().min(0).max(100),
  window: durationStringSchema,
  cooldown: durationStringSchema,
})

const perCallerRateLimitRawSchema = z.object({
  requests: z.number().int().positive(),
  window: durationStringSchema,
})

const rateLimitRawSchema = z.object({
  requests: z.number().int().positive().optional(),
  window: durationStringSchema.optional(),
  per_caller: perCallerRateLimitRawSchema.optional(),
}).refine(
  data => (data.requests !== undefined) === (data.window !== undefined),
  { message: 'rate_limit: requests and window must both be set together' }
).refine(
  data => data.requests !== undefined || data.per_caller !== undefined,
  { message: 'rate_limit must configure at least global (requests + window) or per_caller' }
)

const servicePolicyRawSchema = z.object({
  target: z.string(),
  failure_on: z.array(z.number().int()).optional(),
  retry: retryRawSchema.optional(),
  circuit_breaker: circuitBreakerRawSchema.optional(),
  rate_limit: rateLimitRawSchema.optional(),
  timeout: durationStringSchema.optional(),
})

const globalRawSchema = z.object({
  max_body_size: bytesStringSchema.optional(),
  kafka: z.object({
    brokers: z.array(z.string().min(1)).min(1),
    client_id: z.string().min(1).default('semaphore'),
    topic: z.string().min(1).default('semaphore.resilience-events'),
  }).optional(),
})

const rawConfigSchema = z.object({
  global: globalRawSchema.optional(),
  policies: z.record(z.string(), servicePolicyRawSchema),
})

export function validateConfig(raw: unknown): ParsedConfig {
  const result = rawConfigSchema.safeParse(raw)

  if (!result.success) {
    throw new Error(`Config validation failed: ${result.error.message}`)
  }

  const { global: rawGlobal, policies: rawPolicies } = result.data

  const global: GlobalConfig | undefined = rawGlobal
    ? {
        maxBodySizeBytes: rawGlobal.max_body_size,
        ...(rawGlobal.kafka !== undefined && {
          kafka: {
            brokers: rawGlobal.kafka.brokers,
            clientId: rawGlobal.kafka.client_id,
            topic: rawGlobal.kafka.topic,
          },
        }),
      }
    : undefined

  const policies: Record<string, ServicePolicy> = {}

  for (const [name, rawPolicy] of Object.entries(rawPolicies)) {
    const policy: ServicePolicy = {
      target: rawPolicy.target,
    }

    if (rawPolicy.failure_on !== undefined) {
      policy.failureOn = rawPolicy.failure_on
    }

    if (rawPolicy.retry !== undefined) {
      policy.retry = {
        attempts: rawPolicy.retry.attempts,
        backoff: rawPolicy.retry.backoff,
        jitter: rawPolicy.retry.jitter,
        delayMs: rawPolicy.retry.delay,
        retryOn: rawPolicy.retry.retryOn,
        retryOnTimeout: rawPolicy.retry.retryOnTimeout ?? true,
        budgetMs: rawPolicy.retry.budget,
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
        ...(rawPolicy.rate_limit.requests !== undefined && {
          requests: rawPolicy.rate_limit.requests,
          windowMs: rawPolicy.rate_limit.window!,
        }),
        ...(rawPolicy.rate_limit.per_caller !== undefined && {
          perCaller: {
            requests: rawPolicy.rate_limit.per_caller.requests,
            windowMs: rawPolicy.rate_limit.per_caller.window,
          },
        }),
      }
    }

    if (rawPolicy.timeout !== undefined) {
      policy.timeoutMs = rawPolicy.timeout
    }

    policies[name] = policy
  }

  return { global, policies }
}
