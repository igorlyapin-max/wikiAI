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

MediaWiki:

```bash
curl -I http://127.0.0.1:8082/
```

Qdrant:

```bash
curl -s http://127.0.0.1:6333/healthz
```

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
создана. Запустите `Переиндексировать ColBERT` во вкладке `RAG / Chunking`.

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

## Backup / Restore

Пока обязательные данные:

- Qdrant collection `wiki_chunks`;
- Redis runtime settings, если SQL config еще не включен;
- будущая SQLite/Postgres DB;
- MediaWiki DB и uploaded files.

Перед полной переиндексацией сделайте backup Qdrant или убедитесь, что reindex воспроизводим.
