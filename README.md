# Semaphore

A lightweight resilience sidecar that sits between your microservices and enforces retry, circuit breaking, rate limiting, and timeout policies — with zero code changes required.

## How it works

Semaphore runs as a Docker container alongside your services. Instead of calling downstream services directly, services route outbound requests through the sidecar at `/proxy/:service-name/<path>`. Semaphore enforces the policies defined in `resilience.yaml` and forwards the request to the configured target URL.

```
Your Service → Semaphore :4000/proxy/payments/charge → http://payments-service:8080/charge
```

**Request pipeline:**
1. Rate limit check — reject with `429` if window is full
2. Circuit breaker check — reject with `503` if circuit is open
3. Forward request to target with retry logic (exponential backoff + jitter)
4. Record outcome — update circuit breaker state, log transitions to SQLite
5. Return upstream response

## Quick start

```bash
docker-compose up
```

This starts the sidecar on port `4000` and a mock echo service on port `3001`. Test it:

```bash
# Health check — shows state of all configured services
curl http://localhost:4000/health

# Proxy a request to mock-service
curl http://localhost:4000/proxy/mock-service/hello
```

## Configuration

Edit `resilience.yaml` and restart the sidecar. Config is validated on startup — the process exits immediately if the config is invalid.

```yaml
global:
  max_body_size: 10mb                  # max request body to buffer for retries (kb/mb/gb)

policies:
  your-service-name:
    target: http://your-service:8080   # upstream URL
    failure_on: [500, 502, 503, 504]   # which status codes count as failures (default: all 5xx)

    retry:
      attempts: 3                      # max total attempts (1 original + 2 retries)
      backoff: exponential             # "exponential" or "fixed"
      jitter: true                     # randomize delay to prevent thundering herd
      delay: 500ms                     # base delay (supports ms/s/m units)
      budget: 10s                      # total time budget across all attempts
      retryOn: [500, 503, 429]         # which status codes trigger retry
      retryOnTimeout: false            # whether a per-attempt timeout triggers retry

    circuit_breaker:
      threshold: 50                    # open if >50% of requests fail in window
      window: 60s                      # rolling evaluation window
      cooldown: 30s                    # how long to stay open before half-open test

    rate_limit:
      requests: 100                    # max requests allowed in window (global)
      window: 1s                       # sliding window duration
      per_caller:
        requests: 20                   # max requests per source IP in window
        window: 1s

    timeout: 5s                        # per-attempt timeout
```

All time values support `ms`, `s`, and `m` suffixes. All policy blocks are optional — omit any you don't need. Within `rate_limit`, `requests`+`window` and `per_caller` are each optional but at least one must be present.

**Failure definition:** By default, any 5xx response or timeout counts as a failure. Use `failure_on` to restrict which status codes trigger failure counting. 4xx is never a failure.

## API

| Endpoint | Description |
|----------|-------------|
| `ANY /proxy/:service/*` | Forward request to the named service with policy enforcement |
| `GET /health` | Real-time state of all services (circuit state, failure rate, rate limit usage) |

## Integration

Point your service's outbound calls at the sidecar instead of the target directly:

```diff
- const res = await fetch('http://payments-service:8080/charge', options)
+ const res = await fetch('http://semaphore:4000/proxy/payments/charge', options)
```

Add a policy block to `resilience.yaml` for each service you want to protect.

## Docker

The sidecar mounts two paths:

| Path | Purpose |
|------|---------|
| `/config/resilience.yaml` | Policy config (mount your `resilience.yaml` here) |
| `/data/` | SQLite database (mount a named volume for persistence) |

```yaml
# docker-compose snippet
sidecar:
  image: semaphore
  ports:
    - "4000:4000"
  volumes:
    - ./resilience.yaml:/config/resilience.yaml
    - semaphore-data:/data
  environment:
    - REDIS_URL=redis://redis:6379   # optional; omit for single-instance deployments
  depends_on:
    - redis

redis:
  image: redis:7-alpine
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Port the sidecar listens on |
| `CONFIG_PATH` | `/config/resilience.yaml` | Path to config file |
| `DB_PATH` | `/data/semaphore.db` | Path to SQLite database |
| `REDIS_URL` | — | Optional. Enables shared circuit breaker state across instances (e.g. `redis://redis:6379`) |

## Development

```bash
npm install
npm run dev          # run with ts-node (no build step)
npm test             # run Vitest test suite
npm run build        # compile to dist/
npm start            # run compiled output
```

## Circuit breaker states

| State | Behavior |
|-------|---------|
| **Closed** | Normal operation; failures counted toward threshold |
| **Open** | All requests rejected with `503`; service is considered down |
| **Half-Open** | One test request allowed through; closes on success, reopens on failure |
