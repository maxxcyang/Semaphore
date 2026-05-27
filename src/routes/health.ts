import { FastifyInstance } from 'fastify'
import { ParsedConfig } from '../config/schema'
import { getAllStates } from '../state/memory'

function formatWindowMs(windowMs: number): string {
  if (windowMs % 60000 === 0) return `${windowMs / 60000}m`
  if (windowMs % 1000 === 0) return `${windowMs / 1000}s`
  return `${windowMs}ms`
}

export async function healthRoutes(
  app: FastifyInstance,
  options: { config: ParsedConfig }
): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const states = getAllStates()
    const now = Date.now()

    const services: Record<string, unknown> = {}

    for (const [serviceName, state] of Object.entries(states)) {
      const policy = options.config.policies[serviceName]

      const requestWindow = state.requestWindow
      const total = requestWindow.length
      const failures = requestWindow.filter(r => r.failed).length
      const failureRate = total === 0
        ? '0%'
        : `${Math.round((failures / total) * 100)}%`

      const requestsLast60s = requestWindow.filter(
        r => r.timestamp > now - 60000
      ).length

      const serviceInfo: Record<string, unknown> = {
        circuit_breaker: state.circuitState,
        failure_rate: failureRate,
        requests_last_60s: requestsLast60s,
      }

      if (state.circuitState === 'open' && state.openedAt !== null) {
        serviceInfo['opened_at'] = new Date(state.openedAt).toISOString()
      }

      if (policy?.rate_limit) {
        serviceInfo['rate_limit'] = {
          current: state.rateLimitWindow.length,
          limit: policy.rate_limit.requests,
          window: formatWindowMs(policy.rate_limit.windowMs),
        }
      }

      services[serviceName] = serviceInfo
    }

    reply.send({ services })
  })
}
