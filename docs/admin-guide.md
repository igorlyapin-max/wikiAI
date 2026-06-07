# Wiki AI Admin Guide

## Доступ

Админка MediaWiki: `Служебная:AI-администрирование`.

Доступ должен быть только у пользователей с группой `sysop` или `aiadmin`. Все admin API должны возвращать `403`, если пользователь не входит в одну из этих групп.

## Язык Интерфейса

Admin UI использует стандартную i18n-модель MediaWiki: язык берется из языка интерфейса пользователя или из параметра URL `uselang`.

- русский: `Служебная:AI-администрирование?uselang=ru`;
- английский: `Special:AIAdmin?uselang=en`.

Серверная разметка и строки inline-JS берутся из `packages/mw-extension/i18n/ru.json` и `packages/mw-extension/i18n/en.json`. Значения, полученные из API как данные конфигурации, enum/status или диагностические ошибки внешних сервисов, не переводятся автоматически.

## Документация в Wiki

Пользовательская документация админки публикуется как управляемые wiki-страницы:

- центральная страница: `WikiAIAdmin:Администрирование`;
- seed: `scripts/seed-ai-admin-docs.mjs`;
- dry run: `node scripts/seed-ai-admin-docs.mjs --dry-run`.

Seed перезаписывает все управляемые страницы при каждом запуске. В начале каждой страницы есть предупреждение, что локальные постоянные заметки нужно хранить на дочерних страницах вне управляемого списка.

Namespace `WikiAIAdmin` должен быть закрыт read-ACL правилом расширения:
`['prefix' => 'WikiAIAdmin:', 'groups' => ['sysop', 'aiadmin', 'ai-exec']]`
в `$wgAIAssistantPageAclRules`. `$wgNamespaceProtection[NS_WIKIAI_ADMIN]`
оставляется для защиты операций изменения страниц.
Неавторизованный пользователь не должен получать `readable` для этих страниц через MediaWiki API.
При апгрейде со старой схемы seed заменяет legacy-страницы
`CorpCommon:WikiAI/Администрирование...` безопасными stub-страницами, а read-ACL
закрывает legacy-префикс от неавторизованного доступа, чтобы старые заголовки не появлялись в
поиске без авторизации. После миграции нужен full reindex dense и ColBERT, чтобы
убрать старое содержимое из Qdrant.

В `Служебная:AI-администрирование` ссылка `Справка` ведет на центральную wiki-страницу документации.

## Основные разделы

Планируемая структура админки:

- `Обзор` - состояние Gateway, Syncer, Redis, Qdrant, LiteLLM/Ollama.
- `Сервисы` - базовые URL и статусы подключений.
- `OpenSearch` - отдельная вкладка для URL/index/analyzer/boosts, readiness, analyze/search preview.
- `LLM` - LiteLLM transport, default model/fallback generation settings, smoke test.
- `Embeddings` - embedding provider/model, vector dimension, test embedding.
- `Webhook` - endpoint Syncer, события, timeout/retry, last status, test.
- `RAG / Chunking` - chunk size, overlap, separators; объем выдачи и prompt context настраиваются в `Профили поиска`.
- `Debug цепочки` - отладка одного пользовательского запроса по всей цепочке: профиль, retrieval, ACL/trust, context, prompt и LLM.
- `Индексация` - profiles, filters, SMW properties, manual reindex.
- `Распознавание документов` - MIME policy и режимы `text`, `ocr`, `metadata`, `disabled`.
- `Модель доверия` - активная trust model, правила доверия, preview и пересчет payload.
- `Управление чатами` - chat profiles для prompt/retrieval history, TTL, archive/export policy, limits.
- `Онтологические векторы` - SMW property metadata, vectors, similarities, clusters.
- `Внешний API` - REST API/MCP, OIDC Bearer auth, лимиты top-k и ACL mode для внешних систем.
- `Логи` - audit log изменений администрирования.

Кнопка `Test` во вкладке `Сервисы` проверяет Syncer `/health`, показывает redacted database URL, диагностирует Qdrant collection и OpenSearch status, если он включен. OpenSearch password/API key не показываются: UI видит только `authConfigured`.

## Secrets

Админка не должна показывать значения секретов:

- `LITELLM_API_KEY`;
- `SYNCER_ADMIN_TOKEN`;
- `OPENSEARCH_PASSWORD`;
- `OPENSEARCH_API_KEY`;
- session cookies;
- любые будущие provider keys.

UI и API показывают только признак `configured: true/false`.

## Внешний REST API и MCP

Вкладка `Внешний API` управляет стабильным API для сторонних приложений. Встроенный поиск и чат MediaWiki продолжают работать через `/api/search` и `/api/chat`; новые endpoint'ы находятся в `/api/v1/*`.

Endpoint'ы:

- `GET /api/v1/capabilities` - публичное описание включенных возможностей, auth modes, max top-k, ACL mode и предупреждений.
- `POST /api/v1/search` - внешний поиск. Поддерживает MediaWiki cookie, OIDC Bearer или anonymous, если включен `anonymousSearchAllowed`.
- `POST /api/v1/chat` - внешний чат. Требует MediaWiki cookie или OIDC Bearer; anonymous chat запрещен.
- `GET /api/admin/external-api/config` - чтение конфигурации администратором.
- `POST /api/admin/external-api/config` - сохранение конфигурации администратором.

OIDC-настройки:

- `issuer`, `audience`, `jwksUrl`;
- claim names: `subjectClaim`, `usernameClaim`, `groupsClaim`.

Gateway проверяет JWT Bearer локально: `RS256`, подпись по JWKS, `iss`, `aud`, `exp`, `nbf`. Секретов OIDC в UI нет; JWKS URL публичен для проверки подписи, access token передается только в запросе клиента.

Если `groupsClaim` содержит AD DN вида `CN=...,OU=...,DC=...`, настройте IdP так,
чтобы claim был массивом строк. Строковый claim Gateway делит только по пробелам
или `;`; запятая не считается разделителем групп, потому что она является частью
AD DN.

### Variant A: OIDC groups_only + mapping

Рабочая схема для многих внешних потребителей:

- MediaWiki авторизует пользователей через MS AD/LDAP и продолжает хранить свои ACL группы;
- Corporate SSO/IdP выдает access token для audience WikiAI;
- Gateway проверяет Bearer token по JWKS этого IdP;
- raw группы из OIDC `groupsClaim` не считаются MediaWiki ACL группами напрямую;
- Gateway мапит raw OIDC/AD группы в группы MediaWiki, которые уже лежат в индексированных `allowed_groups`.

В production для этого варианта используйте `aclMode=groups_only` и `groupMappingMode=mapped_only`. Режим `mapped_only` отбрасывает raw IdP groups после маппинга: если правило не задано, такая группа не дает доступ. `passthrough_and_mapped` оставлен для совместимости и диагностики, когда raw group names уже совпадают с MediaWiki group names.

Пример `groupMappings` во вкладке `Внешний API`:

```json
{
  "CN=WikiAI-IT-Readers,OU=Groups,DC=corp,DC=example": ["ai-it"],
  "CN=WikiAI-Exec,OU=Groups,DC=corp,DC=example": ["ai-exec", "ai-it"]
}
```

Preview в UI принимает raw группы с новой строки или через `;` и показывает effective MW ACL groups до сохранения. Запятая не используется как разделитель, потому что AD DN групп обычно сами содержат запятые. Это локальная проверка формы; реальный доступ все равно считается Gateway после валидации подписи Bearer token.

ACL mode:

- `mediawiki_check` - режим по умолчанию. После retrieval Gateway спрашивает MediaWiki API, readable ли исходная страница для текущего cookie или Bearer. Это самый строгий вариант, если MediaWiki реально умеет проверять тот же Bearer/SSO для readable-check.
- `groups_only` - production-вариант для схемы Variant A, когда MediaWiki не принимает Bearer от внешнего клиента. Он доверяет `allowed_groups` из индекса, поэтому требует актуального reindex и явного `groupMappings` в режиме `mapped_only`.

MCP adapter не имеет прямого доступа к Qdrant, Redis, SQLite или MediaWiki. Он вызывает только Gateway external API:

```bash
WIKIAI_GATEWAY_URL=http://127.0.0.1:3000 \
WIKIAI_ACCESS_TOKEN=<oidc-access-token> \
node packages/mcp-adapter/src/server.mjs
```

Для локального embedded-сценария можно использовать `WIKIAI_COOKIE`, но для передачи заказчику production-путь для сторонних систем - OIDC Bearer.

### Retrieval profiles для MediaWiki, External API и MCP

`Retrieval profile` - это готовый режим поиска, который администратор собирает из уже доступных механизмов: текущий BM25/trigram backend, OpenSearch relevance layer, dense embeddings, lexical experimental features и ColBERT. Внешний клиент не передает raw-флаги вроде `trigramIndexEnabled` или `colbertFailMode`; он передает только `retrievalProfileId`.

Профиль также задает поведение ответа для MediaWiki, External API и MCP: optional override `llmModel`, `llmTemperature`, `llmMaxTokens`, `llmTimeoutMs`, `showSources` и `assistantUiMode`. Если поле не задано, Gateway использует fallback из вкладки `LLM`.

Это отличается от `indexing profile`:

- `indexing profile` отвечает за то, что индексировать и как запускать reindex;
- `retrieval profile` отвечает за то, как искать по уже построенным индексам в конкретном запросе;
- смена retrieval profile не создает embeddings, не строит ColBERT index и не запускает backfill.

`GET /api/v1/capabilities` возвращает список доступных профилей и readiness:

```json
{
  "groupMappingMode": "mapped_only",
  "groupMappingConfigured": true,
  "groupMappingCount": 2,
  "mappedGroupCount": 3,
  "retrievalProfiles": [
    {
      "id": "prod_hybrid_colbert",
      "name": "Production hybrid + ColBERT",
      "apiEnabled": true,
      "mcpEnabled": true,
      "maxTopK": 20,
      "readiness": {
        "status": "prod_ready",
        "reasons": []
      }
    }
  ],
  "defaultRetrievalProfileId": "current_hybrid_colbert"
}
```

Пример external search:

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/search \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <oidc-access-token>' \
  -d '{"query":"ошибка VPN после смены пароля","topK":5,"retrievalProfileId":"opensearch_hybrid_colbert"}'
```

Пример MCP tool call:

```json
{
  "name": "wikiai_search",
  "arguments": {
    "query": "ошибка VPN после смены пароля",
    "topK": 5,
    "retrievalProfileId": "lexical_exact"
  }
}
```

Для External API и MCP, если `retrievalProfileId` не передан, Gateway использует `defaultRetrievalProfileId` из вкладки `Внешний API`, когда он задан; пустой внешний default оставляет отдельный compatibility path для старых клиентов. Для встроенного поиска и чата профиль всегда берется из `knowledge source profile`, а `retrievalProfileId` из body игнорируется. Если выбранный retrieval profile `not_ready`, Gateway возвращает `409 retrieval_profile_not_ready`, без молчаливого fallback.

### Knowledge source profile для встроенного поиска

Вкладка `Источники знаний` управляет canonical `knowledge source profile` для встроенного поиска и чата (`/api/search`, `/api/chat`). В текущем build поддержан один connector `mediawiki`, но профиль уже хранит `sourceIds`, `retrievalProfileId`, `failurePolicy=partial_with_warning` и `mergePolicy=normalize_rerank`. Это отделяет выбор источников знаний от того, каким retrieval profile искать по индексам.

Default после чистого развертывания - source `mediawiki` + retrieval profile `opensearch_hybrid_colbert`. Это строгий production default: если OpenSearch, ColBERT или нужные индексы не готовы, пользователь получает readiness-ошибку, а не скрытый откат на global RAG config.

Admin endpoint'ы:

- `GET /api/admin/knowledge-source-profile/config` - выбранные `sourceIds`, retrieval profile, source catalog, readiness, effective config и список retrieval profiles.
- `POST /api/admin/knowledge-source-profile/config` - сохранить `sourceIds`, `retrievalProfileId`, `failurePolicy` и `mergePolicy`.
- `GET /api/admin/mediawiki-profile/config` и `POST /api/admin/mediawiki-profile/config` сохранены как compatibility alias для старых клиентов; сохранение через старый endpoint синхронизирует новый profile.

Runtime diagnostics для `/api/search`, `/api/chat` и admin debug trace включают:

- `knowledgeSourceProfileId`;
- `knowledgeSourceIds`;
- `knowledgeSourceFailurePolicy`;
- `knowledgeSourceWarnings`;
- `sourceFanout` с counts `rawChunks`, `readableChunks`, `trustedChunks`, `finalChunks`.

Результаты поиска и источники чата сохраняют legacy поля `pageId`, `title`, `namespace`, `pageUrl`, но дополнительно получают canonical поля `sourceId`, `documentId`, `displayTitle`, `sourceUrl`, `spaceKey`. Для текущего MediaWiki connector `documentId` имеет вид `mediawiki:page:<pageId>`, а `spaceKey` - `mw-namespace-<namespace>`.

Вкладка только выбирает профиль и показывает read-only детали: search mode, lexical backend, rerank, `retrievalTopK`, `contextTopK`, `contextMaxChars`, выбранный `chatProfileId`, ColBERT, editDistance, trigram, semantic/context flags, required/missing index targets. Настраивать состав поиска нужно во вкладке `Профили поиска`, а поведение истории чата - во вкладке `Управление чатами`.

Готовность профиля:

- `prod_ready` - профиль использует production-контур: выбранный lexical backend готов, ColBERT требуется и `/health` отвечает `ok`;
- `limited_ready` - профиль можно использовать для ограниченных сценариев, например lexical-only, semantic broad или vector-only проверка;
- `not_ready` - профиль требует неготовый индекс или сервис, например BM25 без chunks, OpenSearch без index, trigram без backfill или ColBERT без healthy service.

Readiness также возвращает `requiredIndexTargets` и `missingIndexTargets`. Для OpenSearch-профиля обязательный target - `opensearch`; для current-профиля - `bm25`; для ColBERT-профиля - `colbert`.

Базовые примеры профилей создаются автоматически, если профили еще не настроены, и доступны в UI через кнопку восстановления:

- `current_hybrid` - текущий стек: Qdrant dense + BM25/trigram lexical backend;
- `current_hybrid_colbert` - текущий стек + `hybrid_colbert`, ColBERT обязателен, `fail_search`;
- `opensearch_hybrid` - Qdrant dense + OpenSearch analyzer/relevance layer;
- `opensearch_hybrid_colbert` - OpenSearch stack + ColBERT rerank для production-grade retrieval;
- `prod_hybrid_colbert` - legacy example BM25 gate + dense semantic + `hybrid_colbert`, ColBERT обязателен, `fail_search`;
- `lexical_exact` - BM25/FTS-first для точных терминов, названий систем, инструкций;
- `semantic_broad` - hybrid с повышенным vector weight для широких исследовательских вопросов;
- `typo_tolerant_experimental` - BM25 + `editDistance`, trigram только после готового trigram index;
- `colbert_full_strict` - `colbert_full` для экспертного сравнения late-interaction index.

В профиле есть три разных лимита, которые не нужно смешивать:

- `retrievalTopK` - сколько финальных результатов или источников вернуть пользователю после ACL/trust/rerank.
- `contextTopK` - сколько верхних источников из этой финальной выдачи положить в LLM prompt.
- `contextMaxChars` - сколько символов prompt context можно дать модели.
- `chatProfileId` - какой профиль чата использовать для prompt history и retrieval history. Если поле пустое, используется дефолт из `Управление чатами`; старый `chatRetrievalQueryMode` сохраняется только как compatibility alias.

Если чат вернул 4 ссылки, а `contextTopK=2`, пользователь видит 4 проверенных источника, но модель получает только первые 2. Для External API/MCP явный `topK` в запросе остается request override в пределах `maxTopK`; без него используется `retrievalTopK` выбранного профиля.

По умолчанию профили поиска ссылаются на `chat_current_session`: история остается в prompt модели, но retrieval ищет источники только по текущей реплике. Для follow-up сценариев выбирайте chat profile `chat_followup_questions` или `chat_followup_full`, где важнее восстановить контекст диалога, чем исключить тематический хвост из прошлых вопросов.

Если сохранение профиля возвращает `unrecognized_keys` для `retrievalTopK`, `contextTopK`, `contextMaxChars`, `chatRetrievalQueryMode`, `maxContextChunks` или `maxContextChars`, это почти всегда означает stale Gateway build/container: текущий Gateway должен принимать эти поля как profile-level limits. Пересоберите и перезапустите Gateway, затем проверьте `GET /api/admin/knowledge-source-profile/config` и повторите сохранение профиля.

Профиль не управляет `colbertModel` и `colbertCollection`: смена модели остается отдельным процессом candidate build, массового reindex и promote active ColBERT index.

## RAG / Embeddings, BM25, ColBERT и профиль MediaWiki

До внедрения indexing profiles текущий runtime использует:

- Gateway runtime config: legacy `topK`, `chunkSize`, `chunkOverlap`;
- retrieval profile config: `retrievalTopK`, `contextTopK`, `contextMaxChars`;
- Syncer env fallback: `CHUNK_SIZE`, `CHUNK_OVERLAP`;
- Syncer reindex options: `attachmentsEnabled`, `semanticFactsEnabled`, `namespaces`, `maxPages`.

После внедрения profiles источник истины для chunking должен быть profile, переданный в reindex job.

Admin UI разделяет настройки на несколько рабочих зон:

- `RAG / Embeddings` - chunking и параметры embedding-контекста; глобальный legacy `topK` больше не редактируется как основная настройка.
- `Профили поиска` - `retrievalTopK`, `contextTopK`, `contextMaxChars`, `chatProfileId`, режим retrieval, backend, ColBERT и experimental lexical features.
- `Debug цепочки` - отдельная эксплуатационная вкладка для проверки одного вопроса end-to-end: selected retrieval profile, readiness, search diagnostics, ACL/trust, chunks/context, prompt, LLM request/response и conflict detector.
- `BM25` - веса lexical/vector, BM25 gate, candidate limits и состояние FTS5.
- `OpenSearch` - отдельный lexical backend с language analyzer, fuzzy query, highlights, title/text boosts, effective settings, index state и preview запроса.
- `ColBERT` - URL сервиса, active model/collection, health, candidate indexes и build/promote/cancel.
- `Источники знаний` - canonical knowledge source profile для встроенного поиска и чата; semantic facts, вложения, lexical backend и ColBERT управляются через `Профили поиска`.
- `Индексация` - profiles, `indexTargets`, dry-run и ручной/scheduled reindex.

### Гибридный поиск и readiness

Вкладка `RAG / Chunking` также управляет ранжированием поиска:

- `searchMode`: `hybrid` по умолчанию смешивает Qdrant vector search и выбранный lexical backend; `vector_only` оставляет старое dense-only поведение; `colbert_full` ищет первый набор кандидатов в отдельном ColBERT index; `hybrid_colbert` сначала использует текущий hybrid, затем переставляет кандидатов через ColBERT.
- `lexicalBackend`: `BM25/trigram` использует текущий встроенный lexical index независимо от выбранной основной БД; `OpenSearch` использует OpenSearch relevance layer. Переключение выполняется в retrieval profile и не строит индекс автоматически: включите target `opensearch` в indexing profile и запустите reindex/backfill.
- `vectorWeight`: вес смысловой близости Qdrant. Дефолт `0.65`.
- `lexicalWeight`: вес точного текстового совпадения BM25. Дефолт `0.35`.
- `vectorCandidateLimit`: сколько кандидатов брать из Qdrant до ACL/trust-фильтров. Дефолт `50`.
- `lexicalCandidateLimit`: сколько кандидатов брать из FTS5 до ACL/trust-фильтров. Дефолт `50`.
- `lexicalMinMatchedTerms`: сколько разных слов запроса должен содержать BM25-кандидат. Дефолт `2`. Если в запросе одно слово, требуется одно; если слов несколько, совпадение только по одному широкому слову вроде `система` отбрасывается. Для русских окончаний используется короткий нормализованный префикс: `древние`, `Древний` и `Древняя` считаются одним BM25-термом `древн`.
- `lexicalGateMode`: `when_bm25_available` по умолчанию. Если BM25 нашел хотя бы одного кандидата, выдача строится только из BM25-кандидатов; vector score используется только как дополнительный вес для тех же chunks. `off` возвращает старое поведение, где semantic-only кандидаты тоже могут попасть в итоговый список.
- `lexicalNormalizationMode`: `simple_stem` по умолчанию включает базовую эвристику русских окончаний; `raw_prefix` оставляет только нижний регистр и короткий prefix без снятия окончаний.
- `lexicalSynonymsEnabled` и `lexicalSynonyms`: experimental query-time словарь. Формат в UI: `тикет=заявка,инцидент`. Индекс не меняется.
- `lexicalTransliterationEnabled`: experimental query-time расширение латиница/кириллица, например `server`/`сервер`, `router`/`роутер`. Индекс не меняется.
- `lexicalEditDistanceEnabled`: experimental tolerance для коротких опечаток. Gateway добавляет укороченный prefix для длинных слов и затем проверяет близость термов с расстоянием до 1. Индекс не меняется.
- `trigramIndexEnabled`: experimental fallback по отдельному trigram index. Он используется только когда BM25 не дал пригодных chunks. Включить его можно только после готового trigram index: Gateway отклоняет сохранение настройки, если покрытие меньше 100%.
- `OpenSearch analyzer`: используется для шумных запросов вроде `как там цивилизации`. Gateway не добавляет ручной stopword hack; разбор языка выполняет analyzer/query DSL OpenSearch.
- `trigramCandidateLimit`: сколько кандидатов брать из trigram index. Дефолт `50`.
- `trigramMinQueryLength`: минимальная длина запроса для trigram fallback. Дефолт `4`.
- `vectorOnlyFallbackEnabled`: включает fallback на чистый vector search, когда BM25 не нашел ни одного кандидата. Дефолт `true`.
- `vectorOnlyFallbackMinScore`: отдельный высокий порог для такого fallback. Дефолт `0.78`, чтобы случайные semantic-only соседи не попадали в выдачу слишком легко.
- `minSearchScore`: старый порог только для vector-кандидатов.

OpenSearch URL в админке относится к Gateway runtime, а не к браузеру администратора. Для `docker-compose` используйте `http://opensearch:9200`: это имя сервиса внутри Docker network. Адрес `http://127.0.0.1:9200` подходит только для ручной проверки с машины, но из контейнера Gateway он укажет на сам контейнер Gateway, а не на OpenSearch. Поле `OpenSearch URL` в админке должно быть заполнено этим compose default даже до включения OpenSearch; флаг `Enable OpenSearch` включает backend отдельно. Если OpenSearch не развернут, оставьте `Enable OpenSearch=false`, используйте BM25/trigram profiles и не выбирайте `opensearch_hybrid*` retrieval profiles до готового URL, индекса и reindex target `opensearch`.

### OpenSearch простыми словами

В админке есть три разных решения, и они не заменяют друг друга:

- `Enable OpenSearch` во вкладке `OpenSearch` разрешает Gateway обращаться к сервису OpenSearch.
- `lexicalBackend=opensearch` в выбранном retrieval profile выбирает OpenSearch как lexical backend для hybrid search.
- `indexTargets=opensearch` во вкладке `Индексация` говорит reindex job наполнять индекс OpenSearch.

Вкладка `OpenSearch` показывает effective settings в read-only таблице. Источник `admin override` означает сохраненное значение из админки; `env/default` означает `OPENSEARCH_*` из deployment или дефолт Gateway. Например `Анализатор OpenSearch = russian` обычно приходит из `OPENSEARCH_ANALYZER` default. Gateway использует analyzer при создании mapping полей `title`/`text` и в query/analyze. Если analyzer меняется после созданного индекса, для полного эффекта нужен rebuild/recreate index.

Кнопка `Перестроить индекс OpenSearch` запускает обычный reindex через первый indexing profile, где включен target `OpenSearch`. Если такого профиля нет, сначала включите target `OpenSearch` во вкладке `Индексация`. Переключение `lexicalBackend` само по себе reindex не запускает.

Вкладка `OpenSearch` также показывает состояние вложений в индексе: общий
`attachmentDocumentCount`, список `attachmentFilename` и кнопку проверки
конкретного файла. Для файла вроде `Wikiai-architecture.pptx` диагностика
сравнивает два слоя: BM25/PostgreSQL chunks и OpenSearch documents. Если
BM25/PostgreSQL показывает chunks, а OpenSearch показывает `0`, документ уже
распознан, но не был записан в OpenSearch; исправлять нужно reindex/profile
targets, а не поисковый запрос.

## Автотесты И Dev-Stand Gate

Быстрый regression gate запускает package-local coverage, contract validation и fixture tests без обращения к живым сервисам:

```bash
node scripts/test-wikiai-env-dev.mjs
```

Live dev gate включается отдельно, чтобы не смешивать unit coverage с проверкой стенда:

```bash
RUN_WIKIAI_ENV_DEV=1 node scripts/test-wikiai-env-dev.mjs
```

По умолчанию live gate проверяет только безопасные сценарии: Gateway `/live`/`/ready`/`/health`/`/metrics`, Syncer `/live`/`/ready`/`/health`/`/metrics`, anonymous MediaWiki API, ResourceLoader bundles `ext.aiadmin`/`ext.aiassistant`, регистрацию OpenSearch и knowledge source profile admin routes без cookie и временную Qdrant collection с cleanup. Для admin routes без cookie ожидается `401`, а не `404`: ошибка `Route POST:/api/admin/opensearch/analyze not found` или `Route GET:/api/admin/knowledge-source-profile/config not found` означает stale Gateway build/container. Если задан `MW_TEST_COOKIE` или `WIKIAI_ADMIN_COOKIE`, дополнительно проверяется authenticated `Special:AIAdmin`, наличие вкладок `OpenSearch`/`BM25`/`ColBERT`/`Источники знаний` и admin endpoints Gateway.

В `ai-admin` line coverage считается для helper-кода, а wiring большого `adminApp.js` проверяется contract tests и live ResourceLoader marker checks. Это сделано намеренно: без полноценного browser harness простой include `adminApp.js` дает шумное почти нулевое line coverage и не отражает видимость вкладок в реальном MediaWiki.

Optional проверки включаются только явно:

```bash
RUN_WIKIAI_ENV_DEV=1 RUN_OPENSEARCH_E2E=1 node scripts/test-wikiai-env-dev.mjs
RUN_WIKIAI_ENV_DEV=1 RUN_COLBERT_E2E=1 node scripts/test-wikiai-env-dev.mjs
```

`RUN_LLM_SMOKE=1` не запускает платные/remote LLM вызовы внутри общего env-dev gate. Такие smoke tests выполняются отдельной ручной процедурой после подтверждения стоимости.
- `minFinalScore`: порог уже после смешивания vector/BM25.
- `showRawScores`: показывать технический score в пользовательском AI Search. По умолчанию `false`, потому что score - это величина ранжирования, а не доверие к ответу.
- `rerankMode`: `none` по умолчанию. `colbert_v2` оставлен для совместимости и включает ColBERT rerank после текущего hybrid-поиска.
- `colbertBaseUrl`: адрес on-prem ColBERT service. В compose это `http://colbert:8080`, с хоста `http://127.0.0.1:8083`.
- `colbertModel`: имя модели. Дефолт `antoinelouis/colbert-xm`.
- `colbertCollection`: отдельная Qdrant collection для ColBERT multivectors. Дефолт `wiki_colbert_chunks`.
- `colbertCandidateLimit`: сколько ColBERT-кандидатов брать до ACL/trust или сколько разрешенных chunks отправлять на rerank. Дефолт `50`.
- `colbertTimeoutMs`: timeout HTTP-запроса к ColBERT. Дефолт `5000`.
- `colbertMinScore`: минимальный score ColBERT для сохранения результата. Глобальный дефолт `0`; production-профиль `opensearch_hybrid_colbert` использует `0.58`, чтобы отсекать слабый ColBERT-хвост.
- `colbertFailMode`: `fallback_current` по умолчанию возвращает текущую hybrid-выдачу, если ColBERT недоступен; `fail_search` останавливает поиск ошибкой.

`GET /api/admin/search-index/status` теперь возвращает `readiness`:

- `prod_ready` - BM25 заполнен, dense/search index заполнен, ColBERT включен и `/health` отвечает `ok`.
- `limited_ready` - BM25/search index заполнен, но ColBERT выключен или не готов. Такой контур допустим только для ограниченных сценариев.
- `not_ready` - search index/BM25 не заполнен или контур не проходит диагностику.

Для production WikiAI ColBERT считается обязательным. Без него допускаются только ограниченные сценарии: точный справочный поиск, небольшой пилотный корпус или проверка UX/администрирования.

Пример: запрос `Администрирование систем` может быть близок по vector score к нерелевантной общей статье, если embeddings считают тексты общими. BM25 добавляет простой текстовый сигнал: документы, где реально встречаются слова запроса, получают дополнительный вес и поднимаются выше.

С включенным `lexicalMinMatchedTerms=2` и `lexicalGateMode=when_bm25_available` такая нерелевантная статья не просто опускается ниже, а исключается из кандидатов, если она совпала только по одному общему слову. При этом запрос `древние цивилизации` найдет `Древний Египет` и `Древняя Греция`, потому что BM25 сравнивает нормализованные префиксы слов, а не только полные окончания. Если FTS нашел raw BM25-кандидатов, но все они отфильтрованы как слишком широкие, `vectorOnlyFallback` не включается: лучше показать пустую или узкую выдачу, чем подмешать нерелевантные semantic-only страницы. Это не замена правам доступа: после ранжирования Gateway все равно проверяет чтение исходной страницы через MediaWiki ACL.

### BM25 для очень простого объяснения

Если совсем просто: BM25 - это не AI. Это как искать карточки в коробке по словам.

1. Gateway берет запрос пользователя и режет его на слова из букв/цифр длиной от 2 символов.
2. Все слова приводятся к нижнему регистру.
3. В базовом режиме `simple_stem` у русских слов снимаются частые окончания: `ами`, `ями`, `ого`, `ему`, `ыми`, `ими`, `ий`, `ый`, `ой`, `ая`, `ое`, `ее`, `ые`, `ие`, `ую`, `юю`, `ым`, `им`, `ом`, `ем`, `ах`, `ях`, `а`, `я`, `ы`, `и`, `у`, `ю`, `е`, `о`.
4. Если после снятия окончания осталось меньше 4 символов, слово откатывается к исходному варианту, чтобы не получить слишком короткий шум.
5. После этого берутся первые 5 символов. Поэтому `кухня`, `кухню`, `кухней` становятся `кухн*`; `администрирование` становится `админ*`.
6. SQLite FTS5 ищет chunks по `term*`, то есть по prefix. Несколько слов соединяются через `OR`.
7. Потом Gateway сам проверяет, сколько разных термов реально совпало в найденном chunk. Если меньше `lexicalMinMatchedTerms`, chunk выкидывается.

Experimental features добавляют термы к шагу 6:

- `synonyms`: если администратор написал `тикет=заявка,инцидент`, запрос `тикет` ищет еще `заявк*` и `инцид*`.
- `transliteration`: запрос `сервер` ищет еще `serve*`, а `router` ищет еще `роут*`.
- `editDistance`: для длинного терма добавляется более короткий prefix, а потом Gateway проверяет, что отличие не больше одной правки.
- `trigram`: если BM25 не дал пригодных chunks, запрос разбивается на кусочки по 3 символа и ищется по отдельному trigram index.

Soundex и rsoundex в этой реализации не используются: для русско-английской корпоративной вики они дают слишком много фонетического шума и плохо объясняются администратору. Базовый режим остается эвристикой окончаний; experimental-переключатели включаются администратором по одному и проверяются на реальных запросах.

### ColBERT index

ColBERT не заменяет Postgres, обычный Qdrant dense index, BM25 или MediaWiki ACL. Это отдельный late-interaction index: каждый chunk хранится как набор token-level vectors в отдельной Qdrant collection, а запрос сравнивается с ними через MaxSim.

Практический смысл: dense vector может считать нерелевантную статью "похожей по смыслу", а BM25 может быть слишком буквальным. ColBERT сравнивает запрос и документ детальнее на уровне token vectors. В режиме `colbert_full` первый набор кандидатов приходит из ColBERT index. В режиме `hybrid_colbert` текущий hybrid search сначала находит кандидатов, затем после ACL/trust Gateway отправляет разрешенные chunks в `/rerank`.

Модель по умолчанию для on-prem пилота: `antoinelouis/colbert-xm`. Она не вызывает OpenAI. Перед production rollout всё равно нужно проверить лицензию модели и внутреннюю политику использования весов.

HTTP-контракт сервиса:

```json
GET /health

POST /index/page
{
  "model": "antoinelouis/colbert-xm",
  "collection": "wiki_colbert_chunks",
  "pageId": 1,
  "title": "CorpIT:Инструкция администратора",
  "namespace": 3030,
  "allowedGroups": ["ai-it"],
  "replacePage": true,
  "chunks": [
    { "id": 10000, "text": "...", "chunkIndex": 0, "totalChunks": 1 }
  ]
}

POST /search
{
  "query": "администрирование информационных систем",
  "model": "antoinelouis/colbert-xm",
  "collection": "wiki_colbert_chunks",
  "topK": 50
}

POST /rerank
{
  "query": "администрирование информационных систем",
  "model": "antoinelouis/colbert-xm",
  "topK": 50,
  "candidates": [
    { "id": 1, "title": "CorpIT:Инструкция администратора", "text": "..." }
  ]
}

POST /index/delete-page
{
  "collection": "wiki_colbert_chunks",
  "pageId": 1
}
```

Ответ:

```json
{
  "results": [
    { "id": 1, "score": 0.91 }
  ]
}
```

Кнопка `Тест` в блоке ColBERT проверяет `/health` по текущему `colbertBaseUrl`; сохранение настроек для теста не требуется. Кнопка `Переиндексировать ColBERT` запускает ColBERT-only rebuild из Qdrant payload через `POST /api/admin/reindex` с `indexTargets:["colbert"]` и `source:"qdrant_payload"`. Этот путь не вызывает MediaWiki, dense embeddings, LLM enrichment или OpenAI.

Для смены модели используется версионированный `ColbertIndexSpec`:

- `GET /api/admin/rag/colbert/indexes` - список active/candidate/failed indexes.
- `POST /api/admin/rag/colbert/indexes` - создать candidate build и запустить Syncer reindex с `targets:["colbert"]`.
- `GET /api/admin/rag/colbert/indexes/:id/status` - синхронизировать статус candidate с текущим Syncer job.
- `POST /api/admin/rag/colbert/indexes/:id/promote` - сделать complete candidate active.
- `POST /api/admin/rag/colbert/indexes/:id/cancel` - отменить candidate.

Promote разрешен только для `status=complete`. Active collection не перезаписывается при build: старая collection остается рабочей для rollback.

### Где здесь AI

В AI Search LLM не читает запрос и не выбирает документы. AI используется в embedding-модели:

- при индексации Syncer отправляет текст chunk в embedding-модель и получает числовой vector;
- при поиске Gateway отправляет пользовательский запрос в ту же embedding-модель и получает vector запроса;
- Qdrant сравнивает vector запроса с vectors chunks и возвращает ближайшие;
- BM25/FTS5 не использует AI, а ищет совпадения по словам.

Если совсем просто: embedding-модель переводит смысл текста в набор чисел. Qdrant не является AI-моделью; он только считает, какие наборы чисел ближе друг к другу.

FTS5-индекс хранится в том же SQLite admin storage, что и настройки. Syncer обновляет его через `POST /api/internal/search-index/page` при webhook/reindex и очищает через `POST /api/internal/search-index/delete-page` при delete webhook. Trigram index хранится там же в отдельной таблице `ai_search_chunks_trigram` и FTS5-таблице `ai_search_chunks_trigram_fts`. Для старых Qdrant chunks нужен один full reindex, иначе BM25/trigram будут заполнены только для страниц, измененных после внедрения.

Статус BM25-индекса в админке показывает количество страниц, chunks и FTS chunks. Статус trigram показывает chunks, trigram FTS chunks и признак backfill. Если `backfill нужен: да`, гибридный поиск сможет fallback-иться в vector-only чаще, чем ожидается, а trigram fallback не будет покрывать старые chunks. Переключатель `trigramIndexEnabled` в UI остается заблокированным, пока `trigramPopulated=false`.

Если нужно заполнить BM25, OpenSearch или ColBERT без повторного построения embeddings, используйте reindex из уже существующего Qdrant payload:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/reindex \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin-mediawiki-cookie>' \
  -d '{"indexTargets":["bm25","opensearch","colbert"],"source":"qdrant_payload","dryRun":true,"maxPages":5}'
```

Этот режим читает уже сохраненные chunks из Qdrant и не ходит в MediaWiki.
Поэтому для cleanup/backfill BM25, OpenSearch или ColBERT из `source=qdrant_payload`
MediaWiki service auth не обязателен. Для полного reindex из MediaWiki это не
так: если профиль включает namespace, где `allowed_groups` отличается от ровно
`["*"]`, Syncer блокирует protected reindex до настройки `MW_SERVICE_USERNAME` с
`MW_SERVICE_PASSWORD` или `MW_SERVICE_PASSWORD_SECRET`.

Legacy-скрипт BM25 backfill также остается доступен:

```bash
QDRANT_URL=http://127.0.0.1:6333 \
GATEWAY_BASE_URL=http://127.0.0.1:3000 \
node scripts/backfill-search-index-from-qdrant.mjs
```

Trigram backfill не строит embeddings и не вызывает LLM. Он запускается как async job и пересобирает 3-граммы из уже сохраненных `ai_search_chunks`:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/search-index/trigram/backfill \
  -H 'Cookie: <admin-mediawiki-cookie>'
```

API сразу возвращает `202 Accepted` и статус job. Ход выполнения читается отдельно:

```bash
curl -s http://127.0.0.1:3000/api/admin/search-index/trigram/backfill/status \
  -H 'Cookie: <admin-mediawiki-cookie>'
```

Если backfill мешает staging или обслуживанию, его можно остановить:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/search-index/trigram/backfill/cancel \
  -H 'Cookie: <admin-mediawiki-cookie>'
```

Готовность считается строгой: `chunks > 0`, `trigramChunks >= chunks` и `trigramFtsChunks >= chunks`. До этого `POST /api/admin/rag/config` с `trigramIndexEnabled=true` возвращает ошибку `trigram_index_not_ready`.

Стоимость trigram - это дополнительное SQLite-хранилище и FTS-запросы. Примерно: для каждого слова длиной `N` создается `N-2` коротких термов, поэтому объем lexical storage может заметно вырасти на больших корпусах. Это не добавляет embedding calls, OpenAI calls или ColBERT reindex, но требует disk I/O и backfill после включения на уже проиндексированном корпусе.

Для staging-проверки используйте benchmark. Он может сам запустить backfill, дождаться завершения, сравнить размер SQLite до/после и прогнать контрольные запросы:

```bash
DATABASE_URL=sqlite://./state/admin.db \
WIKIAI_ADMIN_COOKIE='<admin-mediawiki-cookie>' \
node scripts/benchmark-trigram-readiness.mjs \
  --base-url http://127.0.0.1:3000 \
  --queries ./trigram-queries.txt \
  --start-backfill \
  --poll-ms 1000 \
  --p95-threshold-ms 200
```

Скрипт печатает JSON с `readiness.passed`, `readiness.reasons`, покрытием индекса, статусом job, размером БД и p50/p95/p99 latency. Нормальный критерий для включения в production: `readiness.passed=true`, backfill `completed`, покрытие 100%, `failed=0`, p95 trigram stage не выше 200 мс на representative queries.

Метрики Gateway в `/metrics`:

- `wikiai_search_trigram_queries_total{result}` - сколько trigram-поисков завершилось `hit`, `filtered`, `miss`, `skipped` или `error`.
- `wikiai_search_trigram_last_latency_ms` - latency последнего trigram stage.
- `wikiai_search_trigram_raw_candidates_total` - суммарные raw candidates из trigram.
- `wikiai_trigram_backfill_jobs_total{status}` - счетчик backfill jobs по статусам.
- `wikiai_trigram_backfill_progress_chunks` - последний processed chunk count.

Оба пути не вызывают LLM/OpenAI и не строят embeddings: BM25/ColBERT backfill читает payload chunks из Qdrant, а trigram backfill читает уже сохраненные `ai_search_chunks`.

## cmdbdynamicpages

Если на MediaWiki-странице используется dynamic block `cmdbdynamicpages`, Syncer
детектирует только явные markers (`{{#cmdb:...}}`, `{{CmdbPage...}}` или
HTML `data-wikiai-dynamic-source="cmdbdynamicpages"`). Произвольные ссылки на
runtime URL не считаются индексируемым блоком.

В общий индекс попадает только anonymous `staticSnapshot`. `dynamicUser`
результаты, `permissionOnly`, `visibilityHash`, `privateUser` и `disabled`
cache modes используются только как runtime/live context текущего пользователя
и не пишутся в Qdrant/BM25/ColBERT как общие rows. Контракт развертывания:
`docs/contracts/cmdbdynamicpages-wikiai.md`.

## Распознавание Документов

Default policy:

- `docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp` - извлекается текст и metadata.
- `mp3`, `wav`, `mpeg`, `zip`, `7zip` - metadata-only; архивы не распаковываются, speech-to-text не выполняется.
- fenced blocks ` ```mermaid ... ``` ` индексируются как обычный текстовый chunk с `contentType=mermaid`, без рендеринга диаграммы.

Для metadata-only вложений Syncer создает searchable chunk с именем файла, MIME, размером и `processing mode`. Ошибки обработки вложений не останавливают reindex страницы: они попадают в `attachmentsFailed` и metadata `error`.

Наличие файла в MediaWiki еще не означает, что он попал в поиск или чат. Вложение становится доступно retrieval только после reindex с `attachmentsEnabled=true`, активным target `attachments`, включенной document policy и готовой схемой Gateway search-index. В статусе индекса проверяйте `attachmentColumnsReady`, `attachmentChunks`, `attachmentPages` и список `attachmentFilenames`: если MediaWiki показывает файлы, но `attachmentChunks=0`, проблема находится в цепочке reindex/write, а не в выдаче поиска.

Для OpenSearch-профилей проверяйте оба контура:

1. `Распознавание документов`: глобально включены вложения, MIME `pptx/docx/xlsx/odt/ods/odp` не `disabled`.
2. `Индексация -> Профили индексации`: `attachmentsEnabled=true`, target `attachments`, а также search target `opensearch` для записи в OpenSearch.
3. `Индексация -> manual reindex`: галка `Обрабатывать вложения в этом запуске` включена; preflight показывает `expected active yes`.
4. Статус reindex: `requested yes`, `active yes`, `policy yes`, `processed > 0`, а `Attachment target writes` содержит `opensearch`.
5. `OpenSearch`: `attachmentDocumentCount > 0`, а проверка filename находит нужный файл.
6. `Профили поиска` и `Источники знаний`: выбранный knowledge source profile ссылается на retrieval profile с `includeAttachments=true`; для OpenSearch readiness не должен сообщать `opensearch_attachments`.

Распознавание документов управляется MIME policy:

- `text` - извлекать текст;
- `ocr` - распознавать изображение;
- `metadata` - индексировать только метаданные;
- `disabled` - не индексировать.

Изменение policy должно фиксироваться в audit log.

## Live LLM

OpenAI/LiteLLM smoke tests считаются платными. Запускайте их только при явном opt-in и с минимальным prompt.

## LLM и Embeddings

Инфраструктурные LLM-настройки управляются через вкладку `LLM` и endpoints:

- `GET /api/admin/llm/config`;
- `POST /api/admin/llm/config`;
- `POST /api/admin/llm/test`.

`/api/admin/llm/test` делает реальный OpenAI-compatible chat request через LiteLLM и может быть платным.

Для переключения chat/RAG-ответов на OpenAI не вводите OpenAI key в WikiAI. Настройте OpenAI key и route в LiteLLM, затем в WikiAI укажите default модель-алиас LiteLLM, например `corp-openai-gpt-4.1-mini`. На продуктиве `LITELLM_MODEL` должен быть alias в LiteLLM, а не прямое имя провайдера. Для разных сценариев задавайте модель, `Показывать источники` и `Интерфейс ассистента` в `Профили поиска`; вкладка `LLM` остается fallback для профилей без override.

В блоке `Назначение моделей` показывается, какая модель сейчас используется для каждой функции:

- `Chat answer` - LLM, которая пишет ответ пользователю после RAG-поиска.
- `Conflict detection` - LLM, которая сравнивает найденные источники и ищет противоречия.
- `Embeddings` - модель, которая строит вектор запроса, страниц, вложений и ontology vectors.
- `Reindex LLM enrichment` - LLM, которая может добавлять краткое summary/keywords к странице во время full reindex.

Embeddings управляются через вкладку `Embeddings` и endpoints:

- `GET /api/admin/embedding/config`;
- `POST /api/admin/embedding/config`;
- `POST /api/admin/embedding/test`.

`provider=ollama` вызывает локальный Ollama-compatible endpoint `/api/embeddings` с полями `model` и `prompt`. Это дешевый режим по умолчанию.

`provider=openai_compatible` вызывает OpenAI-compatible endpoint `/embeddings` с полями `model`, `input` и `dimensions`; обычно это LiteLLM `/v1`. Ключ не вводится в UI и берется из runtime-конфигурации Gateway. Этот режим может быть платным, если LiteLLM маршрутизирует запросы во внешний OpenAI API. `dimensions` должен совпадать с размерностью коллекции Qdrant, на текущем стенде ожидается `768`.

## Webhook

Webhook-настройки управляются во вкладке `Webhook` и через API:

- `GET /api/admin/webhook/config`;
- `POST /api/admin/webhook/config`;
- `POST /api/admin/webhook/test`.

Gateway config задает ожидаемый Syncer URL, события `edit/delete/move/protect`, timeout и retry policy. MediaWiki extension дополнительно показывает текущий `$wgAIAssistantSyncerUrl` из `LocalSettings.php`. Если этот URL не совпадает с ожидаемым Syncer URL в Gateway, UI показывает warning; в таком состоянии сохранение Gateway config не меняет `LocalSettings.php`.

Safe webhook test проверяет Syncer `/health` и не создает, не изменяет и не удаляет страницы.

## Indexing Profiles

Профили индексации управляются во вкладке `Индексация` и через API:

- `GET /api/admin/indexing-profiles`;
- `POST /api/admin/indexing-profiles`;
- `POST /api/admin/reindex`.

Профиль задает namespaces, фильтры страниц, document policy binding, run mode, chunk size/overlap/separators, `attachmentsEnabled`, `semanticFactsEnabled`, `dryRunDefault` и `maxPagesDefault`. Список SMW properties для payload не редактируется CSV в профиле: он берется из вкладки `Онтологические векторы`, где у свойства включен флаг `indexed`.

При запуске reindex с `profileId` Gateway разворачивает профиль в параметры Syncer. Syncer также умеет загрузить profile defaults напрямую из общего SQLite admin storage `ai_admin_config`, если получил только `profileId` или неполный набор параметров. Параметры, явно переданные в reindex request, имеют приоритет над SQL defaults.

Syncer применяет chunking, `dryRun` и фильтры страниц. Фильтры применяются до `maxPages`: сначала namespace, затем название страницы, затем категории. `maxPages` - это только явный лимит для пробного запуска; пустое значение означает индексацию всех страниц, подходящих под профиль.

Статус reindex показывает разные счетчики: `найдено страниц` - сколько страниц подошло под профиль до лимита, `в обработке` - сколько реально поставлено в job после лимита, `обработано страниц` - сколько страниц записано в индекс, `пропущено` - пустые или недоступные страницы, `фрагментов RAG` - сколько chunks получилось после разбиения текста. Блок `Вложения` показывает `requested/active/policy`, сколько файлов найдено на страницах, сколько обработано, пропущено и сколько упало с ошибкой. Если `requested=true`, но `active=false`, смотрите `dryRun`, target `attachments`, document policy и readiness схемы. Дополнительные счетчики стоимости: `embedding calls` - сколько embedding-вызовов сделано при записи, `LLM enrichment` - сколько страниц было обогащено через LLM, `estimated paid calls` - оценка потенциально платных вызовов, если embeddings или enrichment идут через OpenAI-compatible endpoint.

### Protected MediaWiki Reindex And Service Auth

Это production/runtime настройка, не только dev. Полный reindex из MediaWiki
читает страницы от имени Syncer. Для публичных namespace с `allowed_groups=["*"]`
сервисный пользователь не нужен, но для закрытых namespace Syncer должен уметь
войти в MediaWiki как отдельный пользователь, которому разрешено читать эти
страницы.

Настройте один из вариантов:

- `MW_SERVICE_USERNAME` + `MW_SERVICE_PASSWORD` из защищенного env/config;
- `MW_SERVICE_USERNAME` + `MW_SERVICE_PASSWORD_SECRET` при `SECRETS_PROVIDER=IndeedPamAapm`;
- `MW_SERVICE_PASSWORD=secret://...` как явную ссылку на секрет.

После настройки проверьте авторизацию через админку: `POST /api/admin/service-config/test`.
Для внутренней диагностики Syncer доступен `POST /admin/mediawiki-service-auth/test`
с `x-wikiai-admin-token`. Если тест показывает `source=none`, protected reindex
не стартует и вернет ошибку до обхода страниц. `MW_SYNC_COOKIE` остается только
deprecated fallback для старых стендов и не должен быть основным механизмом у
заказчика.

`Включить LLM-обогащение reindex` по умолчанию выключено. Если включить его в ручном запуске и `dryRun=false`, Syncer один раз на страницу вызывает Gateway internal endpoint `/api/internal/reindex/llm-enrich`, Gateway делает короткий chat/completions запрос через LiteLLM, а результат кладется в payload chunk как `ai_summary`, `ai_keywords` и `ai_enrichment_model`. Это может улучшить поиск по документам с плохой структурой, но добавляет платный LLM-вызов на каждую обработанную страницу. Для приемки сначала используйте `dryRun=true` и маленький `maxPages`: dry-run покажет оценку, но не будет вызывать LLM и не будет писать Qdrant.

Фильтры по названию работают как case-insensitive contains. Например, `CorpIT:,Регламент` оставит страницы, где в заголовке есть `CorpIT:` или `Регламент`. Исключение по названию сильнее включения, поэтому `Черновик` уберет страницу даже при совпадении с include.

Категория - это сущность MediaWiki: страница попадает в категорию, если в wikitext есть `[[Категория:ИТ]]` или `[[Category:IT]]`. Во вкладке `Индексация` категории выбираются из видимого списка `Доступные категории MediaWiki`; поле над списком служит для поиска по справочнику через `GET /api/admin/wiki/categories`. Category filters сравниваются точным совпадением по нормализованному имени категории: `ИТ` совпадает с `Категория:ИТ`, но не совпадает с `Категория:Аудит`. Исключение категории сильнее включения.

Эти фильтры определяют область индексации, а не права доступа. Для безопасности RAG используется проверка чтения исходной страницы через MediaWiki.

`documentPolicyId` сейчас связывает profile с MIME policy `default`; отдельные именованные MIME policy остаются следующим этапом.

Для `runMode=scheduled` Gateway scheduler раз в минуту проверяет due profiles и запускает Syncer reindex с интервалом `scheduleIntervalMinutes`. Scheduler применяет профиль на стороне Gateway и передает Syncer тот же набор параметров, что ручной запуск, включая текущий список indexed SMW-свойств из онтологии. Вкладка `Индексация` показывает next run, last run, running flag и последнюю ошибку scheduled profiles.

## Управление Чатами

Вкладка `Управление чатами` состоит из трех частей:

- `Профиль чата по умолчанию` - какой chat profile используется, если retrieval profile не задал свой `chatProfileId`.
- `Профили prompt/retrieval для чата` - сколько истории попадает в prompt модели и нужно ли добавлять историю в retrieval query.
- `Хранение и экспорт` - TTL, архивация, лимиты и экспорт пользовательских чатов.

API управления профилями:

- `GET /api/admin/chat-management/config`;
- `POST /api/admin/chat-management/config`;
- `GET /api/admin/chat-profiles`;
- `POST /api/admin/chat-profiles`;
- `POST /api/admin/chat-profiles/restore-defaults`.

Базовые chat profiles:

- `chat_current_session` - prompt видит текущую сессию, retrieval ищет только по текущему вопросу. Это дефолт для точности источников.
- `chat_followup_questions` - prompt видит текущую сессию, retrieval добавляет последние вопросы пользователя. Хорошо для запросов вроде "а еще про кухни?", когда важна тема прошлого вопроса, но ответы ассистента не должны влиять на поиск.
- `chat_followup_full` - prompt видит текущую сессию, retrieval добавляет вопросы и ответы. Полезно, если в ответах ассистента появляются важные термины, но повышает риск увести retrieval в старую тему.
- `chat_active_sessions_prompt_experimental` - experimental: prompt может видеть активные сессии того же пользователя; retrieval остается по текущему вопросу. По умолчанию выключен.

Поля профиля:

- `promptHistoryScope` - откуда брать историю для prompt: только текущая сессия или active sessions того же пользователя.
- `promptHistoryTurns` и `maxPromptHistoryChars` - сколько истории можно дать модели.
- `retrievalHistoryMode` - что добавлять в поисковый запрос: ничего, только прошлые вопросы пользователя, или прошлые вопросы и ответы.
- `retrievalHistoryTurns` и `maxRetrievalHistoryChars` - сколько истории можно добавить в retrieval query.

Профили поиска выбирают chat profile через `chatProfileId`. Поэтому настройка `retrievalTopK/contextTopK/contextMaxChars` остается в `Профили поиска`, а логика "использовать ли прошлые вопросы" теперь живет в `Управление чатами`.

Политика хранения чатов управляется во вкладке `Управление чатами` и через API:

- `GET /api/admin/chat-retention/config`;
- `POST /api/admin/chat-retention/config`;
- `GET /api/admin/chat-sessions`;
- `GET /api/admin/chat-sessions/:id/messages`;
- `POST /api/admin/chat-sessions/:id/archive`;
- `POST /api/admin/chat-sessions/:id/export`.

Пользовательский архив выгружается через `POST /api/chat/archive/export`; endpoint возвращает только archived sessions текущего MediaWiki user.

Настройки включают `retentionMode`, `activeDays`, `recentDays`, `archiveDays`, лимиты количества чатов, действие `onLimitExceeded` и export options. По умолчанию используется `retentionMode=archive` и `activeDays=7`: активные чаты старше 7 дней переносятся в архив. Gateway применяет политику к Redis TTL истории чатов: для `auto_delete` используется `activeDays`, для `archive` и `export_then_archive` - `archiveDays`.

Дополнительно Gateway ведет SQL registry `chat sessions/messages/archive/export`. При новом сообщении создается или обновляется session, сообщения пишутся в SQL, а Redis остается быстрым runtime cache. Лимиты `maxActiveChats`, `maxTotalChats` и политика `onLimitExceeded` применяются перед созданием новой активной сессии: `block_new` отклоняет чат, `archive_oldest` архивирует старую активную сессию, `delete_oldest` очищает старую сессию.

Вкладка `Управление чатами` показывает счетчики registry, последние sessions и read-only просмотр сообщений выбранной session. Ручные кнопки `Archive`/`Export JSON` на каждой session в админском UI не выводятся.

В пользовательском `Special:AIAssistant` вкладка `Чат` показывает историю собственных активных и архивных чатов. Название session берется из первого вопроса пользователя и обрезается до короткой строки. Активную session можно продолжить, архивная session открывается read-only. В режиме `Архив` доступна кнопка выгрузки всего архива текущего пользователя; export использует текущие `exportOptions` и не вызывает LLM/OpenAI.

Для active session prompt всегда может использовать недавний контекст текущей беседы. Retrieval query использует историю только если выбранный chat profile это разрешает. Архивные sessions в новых retrieval-запросах не участвуют.

## Модель Доверия

Модель доверия управляется во вкладке `Модель доверия` и через API:

- `GET /api/admin/trust-models`;
- `POST /api/admin/trust-models`;
- `GET /api/admin/trust-models/:id/rules`;
- `POST /api/admin/trust-models/:id/rules`;
- `DELETE /api/admin/trust-models/:id/rules/:ruleId`;
- `GET /api/admin/trust-models/:id/entities`;
- `POST /api/admin/trust-models/:id/entities`;
- `DELETE /api/admin/trust-models/:id/entities/:entityId`;
- `GET /api/admin/trust-models/:id/entities/:entityId/rules`;
- `POST /api/admin/trust-models/:id/entities/:entityId/rules`;
- `DELETE /api/admin/trust-models/:id/entities/:entityId/rules/:ruleId`;
- `POST /api/admin/trust-models/:id/preview`;
- `GET /api/admin/wiki/namespaces`;
- `GET /api/admin/wiki/categories`;
- `GET /api/admin/wiki/tags`;
- `GET /api/admin/wiki/user-groups`;
- `GET /api/admin/wiki/templates`;
- `GET /api/admin/wiki/pages`;
- `GET /api/admin/conflict-detection/config`;
- `POST /api/admin/conflict-detection/config`;
- `POST /api/admin/conflict-detection/test`.

MVP хранит модели доверия, правила и старые признаки доверия в admin SQL storage и считает preview по тестовым метаданным страницы. Preview возвращает `score`, `lastModified`, `ageYears`, `stalenessPenalty`, flags, applied entities/rules и решения `includeInContext`, `allowDirectAnswer`, `excludeFromIndex`, `requireManualApproval`, `notifyAuthor`, `requireSources`.

В интерфейсе используется одна активная модель доверия. Таблица моделей показывает, какая модель активна; формы правил, preview и пересчета работают с этой моделью без отдельных выпадающих списков. Это снижает риск, что администратор сохранит правило в одной модели, а preview запустит в другой.

Правило доверия - это одна строка: что проверяем в wiki-странице, как меняем score, какие флаги добавляем и какие решения включаем. Например, правило `approved-docs` может проверять `Статус документа=Утвержден`, добавлять `+0.2` к score и ставить флаг `official`.

Вкладка `Модель доверия` показывает одну таблицу `Правила доверия`. Клик по строке заполняет форму редактирования ниже. Таблица сортируется по столбцам. Кнопка удаления у обычного правила удаляет только это правило.

Старые записи типа `Признак доверия` больше не создаются через интерфейс, но уже сохраненные признаки показываются в той же таблице как строки `Старый признак`. Если такую строку сохранить, UI преобразует ее в обычное правило и отвяжет старые вложенные правила от признака, чтобы не потерять текущую логику. Если старый признак удалить, будут удалены сам признак и связанные с ним старые вложенные правила; перед удалением UI показывает подтверждение с количеством связанных правил.

Форма правила меняется по полю `Что проверяем`.

Для `namespace` значение выбирается из полного списка MediaWiki namespaces (`GET /api/admin/wiki/namespaces`). В интерфейсе показывается человекочитаемый вариант `id - имя`, например `3030 - CorpHR`, но в payload правила все равно сохраняется строка с числовым id namespace, например `3030`.

Для `title` значение выбирается из найденных страниц (`GET /api/admin/wiki/pages`). По мере ввода админка обновляет подсказки. В payload сохраняется обычный title страницы, например `CorpIT:Инструкция VPN`.

Для `category`, `tag`, `author_group` и `template` значение выбирается из справочников MediaWiki: categories, tags, user groups и templates. В payload сохраняется строковое имя без отдельной копии схемы прав. Для тегов админка показывает техническое имя тега, а не HTML `displayname` MediaWiki; для шаблонов показывает имя без префикса `Шаблон:`.

Для `property`, `status` и `date_property` используется `Свойство страницы / SMW-свойство`; список свойств берется из вкладки `Онтологические векторы` через `GET /api/admin/smw/ontology`. Значения подсказываются из уже проиндексированного `semantic_facts` payload в Qdrant через `GET /api/admin/semantic/status`. Если свойство новое или еще не попадало в индекс, список значений будет пустым и поле останется ручным вводом.

Прямые endpoints `/rules` используются для новых правил без выбора признака. Endpoints `/entities` и `/entities/:entityId/rules` оставлены для обратной совместимости и миграции старых данных.

В `Preview` namespace выбирается из списка, title подсказывается из страниц, а категории, теги, группы автора и шаблоны вводятся как chips-списки. Это нужно, чтобы проверить правило на нескольких признаках страницы без ручного CSV-ввода.

`Флаги результата` - это не права доступа и не категории. Это короткие метки, которые правило добавляет в результат доверия, например `verified`, `official`, `outdated`, `manual-review`. Они попадают в `trust_flags` Qdrant payload и помогают объяснить, почему источник был выбран, понижен или требует ручной проверки.

Этот этап не вызывает LLM/OpenAI. Gateway применяет активную trust model после проверки прав чтения в `/api/search` и `/api/chat`: сначала отбираются readable chunks, затем trust policy исключает черновики и низкодоверенные документы из RAG-контекста.

### Проверка противоречий

Блок `Проверка противоречий` находится во вкладке `Модель доверия`, потому что он использует результат trust-фильтрации. Порядок такой: MediaWiki ACL отбрасывает недоступные страницы, trust policy оставляет допустимые chunks, затем отдельный LLM-запрос сравнивает оставшиеся источники между собой. Если найдены несовместимые утверждения или уверенность детектора низкая, чат показывает отдельное предупреждение: про возможные противоречия или про необходимость проверки надежности источников.

Настройки:

- `enabled` - включает автоматическую проверку в чате.
- `runMode=risk_only` - режим по умолчанию: проверка запускается только при признаках ненадежности источников в RAG-контексте. Здесь "риск" не означает бизнес- или security-риск; это риск получить ответ на базе спорных или слабо размеченных источников. Сейчас риск считается так:
  - в ответ попали минимум 2 источника;
  - у какого-то источника нет `trustScore`;
  - или у какого-то источника `trustScore` ниже порога;
  - или разница `trustScore` между двумя лучшими источниками слишком маленькая, то есть нет явно более надежного источника.
- `runMode=always` - проверяет каждый чат с двумя и более источниками.
- `runMode=manual` - не запускает проверку в чате; остается только кнопка теста в админке.
- `model` - модель LiteLLM/OpenAI-compatible для анализа противоречий. Обычно можно оставить ту же модель, что у LLM-ответа.
- `systemPrompt` - инструкция, которая отправляется LLM-анализатору как system message. В ней фиксируется правило: сравнивать только предоставленные wiki-источники, не добавлять внешние знания и возвращать JSON. Вопрос пользователя и тексты источников Gateway добавляет отдельным user message во время проверки.
- `maxSources` - сколько найденных sources отдавать анализатору.
- `maxCharsPerSource` - сколько символов текста брать из каждого source, чтобы ограничить стоимость prompt.
- `trustGapThreshold` - если разница trust score между двумя лучшими источниками меньше порога, результат считается менее надежным.
- `lowConfidenceThreshold` - если LLM-анализатор вернул confidence ниже порога, чат показывает warning.
- `showConflictBlock` - включает видимый warning block в чате. Если выключить, проверку можно оставить для будущей диагностики без вывода пользователю.

Практическая рекомендация: если модель доверия еще не развита, источники не размечены, `trustScore` отсутствует у значимой части документов или trust rules часто меняются, не ставьте `risk_only`. В таком состоянии система еще не умеет надежно понять, где риск низкий, поэтому лучше выбрать `runMode=always`: LLM будет проверять противоречия для каждого ответа с двумя и более источниками. Возвращайтесь к `risk_only` после настройки trust model, пересчета trust payload и появления стабильных `trustScore`.

`POST /api/admin/conflict-detection/test` делает реальный LLM-запрос на коротком встроенном примере про VPN/MFA. На тестовом стенде он может быть платным, поэтому запускайте его вручную, а не в автотестах по умолчанию.

Устаревание теперь считается по дате последнего редактирования страницы MediaWiki. Syncer сохраняет timestamp последней ревизии в payload `last_modified`, а Gateway уменьшает score на `stalenessPenaltyPerYear` за каждый полный год возраста документа. Дефолт: `0.1`. Например, документ с `baseScore=0.7`, последним редактированием 3 полных года назад и штрафом `0.1` получит итоговый score `0.4`, если нет других повышающих/понижающих правил.

После обновления этой логики нужен full reindex, чтобы старые chunks получили настоящий `last_modified` из MediaWiki. Webhook-переиндексация новых изменений продолжит обновлять timestamp автоматически.

Для записи trust metadata в Qdrant используется:

- `POST /api/admin/trust-scores/recalculate`.

Параметры: `modelId`, `dryRun`, `maxScan`, `batchSize`. По умолчанию `dryRun=true`, поэтому приемочный запуск не пишет payload. При `dryRun=false` Gateway пишет в Qdrant только trust-поля: `trust_score`, `trust_flags`, `applied_rules`, `applied_entities`, `trust_model_id`, `trust_* decisions`, `trust_calculated_at`.

Этот пересчет работает только поверх уже проиндексированных chunks в Qdrant. Он не выполняет reindex, не строит embeddings, не вызывает LLM/OpenAI и не ходит в MediaWiki за свежими атрибутами страницы.

Когда пересчет полезен:

- изменились модель доверия, правила, пороги, флаги или `stalenessPenaltyPerYear`;
- нужно пересчитать устаревание по уже сохраненному `last_modified`;
- после reindex или webhook нужно записать новые trust-поля в payload.

Если у страницы изменились категории, SMW-свойства, шаблоны, namespace или дата ревизии, сначала эти данные должны попасть в Qdrant через webhook или reindex. После этого trust recalculation применит текущую модель доверия к обновленному payload. Для обычных webhook `edit`, `move` и `protect` Syncer запускает точечный пересчет по `pageId`; полный ручной пересчет нужен в основном после изменения самой модели доверия или политики устаревания.

Gateway при старте проверяет коллекцию Qdrant и создает payload indexes для служебных полей доступа, namespace и trust-полей: `trust_score`, `trust_flags`, `applied_rules`, `applied_entities`, `trust_model_id`, `trust_* decisions`, `trust_calculated_at`. Если существующий индекс имеет несовместимый тип, старт Gateway завершается ошибкой с указанием поля.

После successful non-dry-run reindex админка опрашивает `GET /api/admin/reindex/status`; когда Syncer возвращает `state=completed`, Gateway один раз запускает trust recalculation без LLM/OpenAI и добавляет поле `trustRecalculation` в ответ status. Dry run и повторный status одного и того же job не пишут Qdrant payload повторно.

После webhook `edit`, `move` или `protect` Syncer переиндексирует страницу и вызывает внутренний Gateway endpoint `POST /api/internal/trust/recalculate-page` с `pageId`. Gateway пересчитывает только chunks этой страницы через Qdrant filter `page_id`. Ошибка этого вызова не отменяет webhook-индексацию, но возвращается в поле `trust_recalculation`.

Scheduled trust recalculation управляется во вкладке `Модель доверия` и через API:

- `GET /api/admin/trust-recalculation/config`;
- `POST /api/admin/trust-recalculation/config`.

По умолчанию scheduler выключен. При включении Gateway раз в `intervalMinutes` запускает `dryRun=false` recalculation с заданными `maxScan` и `batchSize`; операция не вызывает LLM/OpenAI.

Для production задайте общий `SYNCER_ADMIN_TOKEN` и `GATEWAY_BASE_URL` у Syncer.

## Онтологические Векторы

SMW ontology vectors управляются во вкладке `Онтологические векторы` и через API:

- `GET /api/admin/smw/ontology`;
- `GET /api/admin/smw/properties`;
- `POST /api/admin/smw/ontology`;
- `DELETE /api/admin/smw/ontology/:id`;
- `POST /api/admin/smw/ontology/:id/generate-vector`;
- `GET /api/admin/smw/ontology/:id/similarities`;
- `POST /api/admin/smw/ontology/clusterize`;
- `POST /api/admin/smw/ontology/classify-fragment`.

Первая таблица во вкладке кликабельна: строка выбирает свойство для редактирования, подсвечивается, а под таблицей показывается подстрочник выбранной записи. Векторная колонка показывает статус, модель, размерность, дату генерации и короткий preview текста, из которого строился вектор. Действия выполняются кнопками под формой выбранного свойства: `Сохранить`, `Удалить`, `Сгенерировать вектор`, `Похожие`.

### Где хранятся SMW-факты и ontology vectors

Ontology vector не записывается внутрь wiki-страницы. Внутри страницы хранится обычный wikitext с SMW-разметкой или вызовом шаблона, а embedding свойства хранится во внутреннем Gateway admin storage. В индекс WikiAI попадает не сам вектор свойства, а значения SMW-свойств страницы как `semantic_facts`.

Реальный фрагмент страницы может выглядеть так:

```wikitext
{{Корпоративный документ
|Департамент=ИТ-департамент
|Отдел=Service Desk
|Тип документа=Регламент процесса
|Владелец процесса=Руководитель Service Desk
|Статус документа=Действует
|Система=Service Desk
|Процесс=Заявка классифицируется по услуге, приоритету и влиянию на бизнес-процесс
|Дата действия=2026-05-31
|Критичность=Высокая
}}
```

Шаблон разворачивает эти параметры в SMW-аннотации:

```wikitext
| [[Департамент::{{{Департамент|}}}]]
| [[Отдел::{{{Отдел|}}}]]
| [[Тип документа::{{{Тип документа|}}}]]
| [[Владелец процесса::{{{Владелец процесса|}}}]]
| [[Статус документа::{{{Статус документа|Действует}}}]]
| [[Система::{{{Система|}}}]]
| [[Процесс::{{{Процесс|}}}]]
| [[Дата действия::{{{Дата действия|2026-05-31}}}]]
| [[Критичность::{{{Критичность|Средняя}}}]]
```

Семантический блок можно держать в начале страницы, в конце, внутри шаблона или скрытым от обычного чтения. Для WikiAI важна не позиция блока в wikitext, а результат SMW после сохранения: Syncer получает значения через SMW `ask`, а не собственным парсингом текста страницы.

### Когда заполняется индекс

При создании или каждом сохранении страницы MediaWiki сначала сохраняет wikitext и обновляет состояние SMW. Затем hook `PageSaveComplete` отправляет webhook `edit` в Syncer. Syncer перечитывает актуальный текст страницы, запрашивает у Gateway список SMW-свойств с `indexed=true`, выполняет SMW `ask` по этой странице, добавляет текстовый блок `Семантические свойства:` перед индексируемым текстом и перезаписывает chunks страницы в Qdrant с payload `semantic_facts`.

Если пользователь итерационно редактирует документ, каждое сохранение должно переиндексировать текущую версию страницы через webhook. Если webhook не сработал или Syncer недоступен, SMW-факты в MediaWiki уже могут быть новыми, но Qdrant/Search index останется старым до ручного или планового reindex.

Пользователь с правом редактирования страницы может поменять параметры шаблона или добавить прямую SMW-разметку вида `[[Департамент::Финансовый департамент]]`. WikiAI не отличает правку через форму от ручной правки wikitext: источником истины для индексации является фактический результат SMW после сохранения. Поэтому контроль допустимых значений должен обеспечиваться правами MediaWiki, формами, шаблонами, процессом ревью или отдельной диагностикой некорректных SMW facts.

Поле `SMW-свойство` выбирается из существующих страниц namespace `Свойство` в MediaWiki/SMW. AI-админка не создает новые SMW-свойства: сначала создайте страницу `Свойство:<имя>` в MediaWiki и задайте `[[Has type::...]]`, затем выберите ее в WikiAI. `id`, `label` и `dataType` не редактируются вручную: `id` вычисляется Gateway, `label` равен имени свойства, `dataType` берется из SMW `Has type`.

Список SMW-свойств загружается постранично через `GET /api/admin/smw/properties?limit=100&continue=...`. Если свойств больше 100, используйте поле поиска по началу имени свойства или кнопку `Показать еще`. Если UI показывает `Route GET:/api/admin/smw/properties... not found`, значит MediaWiki обращается к старому Gateway runtime: обновите или перезапустите Gateway на `127.0.0.1:3000`.

Метаданные свойства включают `name`, `description`, `dataType`, `indexed`, `aiExtractable`, `aiPromptHint`, `classificationThreshold`, `sensitive` и служебные поля. В UI флаг `sensitive` называется `Исключения обработки`: это техническое имя сохранено в API для совместимости. Если записи еще не сохранены в SQL admin storage, Gateway создает начальный список из `SMW_SYNC_PROPERTIES` с `indexed=true`. Для типовых свойств (`Департамент`, `Отдел`, `Тип документа`, `Владелец процесса`, `Статус документа`, `Система`, `Процесс`, `Дата действия`, `Критичность`) UI подставляет пример `description` и `aiPromptHint`, чтобы администратор мог редактировать по образцу.

`indexed=true` означает, что это SMW-свойство будет запрошено у MediaWiki и попадет в `semantic_facts` при reindex или webhook, если включен `semanticFactsEnabled`. `indexed=false` оставляет свойство в онтологическом каталоге и векторных операциях, но не добавляет его в payload индексации. `SMW_SYNC_PROPERTIES` теперь bootstrap/fallback для пустого registry и ручных запусков Syncer без Gateway, а не основной способ runtime-управления.

`Удалить` снимает свойство с управления WikiAI, но не удаляет SMW-свойство и значения со страниц MediaWiki. После удаления свойство не будет запрашиваться для новых webhook/reindex. Старые `semantic_facts` в уже записанных chunks сохранятся до переиндексации соответствующих страниц.

Вкладка `Исключения обработки` управляет только флагом `sensitive` у свойств, которые уже есть в ontology registry. Администратор сам решает, какие свойства исключать и почему. Чтобы включить исключение для SMW-свойства, сначала добавьте и настройте его во вкладке `Онтологические векторы`, при необходимости сгенерируйте вектор, затем во вкладке `Исключения обработки` поставьте галку `Исключать из обработки`. Снятие галки делает `sensitive=false`: SMW-свойство, значения на страницах, запись ontology registry, `indexed`, `aiExtractable`, `AI prompt hint` и threshold не меняются.

`Исключение обработки` - это AI-флаг, а не право доступа MediaWiki. При включенном исключении известные значения свойства не включаются в source text вектора, а классификация фрагмента исключает такие свойства без явного `includeSensitive=true`. Это не удаляет данные со страниц, не удаляет SMW-свойство и не является заменой ACL.

Генерация вектора использует текущую embedding config. При `provider=ollama` это локальный `/api/embeddings`; при `provider=openai_compatible` это OpenAI-compatible `/embeddings`, поэтому UI/API помечают операцию как `paidApiPossible=true`. Source text для вектора строится из имени SMW-свойства, description, SMW type, `aiPromptHint` и ограниченной выборки известных значений из Qdrant `semantic_facts`. Для свойств с включенным исключением обработки сами значения не включаются в source text. Сырые embedding-массивы остаются во внутреннем admin storage и не возвращаются через admin API.

`similarities` считает cosine similarity между уже сгенерированными ontology vectors. `clusterize` группирует близкие свойства по threshold и возвращает отдельный список isolated properties, у которых нет близких соседей.

`classify-fragment` принимает текстовый фрагмент, строит embedding через текущий provider и подбирает подходящие SMW-свойства по ontology vectors. По умолчанию свойства с включенным исключением обработки не участвуют в классификации; для их включения нужно передать `includeSensitive=true`. Результат содержит top candidates, `matches` выше threshold, diagnostics по пропущенным свойствам и metadata о возможной платности embedding provider.

Для webhook Syncer запрашивает актуальный список indexed SMW properties у Gateway через `GET /api/internal/smw/indexed-properties`. Если Gateway недоступен, Syncer использует fallback `SMW_SYNC_PROPERTIES` и возвращает это в `smw_properties_source=config`. Поэтому новое свойство, добавленное администратором в ontology registry, попадет в `semantic_facts` при следующем webhook для страницы, если у свойства включен `indexed=true`.

### Мягкое автозаполнение SMW-полей

SMW autofill управляет не полем глобально, а парой `документ + SMW-свойство`. Если пользователь вручную изменил `Департамент` в одном документе, ручным становится только `Департамент` этого документа. Остальные документы и остальные поля продолжают работать в автоматическом режиме.

По умолчанию autofill выключен, а безопасный режим по умолчанию - `suggest_only`. После включения Gateway может анализировать пустые поля шаблона `{{Корпоративный документ}}`, строить рекомендации по ontology registry и сохранять состояние владения в таблице `ai_smw_autofill_fields`. Runtime-запись в MediaWiki делает только Syncer через сервисного пользователя MediaWiki; для production используйте `MW_SERVICE_USERNAME` и `MW_SERVICE_PASSWORD` или `MW_SERVICE_PASSWORD_SECRET` с Indeed PAM/AAPM.

В админке управление доступно во вкладке `Автозаполнение SMW`: включение, режим, порог уверенности, шаблоны, namespaces, лимит текста страницы и таблица последних состояний полей.

Доступные режимы:

- `suggest_only` - Gateway сохраняет предложения и диагностику, но Syncer не пишет в wiki.
- `apply_empty` - Syncer заполняет только пустые auto-managed параметры шаблона, если confidence не ниже `minConfidence`.

Состояния поля:

- `auto` - поле может заполняться системой;
- `suggested` - есть рекомендация, но она еще не применена или ниже порога автоприменения;
- `user` - пользователь вручную изменил или очистил поле, система больше его не трогает;
- `disabled` - поле отключено для этого документа.

Если поле равно последнему AI-значению, оно остается auto-managed. Если после пользовательской правки значение отличается от последнего AI-значения или пользователь очистил поле, Gateway переводит только это поле этого документа в `user`. Вернуть поле в автоуправление можно через `POST /api/admin/smw/autofill/reset-ownership`.

API:

- `GET /api/admin/smw/autofill/config`;
- `POST /api/admin/smw/autofill/config`;
- `GET /api/admin/smw/autofill/status`;
- `POST /api/admin/smw/autofill/test`;
- `POST /api/admin/smw/autofill/reset-ownership`;
- internal `POST /api/internal/smw/autofill/evaluate`;
- internal `POST /api/internal/smw/autofill/applied`.
