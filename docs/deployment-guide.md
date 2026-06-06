# Wiki AI Deployment Guide

## Required Services

- MediaWiki + Semantic MediaWiki.
- PageForms и VEForAll для расширенного редактирования форм.
- Gateway.
- Syncer.
- Redis.
- Qdrant.
- OpenSearch optional: отдельный lexical/relevance profile, не заменяет Qdrant dense vectors в первой rollout-версии.
- Ollama для локальных embeddings.
- LiteLLM/OpenAI-compatible endpoint для LLM ответов.

Gateway runtime должен запускаться на Node.js 24+ из-за встроенного SQLite-модуля `node:sqlite`.

## MediaWiki Extension Frontend Asset

MediaWiki ResourceLoader подключает:

- `packages/mw-extension/resources/ai-assistant/dist/index.js`;
- `packages/mw-extension/resources/ai-admin/dist/index.js`.

Каталог `dist/` не хранится в git, поэтому deployment pipeline или сборка
MediaWiki-образа должны собрать оба frontend bundle перед копированием
расширения:

```bash
npm --prefix packages/mw-extension/resources/ai-assistant ci
npm --prefix packages/mw-extension/resources/ai-assistant run build
npm --prefix packages/mw-extension/resources/ai-admin ci
npm --prefix packages/mw-extension/resources/ai-admin run build
```

После этого копируйте `packages/mw-extension` в
`$MEDIAWIKI_EXTENSIONS/AIAssistant`. Если extension directory не bind-mounted,
runtime-обновление файлов внутри контейнера потеряется при пересоздании
MediaWiki; для заказчика сборка должна быть частью образа или поставочного
архива.

## Environment

Базовые переменные:

- `DATABASE_URL` - admin/config/chat/search state DB. SQLite remains the
  dev/test/pilot default, but `NODE_ENV=production` requires Postgres unless
  `ALLOW_SQLITE_IN_PRODUCTION=true` is set for local diagnostics.
- `MW_BASE_URL` - внутренний URL MediaWiki API для Gateway/Syncer.
- `MW_PUBLIC_BASE_URL` - внешний URL MediaWiki для ссылок на источники в браузере.
- `MW_API_PATH`
- `MW_SERVICE_USERNAME` - dedicated MediaWiki service user allowed to read
  protected namespaces, for example a user in `ai-exec` or `aiadmin`.
- `MW_SERVICE_PASSWORD` - direct password from protected env/config, or a
  `secret://...` / `aapm://...` reference resolved by the configured provider.
- `MW_SERVICE_PASSWORD_SECRET` - companion secret id; used as
  `secret://<value>` when `MW_SERVICE_PASSWORD` is empty.
- `SECRETS_PROVIDER` - `None` or `IndeedPamAapm`.
- `MW_SYNC_COOKIE` - deprecated fallback only. Session cookies expire and should
  not be the primary customer deployment mechanism.
- `EXTERNAL_API_ENABLED` - включает `/api/v1/search`, `/api/v1/chat` и
  `/api/v1/capabilities`. Default `false`.
- `EXTERNAL_MCP_ENABLED` - включает MCP-facing capability flag для внешнего MCP
  adapter. Default `false`.
- `EXTERNAL_ANONYMOUS_SEARCH_ALLOWED` - разрешает anonymous `/api/v1/search`
  по публичным chunks. Default `true`; chat anonymous запрещен.
- `EXTERNAL_MAX_TOP_K` - верхняя граница `topK` для External API/MCP, default
  `10`.
- `EXTERNAL_ACL_MODE` - `mediawiki_check` или `groups_only`. Для Variant A с
  OIDC/AD group mapping используйте `groups_only`.
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` - Corporate SSO / IdP
  параметры для проверки Bearer token Gateway.
- `OIDC_SUBJECT_CLAIM`, `OIDC_USERNAME_CLAIM`, `OIDC_GROUPS_CLAIM` - имена
  claim'ов, defaults: `sub`, `preferred_username`, `groups`.
- `REDIS_URL`
- `QDRANT_URL`
- `QDRANT_API_KEY` - required for the production compose profile; pass the same
  value to Gateway, Syncer, ColBERT and Qdrant.
- `QDRANT_COLLECTION`
- `OPENSEARCH_ENABLED` - включает OpenSearch lexical backend. Default `false`.
- `OPENSEARCH_BASE_URL` - URL OpenSearch из Gateway container, default `http://opensearch:9200`. Не путайте с host URL: `http://127.0.0.1:9200` подходит для ручной проверки с машины, но не для Gateway внутри Docker network.
- `OPENSEARCH_INDEX_NAME` - index для chunks, default `wikiai_chunks`.
- `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`, `OPENSEARCH_API_KEY` - optional auth. UI показывает только `authConfigured`.
- `OPENSEARCH_TIMEOUT_MS`, `OPENSEARCH_TLS_REJECT_UNAUTHORIZED`.
- `OPENSEARCH_ANALYZER` - analyzer для title/text mapping и query/analyze, default `russian`. При смене analyzer для существующего индекса нужен rebuild/recreate index.
- `OPENSEARCH_FUZZY_ENABLED`, `OPENSEARCH_HIGHLIGHT_ENABLED`.
- `OPENSEARCH_TITLE_BOOST`, `OPENSEARCH_TEXT_BOOST`, `OPENSEARCH_CANDIDATE_LIMIT`.
- `OLLAMA_BASE_URL`
- `OLLAMA_EMBEDDING_MODEL`
- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `LITELLM_MODEL`
- `OPENAI_API_KEY` - задается в runtime LiteLLM, а не в WikiAI, если LiteLLM route ведет в OpenAI.
- `OPENAI_MODEL` - upstream OpenAI model для LiteLLM route, default `gpt-4.1-mini`.
- `SYNCER_BASE_URL`
- `SYNCER_ADMIN_TOKEN`
- `ALLOW_UNPROTECTED_SYNCER_ADMIN` - local/dev escape hatch only. In
  `NODE_ENV=production`, Syncer requires `SYNCER_ADMIN_TOKEN` and fails startup
  when the token is empty.
- `GATEWAY_BASE_URL` - URL Gateway из Syncer для webhook trust recalculation.
- `CHUNK_SIZE`
- `CHUNK_OVERLAP`
- `SMW_SYNC_ENABLED`
- `SMW_SYNC_PROPERTIES`
- `CMDBDYNAMICPAGES_ENABLED` - включает обработку явных dynamic block markers
  на MediaWiki-страницах. Default `false`.
- `CMDBDYNAMICPAGES_BASE_URL` - внутренний URL `cmdbdynamicpages` для anonymous
  `staticSnapshot` JSON fetch из Syncer.
- `CMDBDYNAMICPAGES_MAX_BLOCKS_PER_PAGE`,
  `CMDBDYNAMICPAGES_MAX_SNAPSHOT_CHARS`,
  `CMDBDYNAMICPAGES_SNAPSHOT_TIMEOUT_MS`,
  `CMDBDYNAMICPAGES_REDACT_PARAMS` - лимиты и redaction для dynamic blocks.
- `DEBUG_DIAGNOSTICS_ENABLED` - enables diagnostic startup/runtime events
  without changing code. Default `false`.
- `DEBUG_DIAGNOSTICS_LEVEL` - `Basic` or temporary `Verbose`; verbose output is
  redacted and should not stay enabled after incident diagnostics.
- `LOG_SINKS` - comma-separated structured log sinks. Runtime default is
  `stdout,syslog`.
- `LOG_SYSLOG_HOST`, `LOG_SYSLOG_PORT` - best-effort UDP syslog endpoint for the
  operational log sink.
- `HEALTH_CHECK_TIMEOUT_MS` - readiness dependency timeout.

`LITELLM_API_KEY`, `MW_ADMIN_PASSWORD`, `MW_SEED_PASSWORD`,
`MW_SERVICE_PASSWORD`, `MW_SYNC_COOKIE` и
`SYNCER_ADMIN_TOKEN`, `OPENAI_API_KEY`, `OPENSEARCH_PASSWORD` и
`OPENSEARCH_API_KEY` не должны иметь `changeme-*` дефолтов в compose или CI.
Перед запуском стенда задавайте их через защищенные переменные окружения,
секрет-хранилище или локальный `.env`, который не коммитится.

### External API / MCP Auth: Variant A

Для схемы, где MediaWiki пользователи авторизуются через MS AD/LDAP, а Gateway
для REST/MCP принимает Corporate SSO Bearer token, используйте:

- `EXTERNAL_API_ENABLED=true`;
- `EXTERNAL_MCP_ENABLED=true`, если нужен MCP adapter;
- `EXTERNAL_ACL_MODE=groups_only`;
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` от того же Corporate SSO/IdP,
  который выдает access token для audience WikiAI.

После запуска администратор в MediaWiki `Служебная:AI-администрирование` ->
`Внешний API` задает:

- `groupMappingMode=mapped_only`;
- `groupMappings` как JSON-объект `raw OIDC/AD group -> MediaWiki ACL groups`.

Пример:

```json
{
  "CN=WikiAI-IT-Readers,OU=Groups,DC=corp,DC=example": ["ai-it"],
  "CN=WikiAI-Admins,OU=Groups,DC=corp,DC=example": ["aiadmin", "sysop"]
}
```

Gateway сначала проверяет подпись Bearer token по JWKS и claims `iss`/`aud`/`exp`/`nbf`,
и только после этого применяет mapping. Raw OIDC groups не дают доступ в
`mapped_only`, если для них нет правила. Логин/пароль MediaWiki для REST/MCP не
используется; `WIKIAI_COOKIE` остается локальным/admin fallback для embedded
проверок.

Если IdP отдает AD DN группы (`CN=...,OU=...,DC=...`), настройте
`OIDC_GROUPS_CLAIM` как array claim. Для строкового claim Gateway использует
разделители whitespace и `;`; запятая не используется как разделитель, чтобы не
разрезать DN.

### Diagnostics, Logs, And Health

Gateway и Syncer пишут runtime события через structured logging pipeline.
Обычные события идут в `stdout`, ошибки в `stderr`, а `LOG_SINKS=syslog`
дублирует JSON-события в UDP syslog/collector/sidecar endpoint. Поля с
`password`, `secret`, `token`, `apiKey`, `authorization` и `cookie`
маскируются.

Health endpoints:

- `GET /live` - process liveness без проверки зависимостей.
- `GET /ready` - readiness с bounded checks зависимостей.
- `GET /health` - backward-compatible readiness alias.
- `GET /metrics` - Prometheus-compatible process/request/dependency/health/
  scheduler metrics. Публикуйте только во внутренней сети, через allowlist
  reverse proxy или collector sidecar.

Для временной диагностики:

```env
DEBUG_DIAGNOSTICS_ENABLED=true
DEBUG_DIAGNOSTICS_LEVEL=Basic
```

`Verbose` используйте только на время расследования и возвращайте обратно в
`Basic`/disabled после сбора evidence.

### Container Network URLs

Все URL внешних сервисов должны быть доступны из контейнеров Gateway/Syncer.
`localhost` или `127.0.0.1` внутри контейнера указывает на сам контейнер, а
`host.docker.internal` не поможет, если host-сервис слушает только loopback.

Допустимые варианты для Redis/LiteLLM/MediaWiki:

- подключить WikiAI контейнеры к той же Docker network и использовать DNS имена
  сервисов, например `redis`, `litellm`, `mediawiki`;
- указать routable DNS/IP сервиса;
- настроить host-сервис слушать адрес, доступный контейнеру, если это разрешено
  политикой безопасности.

Для текущего локального стенда с уже поднятыми `servicedesk-agents` и
`mediawiki` используйте:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-servicedesk.yml up -d gateway syncer
```

Этот override выставляет `REDIS_URL=redis://redis:6379/0`,
`LITELLM_BASE_URL=http://litellm:4000/v1`, `MW_BASE_URL=http://mediawiki` и
`MW_PUBLIC_BASE_URL=http://127.0.0.1:8082` только для локальной интеграционной схемы.
`MW_BASE_URL` может быть Docker-internal, но `MW_PUBLIC_BASE_URL` должен быть
адресом wiki, открываемым из браузера пользователя.

### OpenSearch Deployment Profile

OpenSearch включается как отдельный deployment profile:

```bash
OPENSEARCH_ENABLED=true OPENSEARCH_BASE_URL=http://opensearch:9200 docker compose --profile opensearch up -d --build opensearch gateway syncer
```

После запуска администратор должен:

1. Проверить `Служебная:AI-администрирование -> OpenSearch`; в поле `OpenSearch URL` для Compose должен быть `http://opensearch:9200`.
2. Проверить read-only `Effective OpenSearch settings`: `admin override` означает значение из UI, `env/default` - `OPENSEARCH_*` или default Gateway.
3. В `Профили поиска` выбрать или создать retrieval profile с `lexicalBackend=opensearch`, если OpenSearch должен участвовать в обычном hybrid search.
4. Включить target `OpenSearch` в indexing profile.
5. Запустить reindex кнопкой `Перестроить индекс OpenSearch` во вкладке `OpenSearch` или вручную:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/reindex \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin-mediawiki-cookie>' \
  -d '{"source":"qdrant_payload","indexTargets":["opensearch"],"dryRun":false}'
```

Если OpenSearch должен искать по вложениям, дополнительно проверьте цепочку:
`Распознавание документов` включает нужный MIME, indexing profile имеет
`attachmentsEnabled=true` и targets `attachments,opensearch`, manual reindex
запущен с галкой `Обрабатывать вложения в этом запуске`, а во вкладке
`OpenSearch` `attachmentDocumentCount` и проверка filename показывают нужный
файл. Если файл есть в BM25/PostgreSQL, но отсутствует в OpenSearch, повторите
reindex с target `opensearch`; изменение retrieval profile само по себе
OpenSearch index не наполняет.

OpenSearch vector search не является production default в этой версии. Qdrant
остается dense-vector backend; OpenSearch используется как lexical/relevance
layer и может быть усилен ColBERT rerank через profile
`opensearch_hybrid_colbert`.

Для встроенного MediaWiki поиска и чата default profile после развертывания -
`opensearch_hybrid_colbert`. Если OpenSearch или ColBERT еще не подняты, либо
индексы не построены, MediaWiki search/chat вернут readiness-ошибку без
скрытого fallback. На таком стенде выберите другой MediaWiki profile во вкладке
`Выбор профиля для MediaWiki` или подготовьте OpenSearch/ColBERT контур.

Если OpenSearch не развернут, оставьте `OPENSEARCH_ENABLED=false`, не выбирайте
OpenSearch retrieval profiles и используйте `sqlite_fts`/BM25 profiles. Пустой
URL при включенном OpenSearch в UI будет заменен на compose default
`http://opensearch:9200`; невалидный URL должен блокировать сохранение.
Переключение `lexicalBackend=opensearch` в retrieval profile не запускает reindex автоматически:
индекс наполняется только через indexing profile с target `opensearch`.

Если в UI при analyze/search-preview появляется
`Route POST:/api/admin/opensearch/analyze not found`, это почти всегда старый
Gateway container/image. Route регистрируется независимо от готовности
OpenSearch, поэтому после обновления кода пересоберите Gateway:

```bash
docker compose build gateway
docker compose up -d gateway
```

Проверка live bundle:

```bash
docker exec wikiai-gateway-1 grep -n "opensearch/analyze" /app/dist/routes/admin.js
```

### cmdbdynamicpages Blocks

Если MediaWiki-страницы содержат dynamic blocks из `cmdbdynamicpages`, настройте
интеграцию по контракту `docs/contracts/cmdbdynamicpages-wikiai.md`.
Syncer индексирует обычный wiki text как прежде, а dynamic block обрабатывает
отдельно: anonymous `staticSnapshot` может стать дополнительным chunk, а
`dynamicUser` runtime не записывается в общий индекс.

### Browser Access To Gateway

Если браузер получает UI из MediaWiki, но запросы поиска/чата идут напрямую на
Gateway port, Gateway должен разрешать origin MediaWiki:

```env
CORS_ORIGINS=http://127.0.0.1:8082,http://localhost:8082
```

Без этого preflight `OPTIONS /api/search` вернет 404/ошибку CORS, а Firefox
покажет `NetworkError when attempting to fetch resource`. Для production
same-origin reverse proxy можно не открывать CORS, но тогда `/api/*` на wiki
origin должен проксироваться на Gateway.

### LAN Demo Mode

Для онлайн-демонстрации в доверенной локальной сети можно открыть Gateway на
LAN-интерфейсе, сохранив обычный `localhost` режим по умолчанию. TLS и
additional production hardening для этого стенда не требуются.

1. Узнайте LAN IP host машины:

```bash
hostname -I
ip -4 addr
```

На Windows используйте `ipconfig`, на macOS - `ipconfig getifaddr en0`.

2. Создайте LAN env file и замените `192.168.1.50` на реальный IP:

```bash
cp .env.lan-demo.example .env.lan-demo
```

```env
WIKIAI_LAN_HOST=192.168.1.50
WIKIAI_LAN_BIND=0.0.0.0
MW_PUBLIC_BASE_URL=http://192.168.1.50:8082
CORS_ORIGINS=http://192.168.1.50:8082,http://localhost:8082,http://127.0.0.1:8082
```

`WIKIAI_LAN_BIND=0.0.0.0` слушает все host interfaces. Если нужно привязаться
только к одному интерфейсу, укажите сам LAN IP.

3. Запустите стек с LAN override:

```bash
docker compose --env-file .env --env-file .env.lan-demo \
  -f docker-compose.yml -f docker-compose.lan-demo.yml up -d
```

4. В MediaWiki `LocalSettings.php` используйте LAN-facing URLs для браузера и
container/internal URLs для server-side calls:

```php
$wgServer = 'http://192.168.1.50:8082';
$wgAIAssistantGatewayUrl = 'http://gateway:3000';
$wgAIAssistantGatewayPublicUrl = 'http://192.168.1.50:3000';
$wgAIAssistantSyncerUrl = 'http://syncer:3001';
```

Для демонстрации с другого устройства в той же сети должны открываться
`http://192.168.1.50:8082/`, `http://192.168.1.50:3000/live`, а
`Special:AIAssistant` должен выполнять browser requests к
`http://192.168.1.50:3000`.

### Same-Origin WikiAI Edge Proxy

На host машине `nginx` может отсутствовать; проверяйте WikiAI nginx config через
контейнер в сети, где резолвятся `gateway` и `mediawiki`:

```bash
docker run --rm --network mediawiki_default \
  -v "$PWD/config/nginx.wikiai-ui.example.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine nginx -t
```

Для локального edge proxy соберите standalone UI и запустите override:

```bash
npm --prefix packages/wiki-ui run build
docker compose -f docker-compose.wikiai-edge.yml up -d
```

`docker-compose.wikiai-edge.yml` подключается к уже существующим Docker networks
`wikiai_default` и `mediawiki_default`, поэтому не требует секретов Gateway или
Syncer и не пересоздает эти сервисы. Не запускайте edge proxy через полный
`docker-compose.yml` с placeholder секретами: это может пересоздать Gateway с
неверным `LITELLM_API_KEY`.

По умолчанию proxy слушает `http://127.0.0.1:8084`: `/ai/*` отдает
`packages/wiki-ui/dist`, `/api/*` проксируется в Gateway, `/wiki/*` в
MediaWiki. Порт можно изменить через `WIKIAI_EDGE_PORT`.

### MediaWiki Service User And Secret Provider

Для полного reindex защищенных namespace заказчик должен предоставить Syncer
устойчивые учетные данные сервисного пользователя MediaWiki. Администратор
может выбрать способ хранения секрета по своей политике:

```env
MW_SERVICE_USERNAME=WikiAISync
MW_SERVICE_PASSWORD=<direct-password-from-protected-env>
SECRETS_PROVIDER=None
```

или через indeedPAM/AAPM:

```env
MW_SERVICE_USERNAME=WikiAISync
MW_SERVICE_PASSWORD_SECRET=wikiai-syncer
SECRETS_PROVIDER=IndeedPamAapm
PAMURL=https://pam.example.local
PAMTOKEN=<application-token>
PAMDEFAULTACCOUNTPATH=Vault/MediaWiki
```

Также поддерживается явная ссылка:

```env
MW_SERVICE_PASSWORD=secret://Vault/MediaWiki/wikiai-syncer
```

Syncer сам получает MediaWiki session cookie через API login и держит его только
в памяти процесса. При истечении/ошибке авторизации session сбрасывается и login
повторяется один раз на следующий запрос. `MW_SYNC_COOKIE` остается только для
совместимости со старыми стендами. Reindex namespace с `allowed_groups`, отличным
от ровно `["*"]`, блокируется до успешной настройки MediaWiki service auth.

После задания `MW_SERVICE_*` выполните auth test в админке
`POST /api/admin/service-config/test` или внутренний Syncer test
`POST /admin/mediawiki-service-auth/test`. Только после успешного теста запускайте
полный `source=mediawiki` reindex защищенных namespace. Если нужно лишь пересобрать
BM25, OpenSearch или ColBERT из уже сохраненных chunks, используйте
`source=qdrant_payload`: этот путь не читает MediaWiki и не требует service auth.

## LiteLLM / OpenAI

Продовый путь к OpenAI должен идти через LiteLLM proxy. WikiAI Gateway хранит только:

```env
LITELLM_BASE_URL=http://litellm:4000/v1
LITELLM_API_KEY=<litellm-proxy-key>
LITELLM_MODEL=corp-openai-gpt-4.1-mini
```

OpenAI upstream key задается в runtime LiteLLM:

```env
OPENAI_API_KEY=<openai-project-key>
OPENAI_MODEL=gpt-4.1-mini
```

Шаблон LiteLLM route лежит в `config/litellm-openai-gpt-4.1-mini.yaml`. Внешний LiteLLM config должен содержать alias `corp-openai-gpt-4.1-mini`, который мапится на `openai/gpt-4.1-mini`. Embeddings остаются на Ollama по умолчанию; включать OpenAI-compatible embeddings нужно отдельно, потому что full reindex может стать платным на каждый chunk.

## ColBERT production index

ColBERT обязателен для полноценного production-контура WikiAI. Без него контур может быть только `limited_ready` и подходит для ограниченных сценариев: пилот, точный справочный поиск, небольшой корпус или проверка администрирования. `docker-compose.yml` содержит on-prem CPU pilot service. Gateway может использовать его двумя способами: `colbert_full` как отдельный late-interaction index или `hybrid_colbert` как rerank текущих Qdrant/BM25 кандидатов.

```env
COLBERT_BASE_URL=http://colbert:8080
COLBERT_MODEL=antoinelouis/colbert-xm
COLBERT_COLLECTION=wiki_colbert_chunks
COLBERT_DEVICE=cpu
COLBERT_MAX_TOKENS=180
```

С хоста тестового стенда сервис доступен как `http://127.0.0.1:8083`. Внутри Docker Gateway обращается к `http://colbert:8080`.

Syncer не пишет в ColBERT напрямую. Он отправляет page chunks в Gateway internal search-index endpoint; Gateway обновляет BM25 и дополнительно вызывает ColBERT `/index/page` или `/index/delete-page`. Reindex request может ограничить targets через `indexTargets`, например `["colbert"]`, и использовать `source:"qdrant_payload"` для ColBERT-only rebuild без MediaWiki fetch и без dense embeddings.

Gateway применяет MediaWiki ACL и trust policy перед пользовательской выдачей. ColBERT не заменяет Qdrant, BM25, Postgres или права доступа и сам по себе не вызывает OpenAI. Стоимость CPU/RAM зависит от размера wiki, `COLBERT_MAX_TOKENS`, `colbertCandidateLimit` и выбранной модели.

При смене модели не перезаписывайте active collection. Создайте candidate `ColbertIndexSpec`, дождитесь complete build, затем выполните promote. Перед production rollout проверьте лицензию весов, доступность модели в `HF_HOME`, CPU/GPU/RAM и скорость полного rebuild на репрезентативном объеме.

## Trigram production rollout

Trigram fallback - experimental lexical feature поверх BM25. Он не вызывает LLM, embeddings или ColBERT rebuild, но создает отдельные SQLite/FTS rows и может увеличить размер local admin storage. На большом корпусе не включайте `trigramIndexEnabled` сразу в production.

Rollout sequence:

1. На staging запустите `POST /api/admin/search-index/trigram/backfill`.
2. Дождитесь `GET /api/admin/search-index/trigram/backfill/status` со `status=completed`.
3. Проверьте `GET /api/admin/search-index/status`: `trigramPopulated=true`.
4. Запустите `node scripts/benchmark-trigram-readiness.mjs --queries <file> --start-backfill` и сохраните JSON report.
5. Включайте `trigramIndexEnabled=true` только если `readiness.passed=true`, p95 latency укладывается в порог и размер SQLite приемлем.

Gateway дополнительно защищает production: `POST /api/admin/rag/config` отклоняет включение trigram с ошибкой `trigram_index_not_ready`, если индекс не покрывает все stored chunks.

## SQLite-first

Для dev/test/pilot:

```env
DATABASE_URL=sqlite://./state/wiki-ai.sqlite
```

Каталог `state/` должен сохраняться между перезапусками Gateway.
Docker images запускают Node.js под non-root пользователем `node`; если
используется bind mount `./state:/app/state`, каталог должен быть доступен на
запись UID/GID контейнера.

SQLite не является production HA/compliance решением для нескольких инстансов.
Если нужен SLA, длительное хранение audit/chat metadata или конкурентная запись,
закладывайте Postgres migration до промышленного запуска.

## Postgres mode

Postgres включается только через `DATABASE_URL`; SQLite остаётся default для
локального dev/pilot. Для compose-профиля:

```bash
export DATABASE_URL=postgresql://wikiai:wikiai-dev-password@postgres:5432/wikiai
docker compose --profile postgres up -d postgres gateway syncer
```

Gateway выполняет Postgres migrations при первом обращении к admin store.
Syncer не читает локальный SQLite-файл: indexing profiles берутся через
`GET /api/internal/indexing-profiles` с `x-wikiai-admin-token`, поэтому
`SYNCER_ADMIN_TOKEN` должен совпадать у Gateway и Syncer.

Для переноса pilot SQLite state в уже проинициализированную Postgres DB:

```bash
SQLITE_DATABASE_URL=sqlite://./state/wiki-ai.sqlite \
POSTGRES_DATABASE_URL=postgresql://wikiai:<password>@127.0.0.1:15433/wikiai \
npm --prefix packages/gateway run migrate:postgres
```

Сначала запустите Gateway с Postgres хотя бы один раз или проверьте, что
migrations применены: скрипт переносит данные, но не создаёт схему.

В admin diagnostics проверяйте:

- `database.dialect=postgres`;
- `database.connectionStatus=ok`;
- `database.migrationStatus=ok`;
- `database.url` redacted и не содержит пароль.

## Когда нужен Postgres

Переходите на Postgres, если появляется хотя бы одно условие:

- production SLA;
- больше одного Gateway/Syncer instance;
- полный trust engine;
- chat archive/export;
- audit log как compliance artifact;
- workflow онтологических черновиков;
- высокая конкуренция записи;
- HA/backup/restore требования;
- SQL analytics.

## MediaWiki Extensions

В тестовом стенде должны быть включены:

- Semantic MediaWiki;
- PageForms;
- VEForAll;
- Wiki AI extension.

### Wiki AI extension artifact

Поставляйте Wiki AI extension как отдельный runtime artifact, а не через
ручной `docker cp` в уже запущенный контейнер. Ручная копия теряется при
пересоздании контейнера MediaWiki.

Сборка artifact:

```bash
node scripts/package-mw-extension.mjs
```

Результат:

```txt
dist/wiki-ai-aiassistant-extension-<version>.tar.gz
```

Если CI runner или локальная среда должны писать artifact в другой каталог:

```bash
node scripts/package-mw-extension.mjs --output-dir /tmp/wiki-ai-artifacts
```

Artifact содержит только runtime-файлы расширения:

- `extension.json`;
- `AIAssistant.alias.php`;
- `src/`;
- `i18n/`;
- `config/`;
- `resources/ai-assistant/dist/`;
- `resources/ai-admin/dist/`.

На стороне заказчика распакуйте архив в стабильный каталог хоста:

```bash
mkdir -p /opt/wiki-ai/extensions
tar -xzf wiki-ai-aiassistant-extension-<version>.tar.gz -C /opt/wiki-ai/extensions
```

Подключите каталог в контейнер MediaWiki read-only:

```yaml
services:
  mediawiki:
    volumes:
      - /opt/wiki-ai/extensions/AIAssistant:/var/www/html/extensions/AIAssistant:ro
```

После обновления artifact выполните maintenance-команды в контейнере MediaWiki:

```bash
php maintenance/run.php update
php maintenance/run.php rebuildLocalisationCache --force
```

Затем перезапустите MediaWiki/PHP runtime, чтобы сбросить PHP/opcache. После
обновления вкладка `RAG / Chunking` в `Служебная:AI-администрирование` должна
показывать режимы `ColBERT full index`, `Hybrid + ColBERT`, секцию
`ColBERT index`, кнопку `Тест` и кнопку `Переиндексировать ColBERT`.

Webhook должен указывать на Syncer:

```php
$wgAIAssistantSyncerUrl = 'http://syncer:3001';
```

Gateway URL:

```php
$wgAIAssistantGatewayUrl = 'http://gateway:3000';
// Optional: explicit browser-facing URL, useful when Gateway URL is Docker-internal.
$wgAIAssistantGatewayPublicUrl = 'http://127.0.0.1:3000';
```

`$wgAIAssistantGatewayUrl` can be Docker-internal for server/container calls. The assistant UI uses `$wgAIAssistantGatewayPublicUrl` for browser `fetch()` calls; if it is empty, the extension rewrites Docker-local hosts such as `gateway` or `host.docker.internal` to the current wiki hostname and keeps the Gateway port.

The Admin UI calls Gateway through a same-origin MediaWiki proxy, so browser cookies keep the normal MediaWiki path/domain rules and do not depend on CORS. The proxy uses `$wgAIAssistantGatewayUrl`; when `gateway` or `host.docker.internal` does not resolve inside the MediaWiki container, the extension falls back to the container default Docker gateway.

## Protected WikiAI Admin Docs

Admin documentation for `Служебная:AI-администрирование` must not be stored in
the public `CorpCommon` namespace. Include the shipped MediaWiki config snippet
after `wfLoadExtension( 'AIAssistant' );`:

```php
require_once "$IP/extensions/AIAssistant/config/corporate-test-settings.php";
```

The snippet defines `WikiAIAdmin` / `WikiAIAdmin_talk`, adds the
`read-wikiaiadmin` right, protects edit/create operations, and denies anonymous
reads through `AIAssistantPageAclRules`:

```php
$wgNamespaceProtection[NS_WIKIAI_ADMIN] = ['read-wikiaiadmin'];
$wgAIAssistantPageAclRules[] = [
    'prefix' => 'WikiAIAdmin:',
    'groups' => ['sysop', 'aiadmin', 'ai-exec'],
];
$wgAIAssistantPageAclRules[] = [
    'prefix' => 'CorpCommon:WikiAI/Администрирование',
    'groups' => ['sysop', 'aiadmin', 'ai-exec'],
];
```

Seed the managed documentation after the namespace is configured:

```bash
node scripts/seed-ai-admin-docs.mjs --dry-run
MW_BASE_URL=http://localhost:8082 MW_ADMIN_USER=Admin MW_ADMIN_PASSWORD=... \
  node scripts/seed-ai-admin-docs.mjs
```

The seed writes new pages under `WikiAIAdmin:Администрирование...` and replaces
legacy `CorpCommon:WikiAI/Администрирование...` managed pages with safe stubs
for upgrade deployments. The legacy prefix is also denied to anonymous readers
by `AIAssistantPageAclRules`, so old admin-doc titles do not appear in anonymous
search.

Syncer must index namespace `3040` as admin-only, not public:

```bash
MW_SERVICE_USERNAME=WikiAISync
MW_SERVICE_PASSWORD='<direct-password-from-protected-env>'
# or:
# MW_SERVICE_PASSWORD_SECRET=wikiai-syncer
# SECRETS_PROVIDER=IndeedPamAapm
# PAMURL=https://pam.example.local
# PAMTOKEN='<application-token>'
# PAMDEFAULTACCOUNTPATH=Vault/MediaWiki
NAMESPACE_ACL='{"0":["*"],"3000":["*"],"3010":["ai-hr","ai-exec"],"3020":["ai-finance","ai-exec"],"3030":["ai-it","ai-exec"],"3040":["sysop","aiadmin","ai-exec"]}'
```

After this migration, run dense and ColBERT reindex. Service-user credentials
must be configured before reindex; otherwise protected pages stay hidden from
anonymous users but Syncer cannot add them to the admin-only index. Reindex
removes old public chunks that may still have `allowed_groups:["*"]`.

Acceptance checks:

```bash
curl 'http://localhost:8082/api.php?action=query&titles=WikiAIAdmin:Администрирование&prop=info&inprop=readable&format=json'
```

Anonymous response must not include `"readable":""`. Qdrant/ColBERT payload for
admin docs must not contain `allowed_groups:["*"]`.

## Secret Handling

Не храните реальные ключи в git. В `.env.example` допустимы только placeholder значения.
