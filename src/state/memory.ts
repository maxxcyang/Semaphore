import { CircuitState } from './db'
import { ParsedConfig } from '../config/schema'

export interface RequestRecord {
  timestamp: number
  failed: boolean
}

export interface ServiceMemoryState {
  circuitState: CircuitState
  openedAt: number | null
  testInFlight: boolean
  requestWindow: RequestRecord[]
  rateLimitWindow: number[]
}

const store = new Map<string, ServiceMemoryState>()

export function initMemory(config: ParsedConfig): void {
  store.clear()
  for (const name of Object.keys(config.policies)) {
    store.set(name, {
      circuitState: 'closed',
      openedAt: null,
      testInFlight: false,
      requestWindow: [],
      rateLimitWindow: [],
    })
  }
}

export function getState(service: string): ServiceMemoryState {
  const state = store.get(service)
  if (!state) {
    throw new Error(`Unknown service: ${service}`)
  }
  return state
}

export function setState(service: string, update: Partial<ServiceMemoryState>): void {
  const existing = store.get(service)
  if (!existing) {
    throw new Error(`Unknown service: ${service}`)
  }
  store.set(service, { ...existing, ...update })
}

export function getAllStates(): Record<string, ServiceMemoryState> {
  const result: Record<string, ServiceMemoryState> = {}
  for (const [name, state] of store.entries()) {
    result[name] = { ...state }
  }
  return result
}
