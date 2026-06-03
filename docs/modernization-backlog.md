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

## Remaining

- Pilot acceptance blocker: `docs/pilot-acceptance-report.md` now contains local
  Docker stand evidence from 2026-06-03. Dependencies and ACL/payload checks are
  mostly healthy, but deployed Gateway/Syncer containers do not expose
  `/live`, `/ready` or `/metrics`; redeploy current images before accepting the
  pilot.
- OpenAI/LiteLLM smoke: opt-in only, with explicit cost/budget confirmation.
- Metrics integration: wire `/metrics` into the target collector, dashboard and
  alert rules after redeploy makes Gateway/Syncer `/metrics` available.
- Production storage implementation: replace Postgres DAL placeholders before a
  production SLA/HA/compliance release.
- Production storage decision: keep SQLite only for dev/test/pilot, or implement
  Postgres stores before SLA/HA/compliance deployment.

## Next Iteration

- Run pilot acceptance and store sanitized evidence in
  `docs/pilot-acceptance-report.md`.
- Rebuild/redeploy Gateway and Syncer from the current repo before rerunning
  acceptance; the inspected containers still expose only legacy `/health`.
- Configure monitoring scrape, dashboard and alert rules in the deployment stack.
- Keep OpenAI/LiteLLM smoke manual and record explicit approval before running.
- Treat Postgres as a release blocker only for production SLA/HA/compliance.
