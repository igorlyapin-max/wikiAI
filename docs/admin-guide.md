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
Anonymous не должен получать `readable` для этих страниц через MediaWiki API.
При апгрейде со старой схемы seed заменяет legacy-страницы
`CorpCommon:WikiAI/Администрирование...` безопасными stub-страницами, а read-ACL
закрывает legacy-префикс от anonymous, чтобы старые заголовки не появлялись в
anonymous search. После миграции нужен full reindex dense и ColBERT, чтобы
убрать старое содержимое из Qdrant.

В `Служебная:AI-администрирование` ссылка `Справка` ведет на центральную wiki-страницу документации.

## Основные разделы

Планируемая структура админки:

- `Обзор` - состояние Gateway, Syncer, Redis, Qdrant, LiteLLM/Ollama.
- `Сервисы` - базовые URL и статусы подключений.
- `LLM` - модель, temperature, max tokens, timeout, smoke test.
- `Embeddings` - embedding provider/model, vector dimension, test embedding.
- `Webhook` - endpoint Syncer, события, timeout/retry, last status, test.
- `RAG / Chunking` - top-k, chunk size, overlap, separators, context limits.
- `Индексация` - profiles, filters, SMW properties, manual reindex.
- `Распознавание документов` - MIME policy и режимы `text`, `ocr`, `metadata`, `disabled`.
- `Модель доверия` - активная trust model, правила доверия, preview и пересчет payload.
- `Хранение чатов` - TTL, archive/export policy, limits.
- `Онтологические векторы` - SMW property metadata, vectors, similarities, clusters.
- `Внешний API` - REST API/MCP, OIDC Bearer auth, лимиты top-k и ACL mode для внешних систем.
- `Логи` - audit log изменений администрирования.

Кнопка `Test` во вкладке `Сервисы` проверяет Syncer `/health`, показывает redacted database URL и диагностирует Qdrant collection: фактический размер вектора, ожидаемые `768` измерений, совместимость, `points_count` и `indexed_vectors_count`.

## Secrets

Админка не должна показывать значения секретов:

- `LITELLM_API_KEY`;
- `SYNCER_ADMIN_TOKEN`;
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

ACL mode:

- `mediawiki_check` - режим по умолчанию. После retrieval Gateway спрашивает MediaWiki API, readable ли исходная страница для текущего cookie или Bearer. Это надежнее и должно быть production default.
- `groups_only` - fallback, который доверяет `allowed_groups` из индекса. Его можно использовать только осознанно, когда MediaWiki не принимает Bearer для readable-check.

MCP adapter не имеет прямого доступа к Qdrant, Redis, SQLite или MediaWiki. Он вызывает только Gateway external API:

```bash
WIKIAI_GATEWAY_URL=http://127.0.0.1:3000 \
WIKIAI_ACCESS_TOKEN=<oidc-access-token> \
node packages/mcp-adapter/src/server.mjs
```

Для локального embedded-сценария можно использовать `WIKIAI_COOKIE`, но для передачи заказчику production-путь для сторонних систем - OIDC Bearer.

## RAG / Chunking

До внедрения indexing profiles текущий runtime использует:

- Gateway runtime config: `topK`, `chunkSize`, `chunkOverlap`;
- Syncer env fallback: `CHUNK_SIZE`, `CHUNK_OVERLAP`;
- Syncer reindex options: `attachmentsEnabled`, `semanticFactsEnabled`, `namespaces`, `maxPages`.

После внедрения profiles источник истины для chunking должен быть profile, переданный в reindex job.

### Гибридный поиск

Вкладка `RAG / Chunking` также управляет ранжированием поиска:

- `searchMode`: `hybrid` по умолчанию смешивает Qdrant vector search и SQLite FTS5/BM25; `vector_only` оставляет старое dense-only поведение; `colbert_full` ищет первый набор кандидатов в отдельном ColBERT index; `hybrid_colbert` сначала использует текущий hybrid, затем переставляет кандидатов через ColBERT.
- `vectorWeight`: вес смысловой близости Qdrant. Дефолт `0.65`.
- `lexicalWeight`: вес точного текстового совпадения BM25. Дефолт `0.35`.
- `vectorCandidateLimit`: сколько кандидатов брать из Qdrant до ACL/trust-фильтров. Дефолт `50`.
- `lexicalCandidateLimit`: сколько кандидатов брать из FTS5 до ACL/trust-фильтров. Дефолт `50`.
- `lexicalMinMatchedTerms`: сколько разных слов запроса должен содержать BM25-кандидат. Дефолт `2`. Если в запросе одно слово, требуется одно; если слов несколько, совпадение только по одному широкому слову вроде `система` отбрасывается. Для русских окончаний используется короткий нормализованный префикс: `древние`, `Древний` и `Древняя` считаются одним BM25-термом `древн`.
- `lexicalGateMode`: `when_bm25_available` по умолчанию. Если BM25 нашел хотя бы одного кандидата, выдача строится только из BM25-кандидатов; vector score используется только как дополнительный вес для тех же chunks. `off` возвращает старое поведение, где semantic-only кандидаты тоже могут попасть в итоговый список.
- `vectorOnlyFallbackEnabled`: включает fallback на чистый vector search, когда BM25 не нашел ни одного кандидата. Дефолт `true`.
- `vectorOnlyFallbackMinScore`: отдельный высокий порог для такого fallback. Дефолт `0.78`, чтобы случайные semantic-only соседи не попадали в выдачу слишком легко.
- `minSearchScore`: старый порог только для vector-кандидатов.
- `minFinalScore`: порог уже после смешивания vector/BM25.
- `showRawScores`: показывать технический score в пользовательском AI Search. По умолчанию `false`, потому что score - это величина ранжирования, а не доверие к ответу.
- `rerankMode`: `none` по умолчанию. `colbert_v2` оставлен для совместимости и включает ColBERT rerank после текущего hybrid-поиска.
- `colbertBaseUrl`: адрес on-prem ColBERT service. В compose это `http://colbert:8080`, с хоста `http://127.0.0.1:8083`.
- `colbertModel`: имя модели. Дефолт `antoinelouis/colbert-xm`.
- `colbertCollection`: отдельная Qdrant collection для ColBERT multivectors. Дефолт `wiki_colbert_chunks`.
- `colbertCandidateLimit`: сколько ColBERT-кандидатов брать до ACL/trust или сколько разрешенных chunks отправлять на rerank. Дефолт `50`.
- `colbertTimeoutMs`: timeout HTTP-запроса к ColBERT. Дефолт `5000`.
- `colbertMinScore`: минимальный score ColBERT для сохранения результата. Дефолт `0`.
- `colbertFailMode`: `fallback_current` по умолчанию возвращает текущую hybrid-выдачу, если ColBERT недоступен; `fail_search` останавливает поиск ошибкой.

Пример: запрос `Администрирование систем` может быть близок по vector score к нерелевантной общей статье, если embeddings считают тексты общими. BM25 добавляет простой текстовый сигнал: документы, где реально встречаются слова запроса, получают дополнительный вес и поднимаются выше.

С включенным `lexicalMinMatchedTerms=2` и `lexicalGateMode=when_bm25_available` такая нерелевантная статья не просто опускается ниже, а исключается из кандидатов, если она совпала только по одному общему слову. При этом запрос `древние цивилизации` найдет `Древний Египет` и `Древняя Греция`, потому что BM25 сравнивает нормализованные префиксы слов, а не только полные окончания. Если FTS нашел raw BM25-кандидатов, но все они отфильтрованы как слишком широкие, `vectorOnlyFallback` не включается: лучше показать пустую или узкую выдачу, чем подмешать нерелевантные semantic-only страницы. Это не замена правам доступа: после ранжирования Gateway все равно проверяет чтение исходной страницы через MediaWiki ACL.

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

Кнопка `Тест` в блоке ColBERT проверяет `/health` по текущему `colbertBaseUrl`; сохранение настроек для теста не требуется. Кнопка `Переиндексировать ColBERT` сохраняет текущую RAG-конфигурацию и запускает обычный Syncer reindex без LLM enrichment, чтобы не включать платный OpenAI API.

### Где здесь AI

В AI Search LLM не читает запрос и не выбирает документы. AI используется в embedding-модели:

- при индексации Syncer отправляет текст chunk в embedding-модель и получает числовой vector;
- при поиске Gateway отправляет пользовательский запрос в ту же embedding-модель и получает vector запроса;
- Qdrant сравнивает vector запроса с vectors chunks и возвращает ближайшие;
- BM25/FTS5 не использует AI, а ищет совпадения по словам.

Если совсем просто: embedding-модель переводит смысл текста в набор чисел. Qdrant не является AI-моделью; он только считает, какие наборы чисел ближе друг к другу.

FTS5-индекс хранится в том же SQLite admin storage, что и настройки. Syncer обновляет его через `POST /api/internal/search-index/page` при webhook/reindex и очищает через `POST /api/internal/search-index/delete-page` при delete webhook. Для старых Qdrant chunks нужен один full reindex, иначе BM25 будет заполнен только для страниц, измененных после внедрения.

Статус BM25-индекса в админке показывает количество страниц, chunks и FTS chunks. Если `backfill нужен: да`, гибридный поиск сможет fallback-иться в vector-only чаще, чем ожидается.

Если нужно заполнить BM25 без повторного построения embeddings, используйте backfill из уже существующего Qdrant payload:

```bash
QDRANT_URL=http://127.0.0.1:6333 \
GATEWAY_BASE_URL=http://127.0.0.1:3000 \
node scripts/backfill-search-index-from-qdrant.mjs
```

Скрипт не вызывает LLM/OpenAI и не строит embeddings: он читает payload chunks из Qdrant и пишет их в SQLite FTS через внутренний Gateway endpoint.

## Распознавание Документов

Распознавание документов управляется MIME policy:

- `text` - извлекать текст;
- `ocr` - распознавать изображение;
- `metadata` - индексировать только метаданные;
- `disabled` - не индексировать.

Изменение policy должно фиксироваться в audit log.

## Live LLM

OpenAI/LiteLLM smoke tests считаются платными. Запускайте их только при явном opt-in и с минимальным prompt.

## LLM и Embeddings

LLM-настройки управляются через вкладку `LLM` и endpoints:

- `GET /api/admin/llm/config`;
- `POST /api/admin/llm/config`;
- `POST /api/admin/llm/test`.

`/api/admin/llm/test` делает реальный OpenAI-compatible chat request через LiteLLM и может быть платным.

Для переключения chat/RAG-ответов на OpenAI не вводите OpenAI key в WikiAI. Настройте OpenAI key и route в LiteLLM, затем в WikiAI укажите модель-алиас LiteLLM, например `corp-openai-gpt-4.1-mini`. На продуктиве `LITELLM_MODEL` должен быть alias в LiteLLM, а не прямое имя провайдера. Если во вкладке `LLM` уже сохранена другая модель, admin override имеет приоритет над env и его нужно заменить на этот alias.

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

Статус reindex показывает разные счетчики: `найдено страниц` - сколько страниц подошло под профиль до лимита, `в обработке` - сколько реально поставлено в job после лимита, `обработано страниц` - сколько страниц записано в индекс, `пропущено` - пустые или недоступные страницы, `фрагментов RAG` - сколько chunks получилось после разбиения текста. Дополнительные счетчики стоимости: `embedding calls` - сколько embedding-вызовов сделано при записи, `LLM enrichment` - сколько страниц было обогащено через LLM, `estimated paid calls` - оценка потенциально платных вызовов, если embeddings или enrichment идут через OpenAI-compatible endpoint.

`Включить LLM-обогащение reindex` по умолчанию выключено. Если включить его в ручном запуске и `dryRun=false`, Syncer один раз на страницу вызывает Gateway internal endpoint `/api/internal/reindex/llm-enrich`, Gateway делает короткий chat/completions запрос через LiteLLM, а результат кладется в payload chunk как `ai_summary`, `ai_keywords` и `ai_enrichment_model`. Это может улучшить поиск по документам с плохой структурой, но добавляет платный LLM-вызов на каждую обработанную страницу. Для приемки сначала используйте `dryRun=true` и маленький `maxPages`: dry-run покажет оценку, но не будет вызывать LLM и не будет писать Qdrant.

Фильтры по названию работают как case-insensitive contains. Например, `CorpIT:,Регламент` оставит страницы, где в заголовке есть `CorpIT:` или `Регламент`. Исключение по названию сильнее включения, поэтому `Черновик` уберет страницу даже при совпадении с include.

Категория - это сущность MediaWiki: страница попадает в категорию, если в wikitext есть `[[Категория:ИТ]]` или `[[Category:IT]]`. Во вкладке `Индексация` категории выбираются из видимого списка `Доступные категории MediaWiki`; поле над списком служит для поиска по справочнику через `GET /api/admin/wiki/categories`. Category filters сравниваются точным совпадением по нормализованному имени категории: `ИТ` совпадает с `Категория:ИТ`, но не совпадает с `Категория:Аудит`. Исключение категории сильнее включения.

Эти фильтры определяют область индексации, а не права доступа. Для безопасности RAG используется проверка чтения исходной страницы через MediaWiki.

`documentPolicyId` сейчас связывает profile с MIME policy `default`; отдельные именованные MIME policy остаются следующим этапом.

Для `runMode=scheduled` Gateway scheduler раз в минуту проверяет due profiles и запускает Syncer reindex с интервалом `scheduleIntervalMinutes`. Scheduler применяет профиль на стороне Gateway и передает Syncer тот же набор параметров, что ручной запуск, включая текущий список indexed SMW-свойств из онтологии. Вкладка `Индексация` показывает next run, last run, running flag и последнюю ошибку scheduled profiles.

## Хранение Чатов

Политика хранения чатов управляется во вкладке `Хранение чатов` и через API:

- `GET /api/admin/chat-retention/config`;
- `POST /api/admin/chat-retention/config`;
- `GET /api/admin/chat-sessions`;
- `GET /api/admin/chat-sessions/:id/messages`;
- `POST /api/admin/chat-sessions/:id/archive`;
- `POST /api/admin/chat-sessions/:id/export`.

Пользовательский архив выгружается через `POST /api/chat/archive/export`; endpoint возвращает только archived sessions текущего MediaWiki user.

Настройки включают `retentionMode`, `activeDays`, `recentDays`, `archiveDays`, лимиты количества чатов, действие `onLimitExceeded` и export options. По умолчанию используется `retentionMode=archive` и `activeDays=7`: активные чаты старше 7 дней переносятся в архив. Gateway применяет политику к Redis TTL истории чатов: для `auto_delete` используется `activeDays`, для `archive` и `export_then_archive` - `archiveDays`.

Дополнительно Gateway ведет SQL registry `chat sessions/messages/archive/export`. При новом сообщении создается или обновляется session, сообщения пишутся в SQL, а Redis остается быстрым runtime cache. Лимиты `maxActiveChats`, `maxTotalChats` и политика `onLimitExceeded` применяются перед созданием новой активной сессии: `block_new` отклоняет чат, `archive_oldest` архивирует старую активную сессию, `delete_oldest` очищает старую сессию.

Вкладка `Хранение чатов` показывает счетчики registry, последние sessions и read-only просмотр сообщений выбранной session. Ручные кнопки `Archive`/`Export JSON` на каждой session в админском UI не выводятся.

В пользовательском `Special:AIAssistant` вкладка `Чат` показывает историю собственных активных и архивных чатов. Название session берется из первого вопроса пользователя и обрезается до короткой строки. Активную session можно продолжить, архивная session открывается read-only. В режиме `Архив` доступна кнопка выгрузки всего архива текущего пользователя; export использует текущие `exportOptions` и не вызывает LLM/OpenAI.

Для активной session RAG использует текущий вопрос вместе с недавним контекстом этой же беседы. Это позволяет уточняющим запросам находить источники по предыдущей теме без хрупкого распознавания фраз вроде "еще раз". Архивные sessions в новых retrieval-запросах не участвуют.

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
- `runMode=risk_only` - режим по умолчанию: проверка запускается, когда в контекст попали минимум два источника и есть сигнал риска: низкий trust у одного источника, маленькая разница trust score между лучшими источниками или отсутствующие trust scores.
- `runMode=always` - проверяет каждый чат с двумя и более источниками.
- `runMode=manual` - не запускает проверку в чате; остается только кнопка теста в админке.
- `model` - модель LiteLLM/OpenAI-compatible для анализа противоречий. Обычно можно оставить ту же модель, что у LLM-ответа.
- `maxSources` - сколько найденных sources отдавать анализатору.
- `maxCharsPerSource` - сколько символов текста брать из каждого source, чтобы ограничить стоимость prompt.
- `trustGapThreshold` - если разница trust score между двумя лучшими источниками меньше порога, результат считается менее надежным.
- `lowConfidenceThreshold` - если LLM-анализатор вернул confidence ниже порога, чат показывает warning.
- `showConflictBlock` - включает видимый warning block в чате. Если выключить, проверку можно оставить для будущей диагностики без вывода пользователю.

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
