# Changelog

## [2.0.0] - 2026-05-28

### Added
- **Redis-backed circuit breaker state** — set `REDIS_URL` to share circuit state across sidecar instances. Uses `SET NX` with TTL for distributed half-open probe coordination. Rate limit windows remain local.
- **Per-caller rate limiting** — `rate_limit.per_caller` enforces a separate sliding window per source IP alongside the existing global limit. Both are optional; at least one must be present.
- **Retry budget** — `retry.budget` sets a total time cap across all attempts, preventing runaway retry storms even when per-attempt timeouts are generous.
- **Configurable `retryOnTimeout`** — `retry.retryOnTimeout: false` opts out of retrying on per-attempt timeout. Defaults to `true`.
- **Configurable failure codes** — `failure_on` per service overrides the default (all 5xx). Useful when a 404 or 400 should count as a service failure, or when a 503 should not.
- **Request body size cap** — `global.max_body_size` (e.g. `10mb`) enforces a limit on buffered request bodies. Requests exceeding it are rejected with `413` before reaching the proxy handler.
- Redis added to `docker-compose.yml` and documented in `.env.example`.

### Changed
- `rate_limit` config: `requests` + `window` are now optional fields (previously required); at least one of global or `per_caller` must be configured.
- `retry.retryOn` is now respected for timeout outcomes when `retryOnTimeout` is enabled.
- Circuit breaker `checkCircuit` and `recordCircuitOutcome` are now async to support Redis reads/writes.
- `handleProxyRequest` accepts `callerIp` to support per-caller rate limiting.
- Health endpoint only shows `rate_limit` usage when global (`requests` + `window`) is configured.

## [1.0.0] - 2026-05-27

Initial release. Retry with exponential/fixed backoff and jitter, three-state circuit breaker, sliding-window rate limiting, per-attempt timeout, SQLite audit log.
