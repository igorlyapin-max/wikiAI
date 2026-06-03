# WikiAI Pilot Acceptance Report

This report captures customer-like pilot evidence without paid OpenAI calls.

## Run Metadata

- Date: 2026-06-03T18:59:08+03:00
- Environment: local Docker pilot stand
- WikiAI repo commit: `b2e8f96`
- Operator: Codex
- Gateway URL: `http://127.0.0.1:3000`
- Syncer URL: `http://127.0.0.1:3001`
- MediaWiki URL: `http://127.0.0.1:8082`
- Qdrant URL: `http://127.0.0.1:6333`
- Ollama URL: `http://127.0.0.1:11434`
- LiteLLM URL: `http://127.0.0.1:4000`
- LLM smoke: not run; no explicit paid API approval was provided.

## Runtime Health

| Check | Command | Expected | Result |
|-------|---------|----------|--------|
| Gateway live | `curl -s http://127.0.0.1:3000/live` | `status=ok` | Fail: `Route GET:/live not found` |
| Gateway ready | `curl -s http://127.0.0.1:3000/ready` | `status=healthy` or documented dependency issue | Fail: `Route GET:/ready not found` |
| Gateway metrics | `curl -s http://127.0.0.1:3000/metrics` | Prometheus text metrics | Fail: `Route GET:/metrics not found` |
| Syncer live | `curl -s http://127.0.0.1:3001/live` | `status=ok` | Fail: `Route GET:/live not found` |
| Syncer ready | `curl -s http://127.0.0.1:3001/ready` | `status=healthy` or documented dependency issue | Fail: `Route GET:/ready not found` |
| Syncer metrics | `curl -s http://127.0.0.1:3001/metrics` | Prometheus text metrics | Fail: `Route GET:/metrics not found` |

Compatibility health endpoints are alive but do not satisfy the modernized
runtime contract by themselves:

- Gateway `GET /health`: `status=healthy`; Qdrant, Redis and LiteLLM checks were
  `ok`.
- Syncer `GET /health`: `status=ok`.

## Dependency Acceptance

| Dependency | Command | Expected | Result |
|------------|---------|----------|--------|
| Redis | Gateway `/health` compatibility check | `ok` | Pass: `redis.status=ok` |
| Qdrant | `curl -s http://127.0.0.1:6333/healthz` | healthy response | Pass: `healthz check passed` |
| MediaWiki | `curl -I http://127.0.0.1:8082/` | HTTP 2xx/3xx | Pass: HTTP 301 from Apache/PHP |
| Ollama embeddings | `curl -s http://127.0.0.1:11434/api/tags` | embedding model available | Pass: `nomic-embed-text:latest` available |
| LiteLLM readiness | `curl -s http://127.0.0.1:4000/health/readiness` | healthy response | Pass: `status=healthy` |

## Reindex Without OpenAI

The required limited reindex through Gateway was not executed in this run.

Reason:

- Gateway admin reindex status endpoint returned `Missing session cookie`.
- The deployed Gateway also lacks the modernized `/live`, `/ready`, `/metrics`
  and `/api/v1/capabilities` routes, so this stand should be redeployed before
  acceptance.

Existing Syncer status at the time of inspection showed a previous dry run:

- `state=completed`
- `dryRun=true`
- `processed=1`
- `totalChunks=1`
- `embeddingCalls=0`
- `llmEnrichmentCalls=0`
- `estimatedPaidCalls=0`

This previous status is informational only; it is not counted as a fresh
acceptance run.

## ACL And Payload Verification

| Check | Command | Expected | Result |
|-------|---------|----------|--------|
| Admin docs anonymous ACL | MediaWiki API readable check for `WikiAIAdmin:Администрирование` | no anonymous `readable` | Pass: response had no `readable` field |
| Legacy admin docs anonymous ACL | MediaWiki API readable check for `CorpCommon:WikiAI/Администрирование` | no anonymous `readable` | Pass: response had no `readable` field |
| Dense payload ACL | Qdrant scroll for protected admin docs | no `allowed_groups:["*"]` | Pass in sampled payload: `allowed_groups=["sysop","aiadmin","ai-exec"]` |
| Semantic payload ACL | `node scripts/verify-semantic-payload-acl.mjs --json` | no ACL findings | Pass: `points=506`, `semanticPoints=165`, `errors=[]` |
| Corporate ACL live | `RUN_MW_SEED_LIVE=1 node scripts/verify-corporate-acl-live.mjs` | pass or documented skip | Skipped: `RUN_MW_SEED_LIVE` not set |

## Monitoring Evidence

- Gateway scrape target configured: not accepted; `GET /metrics` returns 404 on
  the currently deployed Gateway container.
- Syncer scrape target configured: not accepted; `GET /metrics` returns 404 on
  the currently deployed Syncer container.
- Metrics exposed only through internal network, allowlist reverse proxy, or
  collector sidecar: not verified because `/metrics` is unavailable.
- Dashboard link: not configured.
- Alert rules link: not configured.

## Decision

- Pilot accepted: no.
- Accepted risks: none.
- Blocker: deployed Gateway and Syncer containers do not expose the modernized
  runtime surface (`/live`, `/ready`, `/metrics`) from the current repo.
- Follow-up actions:
  - rebuild and redeploy Gateway/Syncer images from a commit that includes
    `cacfb70`, `304f125`, `ae4f310` and `b2e8f96`;
  - rerun all runtime health and metrics checks;
  - rerun limited reindex with an admin MediaWiki session cookie;
  - configure monitoring scrape, dashboard and alert rules after `/metrics` is
    available;
  - run LiteLLM/OpenAI smoke only after explicit paid API approval.
