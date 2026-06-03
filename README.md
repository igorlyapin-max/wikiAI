# Wiki AI — AI-поиск и чат-ассистент для MediaWiki

Self-hosted система AI-поиска и чат-ассистента поверх корпоративной MediaWiki с учётом прав чтения пользователей.

## Архитектура

| Компонент | Статус | Примечание |
|-----------|--------|------------|
| MediaWiki | Внешний | Уже развёрнут, не трогаем |
| Redis | Внешний | Уже развёрнут, не трогаем |
| LiteLLM | Внешний | Уже развёрнут, не трогаем |
| Nginx | Внешний | Уже развёрнут, не трогаем |
| Ollama | Внешний | Уже развёрнут (эмбеддинги), не трогаем |
| Qdrant | **Наш** | Поднимаем через docker-compose |
| AI Gateway | **Наш** | Node.js + Fastify + TypeScript |
| Syncer | **Наш** | Node.js, индексация, webhooks |
| MW Extension | **Наш** | PHP + React frontend |

## Принципы безопасности

- **Conservative access**: deny by default
- **Stale access приемлем**, утечка — нет
- **Post-check** через MW API для сомнительных результатов

## Структура

```
wikiAI/
├── docker-compose.yml          # Qdrant, Ollama, Gateway, Syncer
├── .env.example                # Шаблон переменных
├── README.md
├── packages/
│   ├── gateway/                # AI Gateway (Node.js + Fastify + TS)
│   ├── mcp-adapter/            # MCP adapter over Gateway external API
│   ├── syncer/                 # Индексатор (Node.js)
│   └── mw-extension/           # MediaWiki Extension (PHP + React)
└── scripts/
```

## Быстрый старт

### 1. Локальные сервисы

```bash
cp .env.example .env
# Отредактируй .env — укажи URL существующих внешних сервисов,
# LITELLM_API_KEY и SYNCER_ADMIN_TOKEN для docker-compose/production

docker-compose up -d
```

Если локальный стенд использует уже поднятые контейнеры `servicedesk-agents`
для Redis/LiteLLM и отдельный контейнер `mediawiki`, запускай WikiAI с override:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-servicedesk.yml up -d gateway syncer
```

Override подключает Gateway/Syncer к сетям `servicedesk-agents_default` и
`mediawiki_default` и использует container DNS (`redis`, `litellm`, `mediawiki`)
вместо `host.docker.internal`. Это локальная схема стенда, не обязательная
схема поставки заказчику.

### 2. Gateway

```bash
cd packages/gateway
npm install
npm run dev
```

### 3. Syncer

```bash
cd packages/syncer
npm install
npm run dev
```

### 4. MW Extension

Для передачи заказчику собирай runtime artifact расширения:

```bash
node scripts/package-mw-extension.mjs
```

Архив появится в `dist/wiki-ai-aiassistant-extension-<version>.tar.gz`.
Для нестандартного output path используй:

```bash
node scripts/package-mw-extension.mjs --output-dir /tmp/wiki-ai-artifacts
```

На стороне MediaWiki его нужно распаковать в стабильный каталог на хосте и
смонтировать в контейнер:

```bash
mkdir -p /opt/wiki-ai/extensions
tar -xzf dist/wiki-ai-aiassistant-extension-0.1.0.tar.gz -C /opt/wiki-ai/extensions
```

```yaml
volumes:
  - /opt/wiki-ai/extensions/AIAssistant:/var/www/html/extensions/AIAssistant:ro
```

Такой mount переживает пересоздание контейнера `mediawiki`. `docker cp` подходит
только как временный hotfix, потому что пропадает при recreate контейнера.

Для локальной разработки можно копировать исходники напрямую:

```bash
cd packages/mw-extension
cp -r . /var/www/html/extensions/AIAssistant

# Добавь в LocalSettings.php:
# wfLoadExtension('AIAssistant');
# Для production рекомендуется same-origin reverse proxy:
# /api/* -> AI Gateway, обычные wiki routes -> MediaWiki.
# При таком режиме оставь $wgAIAssistantGatewayUrl пустым.
# $wgAIAssistantGatewayUrl = '';
# Если $wgAIAssistantGatewayUrl указывает на Docker-internal host
# gateway/host.docker.internal, для браузера можно явно задать:
# $wgAIAssistantGatewayPublicUrl = 'http://127.0.0.1:3000';
# Admin UI ходит к Gateway через same-origin MediaWiki proxy и использует
# $wgAIAssistantGatewayUrl как server-side URL. Если host.docker.internal
# не резолвится внутри контейнера, расширение пробует default Docker gateway.
# $wgAIAssistantSyncerUrl = 'http://syncer-host:3001';

php maintenance/update.php
```

### 5. Frontend

```bash
cd packages/mw-extension/resources/ai-assistant
npm install
npm run build
```

Для локального Vite UI Gateway разрешает `http://localhost:5173` и
`http://127.0.0.1:5173` через `CORS_ORIGINS`. Cookie MediaWiki отправляются
только при активной сессии на том же hostname.

### 6. Переиндексация

```bash
cd packages/syncer
npm run build
node dist/cli/reindex.js
```

Ручная переиндексация без `maxPages` обходит все страницы, подходящие под
профиль, namespace и фильтры. `maxPages` нужен только для пробного запуска;
`chunks` в результате означает количество RAG-фрагментов после разбиения
страниц, а не количество страниц.

### 7. Корпоративный тестовый контент

Для проверки прав чтения на стенде подключи test snippet после `wfLoadExtension('AIAssistant')`:

```php
require_once "$IP/extensions/AIAssistant/config/corporate-test-settings.php";
```

Затем создай пользователей, группы и страницы через API:

```bash
MW_BASE_URL=http://localhost:8082 \
MW_ADMIN_USER=Admin \
MW_ADMIN_PASSWORD=... \
MW_SEED_PASSWORD=... \
node scripts/seed-corporate-wiki.mjs
```

Скрипт создаёт 3 департамента, 9 отделов, 4 общих приказа, 4 тестовых
пользователя и тестовые исключения прав чтения на уровне страниц для худших сценариев.

Для индексации закрытых namespace Syncer должен входить в MediaWiki отдельным
сервисным пользователем из `ai-exec`/`aiadmin` или другой группы, разрешенной
`NAMESPACE_ACL`/read ACL. Основной путь развертывания: `MW_SERVICE_USERNAME` +
`MW_SERVICE_PASSWORD`. Пароль можно передать напрямую из защищенного env/config
или как `MW_SERVICE_PASSWORD=secret://Vault/MediaWiki/wikiai-syncer` /
`MW_SERVICE_PASSWORD_SECRET=wikiai-syncer` с `SECRETS_PROVIDER=IndeedPamAapm`.
`MW_SYNC_COOKIE` оставлен только как deprecated fallback для старых стендов:
runtime cookie может истечь и не должен быть основным механизмом у заказчика.

### 8. Документация AI-администрирования в wiki

Управляемые страницы справки для `Служебная:AI-администрирование` публикуются
отдельным seed-скриптом. Они создаются в защищенном namespace
`WikiAIAdmin:Администрирование` и перезаписываются при каждом запуске seed.
Поставляемый `packages/mw-extension/config/corporate-test-settings.php`
добавляет namespace `WikiAIAdmin`, право `read-wikiaiadmin` и read-ACL правило
`WikiAIAdmin:` в `$wgAIAssistantPageAclRules`, закрывающее страницы для
anonymous. Старые публичные managed pages
`CorpCommon:WikiAI/Администрирование...` при запуске seed заменяются безопасными
stub-страницами для апгрейда старых стендов и закрываются тем же read-ACL для
anonymous, чтобы старые заголовки не возвращались в anonymous search.

```bash
node scripts/seed-ai-admin-docs.mjs --dry-run

MW_BASE_URL=http://localhost:8082 \
MW_ADMIN_USER=Admin \
MW_ADMIN_PASSWORD=... \
node scripts/seed-ai-admin-docs.mjs
```

В Admin UI ссылка `Справка` ведет на центральную страницу документации.

После миграции admin docs выполните full reindex dense и ColBERT, чтобы старые
chunks из публичного `CorpCommon` были удалены или перезаписаны. Для Syncer
должны быть заданы service-user credentials, а
`NAMESPACE_ACL` должен включать защищенный namespace:

```bash
NAMESPACE_ACL='{"0":["*"],"3000":["*"],"3010":["ai-hr","ai-exec"],"3020":["ai-finance","ai-exec"],"3030":["ai-it","ai-exec"],"3040":["sysop","aiadmin","ai-exec"]}'
```

Живая проверка прав без LLM/OpenAI:

```bash
RUN_MW_SEED_LIVE=1 MW_BASE_URL=http://localhost:8082 MW_SEED_PASSWORD=... \
node scripts/verify-corporate-acl-live.mjs
```

## GitLab CI

В репозитории есть `.gitlab-ci.yml` для базового quality gate:

- проверка whitespace diff, i18n JSON и `scripts/*.mjs`;
- проверка контрактов Gateway OpenAPI, Syncer webhook schema и MCP adapter;
- Gateway lint/test/typecheck/build;
- Syncer test/typecheck/build;
- MCP adapter syntax check;
- Docker build Gateway и Syncer без push;
- блокирующий secret scan;
- блокирующий `npm audit --audit-level=high --omit=dev` для Gateway и Syncer.

Live-проверки, которые могут требовать стенд или платный LLM/LiteLLM endpoint,
оформлены manual jobs и не стартуют автоматически.

Для `docker compose up` теперь нужно явно передать `LITELLM_API_KEY` и
`SYNCER_ADMIN_TOKEN` через окружение или `.env`; дефолтные `changeme-*`
значения не используются.

## Semantic MediaWiki / VEForAll rollout

Файлы ТЗ оставлены раздельно:

- `TZ_MediaWiki_AI_Knowledge_Management_v1.2.md` — базовый AI/RAG контур с проверкой прав чтения.
- `TZ_SMW_AI_Integration_v1.2.md` — SMW, Page Forms, VEForAll, онтология и
  AI-разметка.

Сводный план внедрения: `docs/roadmap-ai-smw.md`. Операционный runbook:
`docs/deployment-smw-veforall.md`.

Перед установкой расширений выполни read-only аудит:

```bash
node scripts/audit-smw-rollout.mjs
node scripts/audit-smw-rollout.mjs --json
```

Текущее состояние тестового стенда: MediaWiki 1.45.3, PHP 8.3.31, VisualEditor
установлен, SemanticMediaWiki 7.0.0-alpha, PageForms 6.0.8, VEForAll 0.8.
Стабильный SMW 6.0.1 не подошел к MediaWiki 1.45.3 на этом стенде; для проверки
используется `mediawiki/semantic-media-wiki:dev-master`.

Порядок rollout:

1. Backup базы, `images/`, `LocalSettings.php`, `extensions/` и composer-файлов.
2. Подготовить воспроизводимый Composer strategy: новый image или disposable
   composer container с совместимой PHP-версией.
3. Установить совместимые Semantic MediaWiki, Page Forms и VEForAll.
4. Включить расширения во внешнем `LocalSettings.php`.
5. Выполнить MediaWiki update и SMW setup/rebuild maintenance scripts.
6. Создать свойства/forms и выполнить semantic reindex.
7. Принять live-проверку прав чтения и базовые тесты без OpenAI; live LLM extraction
   запускать только отдельным opt-in набором с лимитами бюджета.

Семантический seed без OpenAI:

```bash
node scripts/seed-semantic-wiki.mjs --dry-run
node scripts/seed-semantic-wiki.mjs
```

Центральная semantic-страница:

```txt
http://127.0.0.1:8082/index.php/CorpCommon:Семантическая_навигация
```

Для SMW в корпоративных namespace включены семантические ссылки:
`3000`, `3010`, `3020`, `3030`.

Syncer индексирует SMW facts без LLM/OpenAI, если включено:

```bash
SMW_SYNC_ENABLED=true
SMW_SYNC_PROPERTIES=Департамент,Отдел,Тип документа,Владелец процесса,Статус документа,Система,Процесс,Дата действия,Критичность
```

`SMW_SYNC_PROPERTIES` используется как bootstrap/fallback. В рабочем режиме список
SMW-свойств для индексации задается в AI-админке во вкладке `Онтологические
векторы`: у свойства должен быть включен флаг `Индексировать`.

Узкая live-проверка без платных API:

```bash
MW_BASE_URL=http://127.0.0.1:8082 \
QDRANT_URL=http://127.0.0.1:6333 \
OLLAMA_BASE_URL=http://127.0.0.1:11434 \
SMW_SYNC_ENABLED=true \
ENABLE_ATTACHMENTS=false \
npm --prefix packages/syncer run reindex
```

Проверка, что `semantic_facts` в Qdrant лежат в payload, а финальный RAG-доступ дополнительно проверяется через MediaWiki `readable` для каждой страницы:

```bash
node scripts/verify-semantic-payload-acl.mjs
node scripts/verify-semantic-payload-acl.mjs --json
```

Полная live-переиндексация корпоративных namespace без OpenAI:

```bash
node scripts/reindex-corporate-semantic-live.mjs
```

Скрипт создает/обновляет тестового пользователя `wiki_sync_service` в группе
`ai-exec`, получает MediaWiki session cookie в памяти процесса и запускает
Syncer reindex с `SMW_SYNC_ENABLED=true`.

## API

| Сервис | Endpoint | Описание |
|--------|----------|----------|
| Gateway | `GET /live` | Liveness процесса |
| Gateway | `GET /ready` | Readiness зависимостей |
| Gateway | `GET /health` | Совместимый alias readiness |
| Gateway | `GET /metrics` | Prometheus-compatible runtime metrics |
| Gateway | `POST /api/search` | AI-поиск с проверкой прав чтения |
| Gateway | `POST /api/chat` | Чат-ассистент (SSE) |
| Gateway | `GET /api/v1/capabilities` | Возможности внешнего REST API/MCP |
| Gateway | `POST /api/v1/search` | Стабильный внешний поиск; cookie или OIDC Bearer, anonymous если разрешён |
| Gateway | `POST /api/v1/chat` | Стабильный внешний чат; cookie или OIDC Bearer |
| Gateway | `GET /api/admin/external-api/config` | Админская конфигурация внешнего API/OIDC/MCP |
| Gateway | `POST /api/admin/external-api/config` | Сохранение конфигурации внешнего API/OIDC/MCP |
| Gateway | `GET /api/admin/document-processing` | Политика распознавания документов |
| Gateway | `GET /api/admin/semantic/status` | Статистика SMW facts в Qdrant без LLM |
| Gateway | `GET /api/admin/semantic/search?property=Департамент&value=ИТ%20департамент` | Диагностический поиск по SMW-свойствам без LLM |
| Gateway | `POST /api/admin/reindex` | Запуск Syncer reindex из админки без OpenAI |
| Gateway | `GET /api/admin/reindex/status` | Статус последнего Syncer reindex job |
| Syncer | `GET /live` | Liveness процесса |
| Syncer | `GET /ready` | Readiness зависимостей |
| Syncer | `GET /health` | Совместимый alias readiness |
| Syncer | `GET /metrics` | Prometheus-compatible runtime metrics |
| Syncer | `POST /admin/reindex` | Внутренний запуск reindex job; в production требует `SYNCER_ADMIN_TOKEN` |
| Syncer | `GET /admin/reindex/status` | Внутренний статус reindex job |
| Syncer | `POST /webhook/page` | Webhook от MediaWiki |

Админский UI для этих проверок доступен на странице:
`http://127.0.0.1:8082/index.php/Служебная:AI-администрирование`.

### Внешний REST API и MCP

Внешний API по умолчанию выключен. Заказчик включает его во вкладке
`Внешний API` или через env `EXTERNAL_API_ENABLED=true`. Для сторонних
приложений задаются `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` и claim
names; Gateway проверяет JWT Bearer локально по JWKS и после retrieval по
умолчанию делает MediaWiki readable-check. Режим `groups_only` доступен только
как явный fallback и доверяет проиндексированным `allowed_groups`.

MCP adapter запускается поверх того же REST API:

```bash
WIKIAI_GATEWAY_URL=http://127.0.0.1:3000 \
WIKIAI_ACCESS_TOKEN=<oidc-access-token> \
node packages/mcp-adapter/src/server.mjs
```

Для embedded/админского сценария вместо Bearer можно передать
`WIKIAI_COOKIE`, но для заказчика основной production-путь для внешних систем -
OIDC Bearer.

## AD-интеграция (этап заказчика)

1. Установить LDAP Stack в MW: PluggableAuth + LDAPProvider + LDAPAuthentication2 + LDAPGroups
2. Настроить `nestedgroups: true`
3. Gateway и Syncer **не меняются** — они работают с MW-группами

## Лицензия

MIT
