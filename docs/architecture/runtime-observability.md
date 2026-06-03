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

## Pilot Monitoring Contract

Pilot monitoring must scrape both services:

| Service | Target | Required labels |
|---------|--------|-----------------|
| Gateway | `http://<gateway-internal-host>:3000/metrics` | `service=gateway`, environment label from collector |
| Syncer | `http://<syncer-internal-host>:3001/metrics` | `service=syncer`, environment label from collector |

The pilot dashboard must show:

- process uptime for Gateway and Syncer;
- HTTP request rate by service, route and status;
- 5xx request rate by service;
- p95 or closest available latency view from
  `wikiai_http_request_duration_seconds_sum/count`;
- readiness state from `/ready` or an external probe.

Minimum alert rules:

- Gateway or Syncer scrape missing for more than two scrape intervals;
- Gateway or Syncer `/ready` degraded for more than five minutes;
- any sustained 5xx growth on user-facing Gateway routes;
- request latency growth relative to the pilot baseline;
- unexpected restart indicated by process start time change.

## Dependency Readiness

Gateway readiness checks Redis, Qdrant and LiteLLM readiness. Syncer readiness
checks Qdrant, MediaWiki and Gateway. Checks are bounded by
`HEALTH_CHECK_TIMEOUT_MS`.

## Remaining Storage Decision

SQLite remains the supported dev/test/pilot default. Treat Postgres as required
before production SLA, multiple Gateway/Syncer instances, HA, compliance audit
retention, or high write concurrency.
