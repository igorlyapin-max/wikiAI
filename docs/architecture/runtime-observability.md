# Runtime Observability

This map is the operational contract for the current Gateway and Syncer runtime.

## Services

| Service | Liveness | Readiness | Metrics | Logs |
|---------|----------|-----------|---------|------|
| Gateway | `GET /live` | `GET /ready`, `GET /health` | `GET /metrics` | `stdout`/`stderr`, optional UDP syslog |
| Syncer | `GET /live` | `GET /ready`, `GET /health` | `GET /metrics` | `stdout`/`stderr`, optional UDP syslog |

`/health` is a backward-compatible readiness alias. New probes should use
`/live` and `/ready` separately.

## Diagnostic Mode

Diagnostic mode is controlled by environment, without code changes:

```env
DEBUG_DIAGNOSTICS_ENABLED=false
DEBUG_DIAGNOSTICS_LEVEL=Basic
LOG_SINKS=stdout,syslog
LOG_SYSLOG_HOST=127.0.0.1
LOG_SYSLOG_PORT=5514
```

`Verbose` is allowed only for temporary incident diagnostics. Structured log
payloads redact fields containing `password`, `secret`, `token`, `apiKey`,
`authorization` and `cookie`.

## Metrics

Metrics are Prometheus text format and include:

- `wikiai_process_start_time_seconds`
- `wikiai_process_uptime_seconds`
- `wikiai_http_requests_in_flight`
- `wikiai_http_requests_total`
- `wikiai_http_request_duration_seconds_sum`
- `wikiai_http_request_duration_seconds_count`

Labels:

- `service`
- `method`
- `route`
- `status`

Expose `/metrics` only through an internal network, reverse proxy allowlist or
collector sidecar. Metrics do not include request bodies, headers or secrets.

## Dependency Readiness

Gateway readiness checks Redis, Qdrant and LiteLLM readiness. Syncer readiness
checks Qdrant, MediaWiki and Gateway. Checks are bounded by
`HEALTH_CHECK_TIMEOUT_MS`.

## Remaining Storage Decision

SQLite remains the supported dev/test/pilot default. Treat Postgres as required
before production SLA, multiple Gateway/Syncer instances, HA, compliance audit
retention, or high write concurrency.
