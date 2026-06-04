# Wiki AI Operations Runbook

## Health Checks

Gateway:

```bash
curl -s http://127.0.0.1:3000/live
curl -s http://127.0.0.1:3000/ready
```

Syncer:

```bash
curl -s http://127.0.0.1:3001/live
curl -s http://127.0.0.1:3001/ready
```

Metrics:

```bash
curl -s http://127.0.0.1:3000/metrics
curl -s http://127.0.0.1:3001/metrics
```

`/metrics` отдается в Prometheus text format. Не публикуйте endpoint наружу без
reverse proxy allowlist, collector sidecar или другой внутренней сетевой
границы.

Minimum pilot alerts:

- Gateway or Syncer scrape target missing for more than two scrape intervals;
- Gateway or Syncer `/ready` returns degraded for more than five minutes;
- Gateway 5xx rate grows on `/api/search`, `/api/chat` or `/api/v1/*`;
- request latency grows above the accepted pilot baseline;
- process restart is detected by `wikiai_process_start_time_seconds`.
- trigram backfill stuck in `running` without progress in `wikiai_trigram_backfill_progress_chunks`;
- trigram search error rate grows in `wikiai_search_trigram_queries_total{result="error"}`;
- `wikiai_search_trigram_last_latency_ms` stays above the accepted staging p95 threshold during a rollout.

MediaWiki:

```bash
curl -I http://127.0.0.1:8082/
```

Qdrant:

```bash
curl -s http://127.0.0.1:6333/healthz
```

## Trigram Readiness

Before enabling `trigramIndexEnabled` on a large corpus, run backfill on staging and keep the JSON report:

```bash
DATABASE_URL=sqlite://./state/admin.db \
WIKIAI_ADMIN_COOKIE='<admin-mediawiki-cookie>' \
node scripts/benchmark-trigram-readiness.mjs \
  --base-url http://127.0.0.1:3000 \
  --queries ./trigram-queries.txt \
  --start-backfill
```

Production rollout is allowed only when `readiness.passed=true`, backfill is `completed`, coverage is 100%, no benchmark queries failed, and the SQLite size/latency delta is acceptable for the environment. If the report fails, leave `trigramIndexEnabled=false`; BM25/vector/ColBERT continue to work without trigram fallback.

## Diagnostic Logging

Gateway и Syncer поддерживают debug/diagnostic startup без изменения кода:

```bash
DEBUG_DIAGNOSTICS_ENABLED=true DEBUG_DIAGNOSTICS_LEVEL=Basic LOG_SINKS=stdout,syslog \
docker compose up -d gateway syncer
```

`Verbose` включайте только временно. Structured logs пишутся в `stdout`/`stderr`
и, при `LOG_SINKS=syslog`, дублируются в `LOG_SYSLOG_HOST:LOG_SYSLOG_PORT`.
Секреты, cookies, tokens и passwords маскируются.

## Extension Artifact Checks

Проверка, что MediaWiki использует поставленный artifact расширения, а не
одноразовый `docker cp` внутри контейнера:

```bash
docker inspect mediawiki --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

В выводе должен быть mount в `/var/www/html/extensions/AIAssistant`. Если mount
отсутствует, обновление расширения потеряется при пересоздании контейнера.

Проверка наличия ColBERT UI в установленном расширении:

```bash
docker exec mediawiki sh -lc \
  "grep -n 'rag-colbertBaseUrl\|colbert_full\|hybrid_colbert' /var/www/html/extensions/AIAssistant/src/SpecialAIAdmin.php"
```

После обновления artifact:

```bash
docker exec mediawiki php maintenance/run.php update
docker exec mediawiki php maintenance/run.php rebuildLocalisationCache --force
docker restart mediawiki
```

Проверка ColBERT service из Gateway:

```bash
docker exec wikiai-gateway-1 node -e "fetch('http://colbert:8080/health').then(async r => console.log(r.status, await r.text()))"
```

Если `collectionStatus.exists=false`, это значит, что ColBERT collection еще не
создана. Запустите `Переиндексировать ColBERT` во вкладке `ColBERT` или bounded
ColBERT-only dry run:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/reindex \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin-mediawiki-cookie>' \
  -d '{"indexTargets":["colbert"],"source":"qdrant_payload","dryRun":true,"maxPages":5}'
```

Для смены модели создайте candidate index через `POST /api/admin/rag/colbert/indexes`,
дождитесь `status=complete` через `/status`, затем выполните `promote`. Active
collection продолжает обслуживать поиск до promote.

## Protected Admin Docs

WikiAI admin documentation must live in protected namespace
`WikiAIAdmin:Администрирование`, not in public
`CorpCommon:WikiAI/Администрирование`.

The MediaWiki config must include a read-ACL rule for `WikiAIAdmin:` in
`$wgAIAssistantPageAclRules`; `$wgNamespaceProtection` alone is not enough for
the anonymous readable check below. Upgrade deployments must also keep a read-ACL
rule for legacy `CorpCommon:WikiAI/Администрирование` stubs, otherwise anonymous
search can still show old admin-doc titles.

Before reindex, Syncer must have `MW_SERVICE_USERNAME` plus
`MW_SERVICE_PASSWORD` or `MW_SERVICE_PASSWORD_SECRET` for a MediaWiki service
user allowed to read `WikiAIAdmin:`. Direct protected env/config values and
`secret://...` / indeedPAM references are supported. If service auth is not
configured, Qdrant will correctly have no public admin-doc payload, but admins
also will not get those docs in search. `MW_SYNC_COOKIE` is deprecated fallback
only.

Syncer blocks protected reindex before page fetch when selected namespaces have
`allowed_groups` other than exactly `["*"]` and MediaWiki service auth source is
`none`. Fix credentials first, then rerun `POST /admin/mediawiki-service-auth/test`.

Anonymous readable check:

```bash
curl -s 'http://127.0.0.1:8082/api.php?action=query&titles=WikiAIAdmin:Администрирование&prop=info&inprop=readable&format=json'
```

The anonymous response must not contain `"readable":""`.

Legacy readable check:

```bash
curl -s 'http://127.0.0.1:8082/api.php?action=query&titles=CorpCommon:WikiAI/Администрирование&prop=info&inprop=readable&format=json'
```

The anonymous response must not contain `"readable":""`.

Check dense index payload:

```bash
docker exec wikiai-gateway-1 node -e "fetch('http://qdrant:6333/collections/wiki_chunks/points/scroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:5,with_payload:true,with_vector:false,filter:{must:[{key:'title',match:{value:'WikiAIAdmin:Администрирование'}}]}})}).then(async r=>console.log(await r.text()))"
```

Check ColBERT payload:

```bash
docker exec wikiai-gateway-1 node -e "fetch('http://qdrant:6333/collections/wiki_colbert_chunks/points/scroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:5,with_payload:true,with_vector:false,filter:{must:[{key:'title',match:{value:'WikiAIAdmin:Администрирование'}}]}})}).then(async r=>console.log(await r.text()))"
```

Check attachment and Mermaid metadata:

```bash
docker exec wikiai-gateway-1 node -e "fetch('http://qdrant:6333/collections/wiki_chunks/points/scroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:10,with_payload:true,with_vector:false,filter:{should:[{key:'source_type',match:{value:'attachment'}},{key:'content_type',match:{value:'mermaid'}}]}})}).then(async r=>console.log(await r.text()))"
```

Admin docs payload must not have `allowed_groups:["*"]`. If legacy
`CorpCommon:WikiAI/Администрирование` payload still exists with
`allowed_groups:["*"]`, rerun `scripts/seed-ai-admin-docs.mjs`, then run dense
and ColBERT reindex.

## Safe Reindex

Для приемки без высокой нагрузки:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/reindex \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin-mediawiki-cookie>' \
  -d '{"maxPages":1,"attachmentsEnabled":false,"semanticFactsEnabled":true}'
```

Если Syncer защищен `SYNCER_ADMIN_TOKEN`, Gateway должен передавать его через `x-wikiai-admin-token`.

## Проверка payload в Qdrant

Минимально проверяются:

- `page_id`;
- `title`;
- `namespace`;
- служебное поле групп доступа;
- `semantic_facts`;
- в будущем: `trust_score`, `trust_flags`, `trust_model_id`.

## Chat Error Troubleshooting

Если UI показывает `Ошибка при генерации ответа.`:

- проверить `/health` Gateway;
- проверить доступность LiteLLM readiness;
- проверить `LITELLM_BASE_URL`, `LITELLM_MODEL`, `LITELLM_API_KEY`;
- если переключение на OpenAI идет через LiteLLM, проверить что `LITELLM_MODEL` указывает на alias `corp-openai-gpt-4.1-mini` и что upstream `OPENAI_API_KEY` задан именно в runtime LiteLLM;
- проверить Qdrant collection и наличие chunks;
- проверить, что у пользователя есть доступ к найденным страницам;
- проверить таймаут LLM в runtime/admin config;
- не запускать платный OpenAI smoke без явного подтверждения.

## Manual LiteLLM / OpenAI Smoke

OpenAI/LiteLLM smoke is manual only. Run it only after the budget owner confirms
that a paid API call is allowed for this acceptance window.

Before running:

- record approver, date, target environment and expected model alias;
- verify `LITELLM_MODEL` points to the LiteLLM alias, for example
  `corp-openai-gpt-4.1-mini`;
- verify the upstream `OPENAI_API_KEY` is configured in LiteLLM runtime, not in
  WikiAI;
- use a minimal prompt and avoid full reindex with OpenAI-compatible embeddings.

Suggested smoke:

```bash
npm --prefix packages/gateway run test:smoke:llm
```

Record after running:

- model alias;
- HTTP status/result summary;
- token/cost output if available;
- failure reason or retry decision.

## Backup / Restore

Пилот на SQLite требует persistent `state/` и backup перед destructive
операциями, обновлениями образов и полной переиндексацией.

Пока обязательные данные:

- Qdrant collection `wiki_chunks`;
- Redis runtime settings, если SQL config еще не включен;
- SQLite файл из `DATABASE_URL`, обычно `state/wiki-ai.sqlite`, или будущая
  Postgres DB для production SLA;
- MediaWiki DB и uploaded files.

Минимальный SQLite backup на pilot-стенде:

```bash
mkdir -p backups
cp state/wiki-ai.sqlite "backups/wiki-ai-$(date +%Y%m%d%H%M%S).sqlite"
```

Restore выполняйте при остановленных Gateway/Syncer:

```bash
cp backups/wiki-ai-<timestamp>.sqlite state/wiki-ai.sqlite
```

Для Postgres production-mode используйте logical dump перед обновлением
Gateway/Syncer, destructive reindex или миграциями:

```bash
mkdir -p backups
docker compose --profile postgres exec -T postgres pg_dump -U "${POSTGRES_USER:-wikiai}" "${POSTGRES_DB:-wikiai}" \
  > "backups/wiki-ai-postgres-$(date +%Y%m%d%H%M%S).sql"
```

Restore выполняйте только при остановленных Gateway/Syncer:

```bash
docker compose stop gateway syncer
docker compose --profile postgres exec -T postgres psql -U "${POSTGRES_USER:-wikiai}" "${POSTGRES_DB:-wikiai}" \
  < backups/wiki-ai-postgres-<timestamp>.sql
docker compose --profile postgres up -d gateway syncer
```

После restore проверьте admin diagnostics: `database.dialect`,
`database.connectionStatus`, `database.migrationStatus`, chat stats и search
index status.

Перед полной переиндексацией сделайте backup Qdrant или убедитесь, что reindex воспроизводим.
