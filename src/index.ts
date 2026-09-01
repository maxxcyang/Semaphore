import Fastify from 'fastify'
import { loadConfig } from './config/loader'
import { initDb, writePolicy } from './state/db'
import { initMemory } from './state/memory'
import { initRedis } from './state/redis'
import { proxyRoutes } from './routes/proxy'
import { healthRoutes } from './routes/health'
import { closeKafka, initKafka } from './events/kafka'

async function start(): Promise<void> {
  const config = await loadConfig()

  const redisUrl = process.env.REDIS_URL
  if (redisUrl) {
    initRedis(redisUrl)
  }

  initDb()
  for (const [name, policy] of Object.entries(config.policies)) {
    writePolicy(name, policy)
  }
  initMemory(config)
  if (config.global?.kafka) {
    initKafka(config.global.kafka)
  }

  const app = Fastify({
    logger: true,
    ...(config.global?.maxBodySizeBytes !== undefined && { bodyLimit: config.global.maxBodySizeBytes }),
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error.statusCode === 413) {
      void reply.status(413).header('content-type', 'application/json').send(
        JSON.stringify({ error: 'request_too_large' })
      )
      return
    }
    void reply.status(error.statusCode ?? 500).send(error)
  })

  // Parse all request bodies as Buffer (needed for replay on retries)
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  await app.register(proxyRoutes, { config })
  await app.register(healthRoutes, { config })

  const port = parseInt(process.env.PORT ?? '4000', 10)
  const shutdown = async (): Promise<void> => {
    await app.close()
    await closeKafka()
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  await app.listen({ port, host: '0.0.0.0' })
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})
