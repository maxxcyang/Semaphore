import { FastifyInstance } from 'fastify'
import { ParsedConfig } from '../config/schema'
import { handleProxyRequest } from '../proxy/handler'

export async function proxyRoutes(
  app: FastifyInstance,
  options: { config: ParsedConfig }
): Promise<void> {
  app.all('/proxy/:service/*', async (request, reply) => {
    // Extract service name and wildcard path
    const params = request.params as { service: string; '*': string }
    const serviceName = params.service
    const path = '/' + params['*']   // ensure leading slash

    // Extract headers as plain object (strip undefined values)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === 'string') headers[k] = v
    }

    // Body is already a Buffer from the content type parser registered in index.ts
    const body = (request.body as Buffer | null) ?? null

    const result = await handleProxyRequest(
      serviceName,
      request.method,
      path,
      headers,
      body,
      options.config,
      request.ip
    )

    reply.status(result.statusCode)
    for (const [k, v] of Object.entries(result.headers)) {
      reply.header(k, v)
    }
    reply.send(result.body)
  })
}
