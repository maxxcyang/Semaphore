import * as fs from 'fs'
import * as path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { ServicePolicy } from '../config/schema'

export type CircuitState = 'closed' | 'open' | 'half-open'

let db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): void {
  const dbPath = process.env.DB_PATH ?? './data/semaphore.db'
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  db = new DatabaseSync(dbPath)

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS policies (
      service_name TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name TEXT NOT NULL,
      state TEXT NOT NULL,
      changed_at TEXT NOT NULL
    )
  `)
}

export function writePolicy(name: string, config: ServicePolicy): void {
  const now = new Date().toISOString()
  const stmt = getDb().prepare(`
    INSERT INTO policies (service_name, config, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(service_name) DO UPDATE SET
      config = excluded.config,
      updated_at = excluded.updated_at
  `)
  stmt.run(name, JSON.stringify(config), now)
}

export function appendCircuitLog(name: string, state: CircuitState): void {
  const now = new Date().toISOString()
  const stmt = getDb().prepare(`
    INSERT INTO circuit_breaker_log (service_name, state, changed_at)
    VALUES (?, ?, ?)
  `)
  stmt.run(name, state, now)
}
