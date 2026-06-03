# WikiAI Modernization Backlog

Status after the current modernization pass.

## Closed

- P0 diagnostic/debug mode for Gateway and Syncer: environment-controlled,
  disabled by default, levels `Basic` and temporary `Verbose`.
- P0 structured logging: `stdout`/`stderr` plus optional UDP syslog sink, with
  sensitive-field redaction.
- P0 health checks: separate `/live`, `/ready` and compatibility `/health`.
- P0 Syncer admin protection: production startup requires `SYNCER_ADMIN_TOKEN`;
  unprotected admin mode is a dev/test escape hatch.
- P1 dependency audit: Gateway and Syncer upgraded to Fastify 5 line; production
  `npm audit --audit-level=high --omit=dev` is blocking in CI.
- P2 basic service metrics: Gateway and Syncer expose Prometheus-compatible
  `/metrics`.
- P2 contract artifacts: Gateway OpenAPI, Syncer webhook JSON Schema, MCP
  adapter contract.

## Remaining

- Production storage decision: keep SQLite only for dev/test/pilot, or implement
  Postgres stores before SLA/HA/compliance deployment.
- Live integration acceptance on customer-like environment: Redis, Qdrant,
  MediaWiki service user, Ollama embeddings, limited reindex, ACL payload
  checks.
- OpenAI/LiteLLM smoke: opt-in only, with explicit cost/budget confirmation.
- Contract validation automation: add schema/OpenAPI validation to CI when the
  project chooses a validator dependency.
- Metrics integration: wire `/metrics` into the target collector, dashboard and
  alert rules.
