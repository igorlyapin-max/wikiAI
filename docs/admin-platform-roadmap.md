# Roadmap: Wiki AI Administration Platform

Документ фиксирует объединенный план развития администрирования Wiki AI по материалам `TZ_*`, текущему коду Gateway/Syncer/MediaWiki extension и обсужденным требованиям.

## Цель

Администрирование должно управлять не только параметрами ответа LLM, но и всей эксплуатационной поверхностью RAG-платформы:

- подключениями к сервисам;
- настройками LLM и embeddings;
- webhook от MediaWiki;
- chunking/RAG;
- направлениями индексации;
- распознаванием документов;
- моделью доверия к источникам;
- хранением чатов;
- онтологическими векторами SMW;
- аудитом и диагностикой.

## Архитектурные решения

- Хранилище конфигурации: SQLite-first для dev/test/pilot.
- Переход на Postgres: при production SLA, нескольких инстансах Gateway/Syncer, полном trust engine, chat archive/export, compliance-аудите, workflow онтологий или высокой конкуренции записи.
- Векторы контента и онтологий остаются в Qdrant.
- SQL хранит конфигурацию, профили, audit log, метаданные доверия, chat retention и онтологические метаданные.
- Redis остается совместимым runtime fallback на период миграции существующих настроек.
- Secrets не возвращаются через API и не пишутся в audit log.
- OpenAI/LiteLLM live smoke тесты только opt-in из-за стоимости API.

## Этапы

### 1. Базовый фундамент

- [x] Сохранить объединенный roadmap в `docs/admin-platform-roadmap.md`.
- [x] Добавить `DATABASE_URL` с default `sqlite://./state/wiki-ai.sqlite`.
- [x] Добавить SQLite/Postgres-compatible DAL interfaces.
- [x] Реализовать Postgres adapter для admin/chat/config state и internal Syncer profile lookup через Gateway API.
- [x] Добавить миграции для базовых admin tables.
- [x] Подключить audit log для реализованных admin mutations.
- [x] Оставить Redis fallback для уже существующих runtime settings.

### 2. Admin UI skeleton

- [x] Перестроить `Служебная:AI-администрирование` на вкладки:
  - `Обзор`;
  - `Сервисы`;
  - `LLM`;
  - `Embeddings`;
  - `Webhook`;
  - `RAG / Chunking`;
  - `Индексация`;
  - `Распознавание документов`;
  - `Модель доверия`;
  - `Управление чатами`;
  - `Онтологические векторы`;
  - `Логи`.
- [x] Перенести текущие блоки:
  - runtime LLM settings -> `LLM`;
  - MIME policy -> `Распознавание документов`;
  - semantic diagnostics -> `Онтологические векторы`;
  - reindex -> `Индексация`;
  - service health -> `Обзор` и `Сервисы`.

Статус: реализовано. Добавлены вкладки `Обзор`, `Сервисы`, `LLM`, `Embeddings`, `Webhook`, `RAG / Chunking`, `Индексация`, `Распознавание документов`, `Модель доверия`, `Управление чатами`, `Онтологические векторы`, `Логи`; текущие runtime/settings/document/semantic/reindex/chat-management/chat-retention/trust-preview блоки разнесены по ним.

### 3. Operational Config

- [x] Управление MediaWiki: `MW_BASE_URL`, `MW_API_PATH`.
- [x] Управление Gateway: port/status, CORS origins.
- [x] Управление Syncer: URL, admin token status, health.
- [x] Диагностика Redis: URL/status only.
- [x] Диагностика Qdrant: URL, collection, vector dimension compatibility.
- [x] Управление LiteLLM: provider, base URL, model, timeout, test connection.
- [x] Управление embeddings: base URL, embedding model, vector dimension, test embedding.
- [x] API не показывает secrets, только `configured: true/false`.

### 4. Webhook Administration

- [x] Показывать текущий `$wgAIAssistantSyncerUrl`.
- [x] Настраивать события `edit`, `delete`, `move`, `protect`.
- [x] Настраивать timeout, retry count, retry backoff.
- [x] Показывать last webhook status.
- [x] Добавить safe webhook test.
- [x] Предупреждать, если MediaWiki webhook URL не совпадает с ожидаемым Syncer URL.

### 5. RAG / Chunking

- [x] Настройки `chunkSize`, `chunkOverlap`, `chunkSeparators`.
- [x] Настройки `minChunkLength`, `maxChunksPerPage`.
- [x] Настройки retrieval: profile-level `retrievalTopK`, `contextTopK`, `contextMaxChars`, `minSearchScore`.
- [x] Настройки semantic enrichment: `semanticFactsInContext`, `includeAttachments`, `includeSemanticHeader`.
- [x] Источник истины для chunking: indexing profile / Syncer config.

Статус: параметры сохраняются через admin API и отображаются в UI. Runtime применяет profile-level `retrievalTopK` для финальной выдачи, `contextTopK/contextMaxChars` для prompt context и совместимые legacy поля `topK`, `chunkSize`, `chunkOverlap`; остальные поля ждут profile-driven Syncer/RAG интеграции.

### 6. Indexing Profiles

- [x] Сущность profile:
  - name;
  - namespaces;
  - SMW properties из онтологии по флагу `indexed`;
  - chunking profile;
  - attachments enabled;
  - semantic facts enabled;
  - ontology vectors enabled;
  - dry-run defaults;
  - maxPages defaults;
- [x] title/category filters, включая selector MediaWiki-категорий в Admin UI;
- [x] document MIME policy binding;
- [x] manual/scheduled mode.
- [x] Reindex по выбранному profile.
- [x] Gateway endpoint `POST /api/admin/reindex { profileId, dryRun?, maxPages? }`.
- [x] Gateway разворачивает profile в Syncer job options.
- [x] Syncer применяет profile-driven chunking, dry-run и title/category filters.
- [x] Syncer читает profile напрямую из общего SQL-хранилища.

Статус: Gateway хранит расширенные profiles и разворачивает их в reindex job options. Syncer фильтрует страницы по title/category до `maxPages`, принимает `documentPolicyId` и run mode metadata. Category filters выбираются из MediaWiki categories selector и сравниваются точным совпадением по нормализованному имени категории. При запуске с `profileId` Syncer также умеет загрузить profile defaults из общего SQLite admin storage `ai_admin_config`. Gateway scheduler запускает profiles с `runMode=scheduled` по `scheduleIntervalMinutes`, передавая Syncer только `profileId`.

### 7. Trust Engine

- [x] Trust models.
- [x] Trust entities: namespace, category, tag, author group, page property, template, date property, SMW property.
- [x] Trust rules: condition, modifier, flags, exclude from index, require manual approval, notify author, display order.
- [x] Trust score preview по тестовым метаданным страницы.
- [x] Manual bulk recalculation с `dryRun`, `maxScan`, `batchSize`.
- [x] Qdrant payload: `trust_score`, `trust_flags`, `applied_rules`, `trust_model_id`.
- [x] Qdrant payload indexes для trust-фильтров.
- [x] Automatic trust recalculation после successful non-dry-run reindex status.
- [x] Automatic page-scoped trust recalculation после webhook `edit/move/protect`.
- [x] Scheduled trust recalculation.
- [x] Runtime search/chat фильтры: `minTrustScoreForContext`, `includeDrafts`, `stalenessPenaltyPerYear`, `requireVerifiedForDirectAnswer`, `requireSources`.

Статус: CRUD, preview, runtime-фильтрация `search/chat`, manual Qdrant payload recalculation, Qdrant payload indexes, автопересчет после completed reindex status, page-scoped пересчет после webhook и scheduled recalculation реализованы без LLM/OpenAI. По trust block остаются production hardening и расширенная приемка на стенде.

### 8. Chat Retention

- [x] Конфигурация `retentionMode`: `auto_delete | archive | export_then_archive`.
- [x] Настройки `activeDays`, `recentDays`, `archiveDays`.
- [x] Лимиты `maxPinnedChats`, `maxActiveChats`, `maxTotalChats` сохраняются в config.
- [x] Политика `onLimitExceeded` сохраняется в config.
- [x] Export options: formats, metadata, sources.
- [x] Применить retention policy к Redis TTL истории чатов.
- [x] SQL-схема под chat sessions/messages/archive/export.
- [x] Применить лимиты к реестру chat sessions.
- [x] Admin API для просмотра sessions/messages, ручного archive и export.

Статус: Gateway пишет историю в SQL registry и сохраняет Redis как быстрый runtime cache. `maxActiveChats`, `maxTotalChats` и `onLimitExceeded` применяются при создании новой активной сессии; default policy архивирует активные чаты через 7 дней. UI вкладки `Управление чатами` показывает chat profiles, registry counters, последние chat sessions и read-only просмотр выбранной session; пользовательская вкладка `Чат` показывает active/archive историю с названием из первого вопроса и выгрузкой всего собственного архива.

### 9. Ontology Vectors

- [x] Управление SMW property metadata:
  - name, label, description;
  - data type, format, unit;
  - `aiExtractable`;
  - `aiPromptHint`;
  - `classificationThreshold`;
  - `sensitive`;
  - required right;
  - vector status/model/dimension/generatedAt.
- [x] Actions: generate vector, regenerate vector, find similar, clusterize, show isolated properties.
- [x] Action: classify fragment по ontology vectors.
- [x] Embeddings по умолчанию через local Ollama.
- [x] OpenAI не использовать без opt-in.

Статус: metadata CRUD, генерация локальных ontology vectors, similarity search, clusterize и classify fragment реализованы. Admin API не возвращает сырой embedding-массив; OpenAI/LiteLLM в этом блоке не вызывается. Свойства с включенным исключением обработки исключаются из классификации без явного `includeSensitive=true`.

### 10. Public Admin APIs

- [x] `GET/POST /api/admin/service-config`
- [x] `POST /api/admin/service-config/test`
- [x] `GET/POST /api/admin/llm/config`
- [x] `POST /api/admin/llm/test`
- [x] `GET/POST /api/admin/embedding/config`
- [x] `POST /api/admin/embedding/test`
- [x] `GET/POST /api/admin/webhook/config`
- [x] `POST /api/admin/webhook/test`
- [x] `GET/POST /api/admin/rag/config`
- [x] `GET/POST /api/admin/indexing-profiles`
- [x] `POST /api/admin/reindex`
- [x] `GET/POST /api/admin/trust-models`
- [x] `GET/POST /api/admin/trust-models/:id/entities`
- [x] `GET/POST /api/admin/trust-models/:id/entities/:entityId/rules`
- [x] `POST /api/admin/trust-models/:id/preview`
- [x] `POST /api/admin/trust-scores/recalculate`
- [x] `GET/POST /api/admin/trust-recalculation/config`
- [x] `POST /api/internal/trust/recalculate-page`
- [x] `GET/POST /api/admin/chat-management/config`
- [x] `GET/POST /api/admin/chat-profiles`
- [x] `POST /api/admin/chat-profiles/restore-defaults`
- [x] `GET/POST /api/admin/chat-retention/config`
- [x] `GET /api/admin/chat-sessions`
- [x] `GET /api/admin/chat-sessions/:id/messages`
- [x] `POST /api/admin/chat-sessions/:id/archive`
- [x] `POST /api/admin/chat-sessions/:id/export`
- [x] `GET/POST /api/admin/smw/ontology`
- [x] `POST /api/admin/smw/ontology/:id/generate-vector`
- [x] `GET /api/admin/smw/ontology/:id/similarities`
- [x] `POST /api/admin/smw/ontology/clusterize`
- [x] `POST /api/admin/smw/ontology/classify-fragment`
- [x] `GET /api/admin/audit-log`

Existing endpoints remain compatible:

- `/api/admin/config`;
- `/api/admin/document-processing`;
- `/api/admin/semantic/status`;
- `/api/admin/semantic/search`;
- `/api/admin/reindex/status`.

### 11. Documentation

- [x] `docs/admin-guide.md`
- [x] `docs/operations-runbook.md`
- [x] `docs/deployment-guide.md`
- [x] `docs/acceptance-checklist.md`

### 12. GitLab CI / Release Gates

- [x] Добавить `.gitlab-ci.yml` с этапами `validate`, `test`, `typecheck`, `build`, `docker`, `security`.
- [x] Проверять i18n JSON, `scripts/*.mjs`, unit/API тесты Gateway и Syncer, TypeScript typecheck и production build.
- [x] Собирать Docker images Gateway и Syncer без push.
- [x] Добавить блокирующий secret scan для продуктовых файлов и конфигурации.
- [x] Оставить live-интеграции и LiteLLM/OpenAI smoke только manual/opt-in, чтобы не тратить платный API автоматически.
- [x] Убрать небезопасные `changeme-*` runtime defaults из compose/env examples.
- [x] Запускать сервисы в Docker images под non-root пользователем.
- [x] Закрыть текущий `npm audit` baseline Fastify/fast-uri через major-upgrade Fastify и проверку совместимости plugins/API.

Статус: Gateway и Syncer переведены на Fastify 5 line, plugin major versions
обновлены, `security:npm-audit` больше не `allow_failure`.

## Acceptance Strategy

- Unit tests for migrations, config precedence, secret redaction, validation, trust calculation, retention TTL and ontology metadata.
- API tests for admin auth, non-admin rejection, secret redaction, invalid config rejection, safe diagnostics and profile-driven reindex.
- Integration tests without OpenAI: SQLite, Redis, Qdrant, Ollama embeddings, limited reindex and Qdrant payload verification.
- Live tests with OpenAI/LiteLLM only by explicit opt-in and token budget guard.
