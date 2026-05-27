# Semaphore — Claude Code Guide

## What this project is

Semaphore is a resilience sidecar proxy written in TypeScript (Node.js + Fastify). It intercepts HTTP requests and applies retry, circuit breaking, rate limiting, and timeout policies configured in `resilience.yaml`. It has no external service dependencies — SQLite is the only persistence layer.

## Key commands

```bash
npm run dev          # run with ts-node — no build step, use during development
npm test             # Vitest unit tests
npm run build        # compile TypeScript → dist/
npm start            # run compiled dist/index.js

docker-compose up    # full stack: sidecar on :4000 + mock-service on :3001
```

## Project structure

```
src/
  index.ts                  # entry point — wires Fastify, config, DB, routes
  config/
    loader.ts               # reads CONFIG_PATH, parses YAML, validates with Zod; exits on error
    schema.ts               # Zod schema + TypeScript types (ServicePolicy, RetryConfig, etc.)
  policies/
    retry.ts                # exponential/fixed backoff with optional jitter; per-attempt timeout
    circuitBreaker.ts       # three-state machine (closed/open/half-open); rolling failure window
    rateLimiter.ts          # sliding window counter per service
  proxy/
    handler.ts              # request pipeline: rate limit → circuit check → forward → record
  routes/
    proxy.ts                # Fastify route: ANY /proxy/:service/*
    health.ts               # Fastify route: GET /health
  state/
    memory.ts               # in-memory store keyed by service name (hot path)
    db.ts                   # SQLite: policies table + circuit_breaker_log audit table

tests/
  circuitBreaker.test.ts
  rateLimiter.test.ts
  retry.test.ts

mock-service/
  server.js                 # minimal echo server on port 3000 (used in docker-compose)
```

## Architecture

**Request flow** (`src/proxy/handler.ts`):
1. Look up service policy by name
2. Rate limit check → `429` if exceeded
3. Circuit breaker check → `503` if open
4. Forward request to `policy.target` URL; buffer body upfront to enable retry replay
5. Retry on 5xx or timeout with backoff+jitter
6. Record outcome → update in-memory circuit state; log transitions to DB
7. Return upstream response (or final failure response)

**State split:**
- `src/state/memory.ts` — fast in-memory structures for circuit state and sliding windows (hot path)
- `src/state/db.ts` — SQLite for durable config records and circuit breaker state change audit log

**Failure definition:** 5xx responses and timeouts only. 4xx is not a failure. The failure counter is incremented once per logical call — only after all retry attempts for that call are exhausted. Individual retry attempts within a single call do not each increment the counter.

**Half-open state:** Uses a `testInFlight` flag — only one probe request gets through; concurrent requests during half-open are rejected with `503`.

**Sidecar error responses:** When the sidecar itself rejects a request (not the upstream), it returns structured JSON so callers can distinguish sidecar rejections from real downstream errors:
```json
{ "error": "rate_limit_exceeded", "service": "payments-service" }
{ "error": "circuit_breaker_open", "service": "payments-service" }
```

**Retry jitter formula:** `wait = random(0, 2^attempt * baseDelayMs)`

**Body buffering:** The full request body is buffered in memory before the first attempt to enable replay on retries. No size limit in V1 (configurable cap is V2).

**Startup behavior:** On every startup, `resilience.yaml` is loaded into SQLite and overwrites any existing policy config. YAML always wins. If config is missing, has a syntax error, or fails Zod validation, the process exits immediately — no stale config.

## Configuration

`resilience.yaml` is the single config source. Loaded at startup from `CONFIG_PATH` (default `/config/resilience.yaml`). Config is immutable at runtime — restart to pick up changes.

Time values use duration strings: `500ms`, `5s`, `1m`. These are parsed in `src/config/schema.ts` and stored as milliseconds.

All policy blocks (`retry`, `circuit_breaker`, `rate_limit`, `timeout`) are optional per service.

## Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `4000` | Fastify listen port |
| `CONFIG_PATH` | `/config/resilience.yaml` | YAML config location |
| `DB_PATH` | `/data/semaphore.db` | SQLite database path |
| `NODE_ENV` | — | Set to `production` in docker-compose |

## Testing

Tests live in `tests/` and use Vitest. They mock `src/state/memory.ts` to isolate policy logic. No integration tests against a real HTTP server — unit tests only for the three policy modules.

Run: `npm test`

## Docker

Multi-stage Dockerfile: builder compiles TypeScript, runtime stage uses Node 22 Alpine with production deps only. The `/config` and `/data` directories are created in the image; mount your `resilience.yaml` and a named volume over them.

## Roadmap

### V2
| Feature | Notes |
|---------|-------|
| Shared circuit breaker state across instances | Via Redis; V1 state is per-sidecar in-memory only |
| Hot config reload | V1 requires restart |
| Per-caller (IP-based) rate limiting | V1 rate limit is global per service |
| Total timeout budget across retry attempts | V1 timeout is per-attempt only |
| Configurable `failureOn` codes | V1 hardcodes any 5xx as failure |
| Configurable request body buffer size cap | V1 buffers full body with no limit |
| Configurable timeout retry behavior | V1 always retries on timeout |
| Per-endpoint circuit breakers | V1 is per-service only |
| Bulkhead / concurrency limiting | — |

### V3
| Feature | Notes |
|---------|-------|
| Metrics export | Prometheus |
| Distributed tracing | OpenTelemetry |
| Full request logging | V1 logs circuit breaker state changes only |
| gRPC support | V1 is HTTP only |

### Never (out of scope)
- Service discovery or load balancing
- mTLS or authentication
- Observability dashboard / UI
