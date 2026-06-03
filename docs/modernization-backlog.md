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
- P2 contract validation automation: CI validates Gateway OpenAPI required
  paths, Syncer webhook schema and MCP adapter tool contract.
- P2 metrics endpoint smoke: Gateway and Syncer unit tests verify `/metrics`
  via Fastify inject.
- P0 pilot runtime redeploy: Gateway and Syncer were rebuilt from the current
  repo and recreated with `docker-compose.local-servicedesk.yml`; `/live`,
  `/ready`, `/health` and `/metrics` pass on both services.
- P1 public limited reindex evidence: direct Syncer `maxPages=1` public-only
  non-dry-run completed with one local Ollama embedding call,
  `llmEnrichmentCalls=0` and `estimatedPaidCalls=0`.

## Remaining

- Pilot acceptance blockers: `docs/pilot-acceptance-report.md` now contains
  local Docker stand evidence from 2026-06-03 after redeploy. Runtime metrics and
  readiness pass, but full pilot acceptance still needs a valid MediaWiki admin
  session cookie for Gateway admin reindex, Syncer MediaWiki service credentials
  for protected reindex, and a configured monitoring collector/dashboard/alerts.
- OpenAI/LiteLLM smoke: opt-in only, with explicit cost/budget confirmation.
- Metrics integration: wire the now-working Gateway/Syncer `/metrics` endpoints
  into the target collector, dashboard and alert rules.
- Ollama healthcheck mismatch: `http://127.0.0.1:11434/api/tags` and local
  embedding-backed reindex pass, but Docker still reports `wikiai-ollama-1` as
  `unhealthy`.
- Production storage implementation: replace Postgres DAL placeholders before a
  production SLA/HA/compliance release.
- Production storage decision: keep SQLite only for dev/test/pilot, or implement
  Postgres stores before SLA/HA/compliance deployment.

## Next Iteration

- Provide a real MediaWiki admin session cookie and rerun Gateway admin reindex
  acceptance.
- Configure Syncer MediaWiki service auth with `MW_SERVICE_USERNAME` plus
  `MW_SERVICE_PASSWORD` or `MW_SERVICE_PASSWORD_SECRET`, then rerun protected
  reindex preflight/test.
- Configure monitoring scrape, dashboard and alert rules in the deployment stack.
- Fix or document the Ollama container healthcheck mismatch.
- Keep OpenAI/LiteLLM smoke manual and record explicit approval before running.
- Treat Postgres as a release blocker only for production SLA/HA/compliance.
