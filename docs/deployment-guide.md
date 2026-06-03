# Wiki AI Deployment Guide

## Required Services

- MediaWiki + Semantic MediaWiki.
- PageForms и VEForAll для расширенного редактирования форм.
- Gateway.
- Syncer.
- Redis.
- Qdrant.
- Ollama для локальных embeddings.
- LiteLLM/OpenAI-compatible endpoint для LLM ответов.

Gateway runtime должен запускаться на Node.js 24+ из-за встроенного SQLite-модуля `node:sqlite`.

## MediaWiki Extension Frontend Asset

MediaWiki ResourceLoader подключает `packages/mw-extension/resources/ai-assistant/dist/index.js`.
Каталог `dist/` не хранится в git, поэтому deployment pipeline или сборка
MediaWiki-образа должны собрать frontend перед копированием расширения:

```bash
npm --prefix packages/mw-extension/resources/ai-assistant ci
npm --prefix packages/mw-extension/resources/ai-assistant run build
```

После этого копируйте `packages/mw-extension` в
`$MEDIAWIKI_EXTENSIONS/AIAssistant`. Если extension directory не bind-mounted,
runtime-обновление файлов внутри контейнера потеряется при пересоздании
MediaWiki; для заказчика сборка должна быть частью образа или поставочного
архива.

## Environment

Базовые переменные:

- `DATABASE_URL` - admin config DB, default `sqlite://./state/wiki-ai.sqlite`.
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
- `REDIS_URL`
- `QDRANT_URL`
- `QDRANT_COLLECTION`
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
`SYNCER_ADMIN_TOKEN`, `OPENAI_API_KEY` не должны иметь `changeme-*` дефолтов в compose или CI.
Перед запуском стенда задавайте их через защищенные переменные окружения,
секрет-хранилище или локальный `.env`, который не коммитится.

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

## Optional ColBERT index

ColBERT search выключен по умолчанию на уровне Admin UI, но `docker-compose.yml` содержит on-prem CPU pilot service. Gateway может использовать его двумя способами: `colbert_full` как отдельный late-interaction index или `hybrid_colbert` как rerank текущих Qdrant/BM25 кандидатов.

```env
COLBERT_BASE_URL=http://colbert:8080
COLBERT_MODEL=antoinelouis/colbert-xm
COLBERT_COLLECTION=wiki_colbert_chunks
COLBERT_DEVICE=cpu
COLBERT_MAX_TOKENS=180
```

С хоста тестового стенда сервис доступен как `http://127.0.0.1:8083`. Внутри Docker Gateway обращается к `http://colbert:8080`.

Syncer не пишет в ColBERT напрямую. Он уже отправляет page chunks в Gateway internal search-index endpoint; Gateway обновляет BM25 и дополнительно вызывает ColBERT `/index/page` или `/index/delete-page`. Поэтому webhook edit/delete и full reindex поддерживают ColBERT без отдельной ручной процедуры.

Gateway применяет MediaWiki ACL и trust policy перед пользовательской выдачей. ColBERT не заменяет Qdrant, BM25, Postgres или права доступа и сам по себе не вызывает OpenAI. Стоимость CPU/RAM зависит от размера wiki, `COLBERT_MAX_TOKENS`, `colbertCandidateLimit` и выбранной модели.

## SQLite-first

Для dev/test/pilot:

```env
DATABASE_URL=sqlite://./state/wiki-ai.sqlite
```

Каталог `state/` должен сохраняться между перезапусками Gateway.
Docker images запускают Node.js под non-root пользователем `node`; если
используется bind mount `./state:/app/state`, каталог должен быть доступен на
запись UID/GID контейнера.

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
- `resources/ai-assistant/dist/`.

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
