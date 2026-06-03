# WikiAI Pilot Acceptance Report

Use this report to capture customer-like pilot evidence without paid OpenAI
calls. Fill it during the live acceptance run and attach command output or links
to sanitized logs where available.

## Run Metadata

- Date:
- Environment:
- WikiAI commit:
- Operator:
- Gateway URL:
- Syncer URL:
- MediaWiki URL:
- Qdrant URL:
- Ollama URL:
- LLM smoke: not run unless explicitly approved.

## Runtime Health

| Check | Command | Expected | Result |
|-------|---------|----------|--------|
| Gateway live | `curl -s <gateway>/live` | `status=ok` | |
| Gateway ready | `curl -s <gateway>/ready` | `status=healthy` or documented dependency issue | |
| Gateway metrics | `curl -s <gateway>/metrics` | Prometheus text metrics | |
| Syncer live | `curl -s <syncer>/live` | `status=ok` | |
| Syncer ready | `curl -s <syncer>/ready` | `status=healthy` or documented dependency issue | |
| Syncer metrics | `curl -s <syncer>/metrics` | Prometheus text metrics | |

## Dependency Acceptance

| Dependency | Command | Expected | Result |
|------------|---------|----------|--------|
| Redis | Gateway `/ready` check | `ok` | |
| Qdrant | `curl -s <qdrant>/healthz` | healthy response | |
| MediaWiki | `curl -I <mediawiki>/` | HTTP 2xx/3xx | |
| Ollama embeddings | Admin embedding test or local embedding check | vector dimension matches Qdrant | |
| LiteLLM readiness | Gateway `/ready` check | `ok` or documented pilot limitation | |

## Reindex Without OpenAI

Run limited reindex with attachments and LLM enrichment disabled:

```bash
curl -s -X POST <gateway>/api/admin/reindex \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin-mediawiki-cookie>' \
  -d '{"maxPages":1,"attachmentsEnabled":false,"semanticFactsEnabled":true,"llmEnrichmentEnabled":false}'
```

Evidence:

- Reindex request result:
- Reindex status result:
- `embedding calls` count:
- `LLM enrichment` count must be `0`:
- Notes:

## ACL And Payload Verification

| Check | Command | Expected | Result |
|-------|---------|----------|--------|
| Admin docs anonymous ACL | MediaWiki API readable check for `WikiAIAdmin:Администрирование` | no anonymous `readable` | |
| Legacy admin docs anonymous ACL | MediaWiki API readable check for `CorpCommon:WikiAI/Администрирование` | no anonymous `readable` | |
| Dense payload ACL | Qdrant scroll for protected admin docs | no `allowed_groups:["*"]` | |
| Semantic payload ACL | `node scripts/verify-semantic-payload-acl.mjs --json` | no ACL findings | |
| Corporate ACL live | `RUN_MW_SEED_LIVE=1 node scripts/verify-corporate-acl-live.mjs` | pass or documented skip | |

## Monitoring Evidence

- Gateway scrape target configured:
- Syncer scrape target configured:
- Metrics exposed only through internal network, allowlist reverse proxy, or collector sidecar:
- Dashboard link:
- Alert rules link:

## Decision

- Pilot accepted: yes/no
- Accepted risks:
- Follow-up actions:
