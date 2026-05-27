import Fastify from 'fastify'
import { loadConfig } from './config/loader'
import { initDb, writePolicy } from './state/db'
import { initMemory } from './state/memory'
import { proxyRoutes } from './routes/proxy'
import { healthRoutes } from './routes/health'

async function start(): Promise<void> {
  const config = await loadConfig()

  initDb()
  for (const [name, policy] of Object.entries(config.policies)) {
    writePolicy(name, policy)
  }
  initMemory(config)

  const app = Fastify({ logger: true })

  // Parse all request bodies as Buffer (needed for replay on retries)
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  await app.register(proxyRoutes, { config })
  await app.register(healthRoutes, { config })

  const port = parseInt(process.env.PORT ?? '4000', 10)
  await app.listen({ port, host: '0.0.0.0' })
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})
