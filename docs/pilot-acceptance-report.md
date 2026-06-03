# WikiAI Pilot Acceptance Report

This report captures customer-like pilot evidence without paid OpenAI calls.

## Run Metadata

- Date: 2026-06-03T20:29:01+03:00
- Environment: local Docker pilot stand with `docker-compose.yml` and
  `docker-compose.local-servicedesk.yml`
- WikiAI repo commit: `b866886`
- Operator: Codex
- Gateway URL: `http://127.0.0.1:3000`
- Syncer URL: `http://127.0.0.1:3001`
- MediaWiki URL: `http://127.0.0.1:8082`
- Qdrant URL: `http://127.0.0.1:6333`
- Ollama URL: `http://127.0.0.1:11434`
- LiteLLM URL: `http://127.0.0.1:4000`
- LLM smoke: not run; no explicit paid API approval was provided.
- Runtime artifact: Gateway and Syncer were rebuilt from the current repository
  and recreated on the pilot stand. SQLite state was backed up to
  `backups/wiki-ai-20260603-1910-before-runtime-redeploy.sqlite` before
  redeploy.

## Runtime Health

| Check | Command | Expected | Result |
|-------|---------|----------|--------|
| Gateway live | `curl -s http://127.0.0.1:3000/live` | `status=ok` | Pass: `{"status":"ok","service":"gateway"}` |
| Gateway ready | `curl -s http://127.0.0.1:3000/ready` | `status=healthy` or documented dependency issue | Pass: Redis, Qdrant and LiteLLM `ok` |
| Gateway metrics | `curl -s http://127.0.0.1:3000/metrics` | Prometheus text metrics | Pass: includes `wikiai_process_start_time_seconds{service="gateway"}` |
| Syncer live | `curl -s http://127.0.0.1:3001/live` | `status=ok` | Pass: `{"status":"ok","service":"syncer"}` |
| Syncer ready | `curl -s http://127.0.0.1:3001/ready` | `status=healthy` or documented dependency issue | Pass: Qdrant, Gateway and MediaWiki `ok` |
| Syncer metrics | `curl -s http://127.0.0.1:3001/metrics` | Prometheus text metrics | Pass: includes `wikiai_process_start_time_seconds{service="syncer"}` |

Compatibility health endpoints are also alive:

- Gateway `GET /health`: `status=healthy`; Qdrant, Redis and LiteLLM checks were
  `ok`.
- Syncer `GET /health`: `status=healthy`; Qdrant, Gateway and MediaWiki checks
  were `ok`.

## Dependency Acceptance

| Dependency | Command | Expected | Result |
|------------|---------|----------|--------|
| Redis | Gateway `/health` compatibility check | `ok` | Pass: `redis.status=ok` |
| Qdrant | `curl -s http://127.0.0.1:6333/healthz` | healthy response | Pass: `healthz check passed` |
| MediaWiki | `curl -I http://127.0.0.1:8082/` | HTTP 2xx/3xx | Pass: HTTP 301 from Apache/PHP |
| Ollama embeddings | `curl -s http://127.0.0.1:11434/api/tags` | embedding model available | Pass: `nomic-embed-text:latest` available; Docker health status still reports `unhealthy` |
| LiteLLM readiness | `curl -s http://127.0.0.1:4000/health/readiness` | healthy response | Pass: `status=healthy` |

## Reindex Without OpenAI

The required limited reindex through Gateway was not executed in this run.

Reason:

- Gateway admin reindex status endpoint returned `Missing session cookie`.
- Gateway admin endpoints validate a real MediaWiki session via
  `meta=userinfo`; a synthetic cookie was not used.
- Syncer MediaWiki service credentials are not configured, so protected reindex
  is blocked until `MW_SERVICE_USERNAME` plus `MW_SERVICE_PASSWORD` or
  `MW_SERVICE_PASSWORD_SECRET` are provided.

Direct Syncer evidence for a public-only limited reindex:

- dry run: `processed=1`, `totalChunks=1`, `embeddingCalls=0`,
  `llmEnrichmentCalls=0`, `estimatedPaidCalls=0`;
- non-dry-run: `processed=1`, `totalChunks=1`, `embeddingCalls=1`,
  `llmEnrichmentCalls=0`, `estimatedPaidCalls=0`;
- request scope: `namespaces=[0]`, `namespaceAcl={"0":["*"]}`,
  `attachmentsEnabled=false`, `semanticFactsEnabled=true`,
  `llmEnrichmentEnabled=false`, `maxPages=1`;
- effective embedding provider: `ollama`, `apiKeyConfigured=false`.

Latest direct Syncer status after the non-dry-run:

- `state=completed`
- `dryRun=false`
- `processed=1`
- `totalChunks=1`
- `embeddingCalls=1`
- `llmEnrichmentCalls=0`
- `estimatedPaidCalls=0`

This direct Syncer run proves the no-paid-call reindex path for public content,
but it is not counted as full Gateway admin acceptance because the required
MediaWiki admin cookie was unavailable.

## ACL And Payload Verification

| Check | Command | Expected | Result |
|-------|---------|----------|--------|
| Admin docs anonymous ACL | MediaWiki API readable check for `WikiAIAdmin:Администрирование` | no anonymous `readable` | Pass: response had no `readable` field |
| Legacy admin docs anonymous ACL | MediaWiki API readable check for `CorpCommon:WikiAI/Администрирование` | no anonymous `readable` | Pass: response had no `readable` field |
| Dense payload ACL | Qdrant scroll for protected admin docs | no `allowed_groups:["*"]` | Pass in sampled payload: `allowed_groups=["sysop","aiadmin","ai-exec"]` |
| Semantic payload ACL | `node scripts/verify-semantic-payload-acl.mjs --json` | no ACL findings | Pass: `points=506`, `semanticPoints=165`, `errors=[]` |
| Corporate ACL live | `RUN_MW_SEED_LIVE=1 node scripts/verify-corporate-acl-live.mjs` | pass or documented skip | Skipped: `RUN_MW_SEED_LIVE` not set |

## Monitoring Evidence

- Gateway scrape target configured: runtime metric endpoint accepted; no
  collector target exists in this local stand.
- Syncer scrape target configured: runtime metric endpoint accepted; no
  collector target exists in this local stand.
- Metrics exposed only through internal network, allowlist reverse proxy, or
  collector sidecar: partially verified. Gateway and Syncer are attached to
  Docker internal networks and publish loopback host ports for local acceptance.
- Dashboard link: not configured.
- Alert rules link: not configured.

## Decision

- Pilot accepted: no.
- Accepted risks: none.
- Closed blocker: deployed Gateway and Syncer now expose the modernized runtime
  surface (`/live`, `/ready`, `/metrics`) after rebuild and redeploy.
- Remaining blockers:
  - full Gateway admin reindex acceptance needs a real MediaWiki admin session
    cookie;
  - protected reindex needs Syncer MediaWiki service credentials;
  - pilot monitoring collector, dashboard and alert rules are not configured;
  - `wikiai-ollama-1` Docker health status is still `unhealthy` despite a
    successful `/api/tags` response and local embedding-backed reindex.
- Follow-up actions:
  - provide a valid MediaWiki admin cookie and rerun Gateway
    `POST /api/admin/reindex`;
  - configure Syncer MediaWiki service auth and rerun protected reindex
    preflight/test;
  - attach `/metrics` to the target collector and add pilot dashboard/alerts;
  - fix or document the Ollama container healthcheck mismatch;
  - run LiteLLM/OpenAI smoke only after explicit paid API approval.
