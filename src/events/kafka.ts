import { Kafka, logLevel, Producer } from 'kafkajs'
import { KafkaConfig } from '../config/schema'

export interface ResilienceEvent {
  type: string
  service: string
  timestamp?: string
  requestId?: string
  details?: Record<string, unknown>
}

let producer: Producer | null = null
let topic: string | null = null
let connected = false
let connecting = false

function connect(): void {
  if (!producer || connected || connecting) return

  connecting = true
  void producer.connect()
    .then(() => {
      connected = true
      console.info('[kafka] connected')
    })
    .catch((err: Error) => {
      // Kafka is telemetry only. A broker outage must not affect proxy traffic.
      console.error('[kafka] connect:', err.message)
    })
    .finally(() => {
      connecting = false
    })
}

export function initKafka(config: KafkaConfig): void {
  const kafka = new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    logLevel: logLevel.NOTHING,
  })
  producer = kafka.producer({ allowAutoTopicCreation: false })
  topic = config.topic
  connect()
}

/** Publish without waiting: observability must never add request latency. */
export function publishResilienceEvent(event: ResilienceEvent): void {
  if (!producer || !topic) return
  if (!connected) {
    connect()
    return
  }

  const message = JSON.stringify({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  })

  void producer.send({ topic, messages: [{ value: message }] }).catch((err: Error) => {
    connected = false
    console.error('[kafka] publish:', err.message)
    connect()
  })
}

export async function closeKafka(): Promise<void> {
  if (!producer) return
  try {
    await producer.disconnect()
  } catch (err) {
    console.error('[kafka] disconnect:', (err as Error).message)
  } finally {
    producer = null
    topic = null
    connected = false
    connecting = false
  }
}
