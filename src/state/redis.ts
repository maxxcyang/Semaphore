import Redis from 'ioredis'
import { CircuitState } from './db'

let client: Redis | null = null

export function initRedis(url: string): void {
  client = new Redis(url, { lazyConnect: true, enableReadyCheck: false })
  client.on('error', (err: Error) => console.error('[redis]', err.message))
}

export function hasRedis(): boolean {
  return client !== null
}

export interface SharedCircuitData {
  circuitState: CircuitState
  openedAt: number | null
}

export async function getSharedCircuitState(service: string): Promise<SharedCircuitData | null> {
  if (!client) return null
  try {
    const data = await client.hgetall(`semaphore:circuit:${service}`)
    if (!data?.circuitState) return null
    return {
      circuitState: data.circuitState as CircuitState,
      openedAt: data.openedAt ? parseInt(data.openedAt, 10) : null,
    }
  } catch (err) {
    console.error('[redis] getSharedCircuitState:', (err as Error).message)
    return null
  }
}

export async function setSharedCircuitState(
  service: string,
  circuitState: CircuitState,
  openedAt: number | null
): Promise<void> {
  if (!client) return
  try {
    await client.hset(`semaphore:circuit:${service}`, {
      circuitState,
      openedAt: openedAt !== null ? String(openedAt) : '',
    })
  } catch (err) {
    console.error('[redis] setSharedCircuitState:', (err as Error).message)
  }
}

// Returns true if this instance claimed the probe slot (SET NX).
// Uses a 30s TTL so the lock self-expires if the instance crashes mid-probe.
export async function claimTestInFlight(service: string): Promise<boolean> {
  if (!client) return false
  try {
    const result = await client.set(
      `semaphore:circuit:${service}:test_inflight`,
      '1',
      'EX',
      30,
      'NX'
    )
    return result === 'OK'
  } catch (err) {
    console.error('[redis] claimTestInFlight:', (err as Error).message)
    return false
  }
}

export async function clearTestInFlight(service: string): Promise<void> {
  if (!client) return
  try {
    await client.del(`semaphore:circuit:${service}:test_inflight`)
  } catch (err) {
    console.error('[redis] clearTestInFlight:', (err as Error).message)
  }
}
