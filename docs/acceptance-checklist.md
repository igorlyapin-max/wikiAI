# Wiki AI Acceptance Checklist

## Admin UI

- [ ] `Служебная:AI-администрирование` открывается у `sysop`.
- [ ] `Служебная:AI-администрирование` открывается у `aiadmin`.
- [ ] Обычный пользователь получает отказ.
- [ ] Видны статусы Gateway, Syncer, Redis, Qdrant, LiteLLM/Ollama.
- [ ] Gateway health не degraded по Redis/LiteLLM; если сервисы в других compose-проектах, используется сетевой override или routable service URL.
- [ ] Gateway `/metrics` отдает Prometheus text format и доступен только из внутреннего monitoring path.
- [ ] Syncer `/metrics` отдает Prometheus text format и доступен только из внутреннего monitoring path.
- [ ] Browser preflight `OPTIONS /api/search` от MediaWiki origin получает CORS response, если UI ходит на Gateway напрямую.
- [ ] Перед поставкой/сборкой MediaWiki extension выполнены `npm --prefix packages/mw-extension/resources/ai-assistant run build` и `npm --prefix packages/mw-extension/resources/ai-admin run build`; `resources/ai-assistant/dist/index.js` и `resources/ai-admin/dist/index.js` содержат актуальные UI-формулировки.
- [ ] Secrets не отображаются.
- [ ] `Служебная:AI-администрирование?uselang=ru` показывает русские вкладки, кнопки, labels и статусы admin ResourceLoader bundle.
- [ ] `Special:AIAdmin?uselang=en` показывает английские вкладки, кнопки, labels и статусы admin ResourceLoader bundle.
- [ ] `RUN_WIKIAI_ENV_DEV=1 node scripts/test-wikiai-env-dev.mjs` проверяет served `ext.aiadmin` bundle и authenticated `Special:AIAdmin`, если задан `MW_TEST_COOKIE` или `WIKIAI_ADMIN_COOKIE`.
- [ ] `Special:AIAdmin` содержит отдельную вкладку `OpenSearch`, а не только блок внутри `Сервисы`.
- [ ] API data values, enum/status names и ошибки внешних сервисов не переводятся, если они являются диагностическими данными.
- [ ] В `Служебная:AI-администрирование` видна ссылка `Справка`.
- [ ] `WikiAIAdmin:Администрирование` открывается у `sysop`/`aiadmin` и содержит ссылки на все страницы документации админки.
- [ ] Anonymous MediaWiki API для `WikiAIAdmin:Администрирование` не возвращает `readable`.
- [ ] Anonymous MediaWiki API для `CorpCommon:WikiAI/Администрирование` не возвращает `readable`.
- [ ] Syncer service auth настроен через `MW_SERVICE_USERNAME` + `MW_SERVICE_PASSWORD` или `MW_SERVICE_PASSWORD_SECRET` для пользователя из `ai-exec`/`aiadmin`; `POST /api/admin/service-config/test` показывает успешный MediaWiki auth.
- [ ] Protected reindex без MediaWiki service auth возвращает понятную ошибку до обхода страниц; public-only reindex остается разрешенным.
- [ ] Legacy `CorpCommon:WikiAI/Администрирование...` после seed содержит только безопасную stub-страницу.
- [ ] `node scripts/seed-ai-admin-docs.mjs --dry-run` показывает управляемые страницы без записи в wiki.

## Service Config

- [ ] `GET /api/admin/service-config` возвращает redacted runtime config.
- [ ] `POST /api/admin/service-config` валидирует значения.
- [ ] Invalid URL отклоняется.
- [ ] Secret values не возвращаются в response.
- [ ] Изменение фиксируется в audit log.
- [ ] `POST /api/admin/service-config/test` показывает Qdrant collection, vector dimension compatibility и points count.
- [ ] `POST /api/admin/service-config/test` показывает источник Syncer MediaWiki auth без раскрытия пароля/secret reference.

## LLM / Embeddings

- [ ] `GET /api/admin/llm/config` не возвращает API key.
- [ ] `POST /api/admin/llm/config` меняет model/base URL/timeout и runtime answer settings.
- [ ] `POST /api/admin/llm/test` запускается только при подтвержденной готовности использовать платный API.
- [ ] `GET /api/admin/embedding/config` показывает Ollama base URL/model.
- [ ] `POST /api/admin/embedding/test` возвращает dimension локального embedding-вектора.

## Webhook

- [ ] `GET /api/admin/webhook/config` показывает ожидаемый Syncer URL.
- [ ] Вкладка `Webhook` показывает текущий `$wgAIAssistantSyncerUrl` из MediaWiki.
- [ ] UI показывает warning, если `$wgAIAssistantSyncerUrl` отличается от ожидаемого Syncer URL.
- [ ] `POST /api/admin/webhook/config` сохраняет события и retry settings.
- [ ] Safe webhook test не создает и не меняет страницы.
- [ ] Ошибка Syncer показывается как diagnostics, а не как crash.

## RAG / Chunking

- [ ] `GET /api/admin/rag/config` показывает текущие параметры.
- [ ] `POST /api/admin/rag/config` валидирует границы.
- [ ] `RAG / Chunking` показывает source-aware matrix для `wiki_page`, `attachment_text`, `attachment_metadata`, `cmdb_dynamic_snapshot` и namespace overrides для wiki pages.
- [ ] Профиль поиска разделяет `retrievalTopK` для search/API results и `contextTopK`/`contextMaxChars` для LLM prompt; встроенный чат показывает источники только из prompt context.
- [ ] Встроенный чат схлопывает несколько chunks одной страницы/attachment в один source group и показывает только источники, реально процитированные через `[Источник N]`, сохраняя исходный `citationIndex`.
- [ ] Chunking параметры и `chunkingPolicy` передаются в reindex; статус reindex показывает chunk counts by source type.
- [ ] `searchMode=hybrid` смешивает Qdrant vector candidates и SQLite FTS5/BM25 candidates.
- [ ] `vectorWeight`, `lexicalWeight`, `vectorCandidateLimit`, `lexicalCandidateLimit`, `minFinalScore` меняются из Admin UI.
- [ ] Вкладка `BM25` содержит experimental features: `lexicalNormalizationMode`, синонимы, латиница/кириллица, typo tolerance и `trigramIndexEnabled`; Soundex/rsoundex отсутствуют.
- [ ] `POST /api/admin/search-index/trigram/backfill` возвращает `202` и запускает async job, который пересобирает trigram index из `ai_search_chunks` без embeddings/LLM.
- [ ] `GET /api/admin/search-index/trigram/backfill/status` показывает `processedChunks`, `totalChunks`, `writtenChunks`, `grams`, `status`, `startedAt` и `finishedAt/error` при завершении.
- [ ] `POST /api/admin/search-index/trigram/backfill/cancel` запрашивает остановку running job и Admin UI отключает/включает кнопки start/cancel по статусу.
- [ ] `POST /api/admin/rag/config` отклоняет `trigramIndexEnabled=true`, если `trigramPopulated=false`, с ошибкой `trigram_index_not_ready`.
- [ ] Admin UI разделяет `RAG / Embeddings`, `BM25`, `ColBERT`, `Выбор профиля для MediaWiki`, `Распознавание документов` и `Индексация`.
- [ ] `GET/POST /api/admin/mediawiki-profile/config` выбирает profile для `/api/search` и `/api/chat`; request body `retrievalProfileId` не переопределяет выбор администратора.
- [ ] Default MediaWiki profile - `opensearch_hybrid_colbert`; если OpenSearch/ColBERT/index targets не готовы, search/chat возвращают readiness-ошибку без fallback.
- [ ] `GET /api/admin/search-index/status` показывает `prod_ready`, только если BM25 заполнен и ColBERT health `ok`.
- [ ] Без ColBERT контур помечается `limited_ready`, а не production-ready.
- [ ] Пользовательский AI Search не показывает raw score при `showRawScores=false`.
- [ ] Sources в search/chat используют внешний `MW_PUBLIC_BASE_URL` и не содержат Docker-internal `http://mediawiki`.
- [ ] `searchMode=hybrid` находит `кухня` по запросу `кухню` и не подмешивает нерелевантные vector-only chunks при наличии BM25-кандидатов.
- [ ] При включенном `trigramIndexEnabled` запрос с короткой опечаткой использует trigram fallback до vector-only fallback.
- [ ] Diagnostics поиска показывают BM25 query terms, expanded terms, trigram fallback counters, `trigramLatencyMs` и `trigramSkippedReason`.
- [ ] Gateway `/metrics` содержит `wikiai_search_trigram_queries_total`, `wikiai_search_trigram_last_latency_ms`, `wikiai_search_trigram_raw_candidates_total`, `wikiai_trigram_backfill_jobs_total` и `wikiai_trigram_backfill_progress_chunks`.
- [ ] `node scripts/benchmark-trigram-readiness.mjs --queries <file> --start-backfill` печатает JSON с `readiness.passed/reasons`, backfill status, SQLite size before/after и p50/p95/p99 latency; production-включение разрешается только при `readiness.passed=true`.
- [ ] После full reindex FTS5 содержит chunks старых страниц, а webhook обновляет FTS5 для измененной страницы.

## Document Recognition

- [ ] MIME policy содержит PDF, изображения, офисные документы, media/archive и неизвестные типы.
- [ ] `docx/xlsx/pptx/odt/ods/odp` индексируются как text+metadata.
- [ ] `mp3/wav/mpeg/zip/7zip` индексируются metadata-only, без распаковки архивов и speech-to-text.
- [ ] Mermaid blocks индексируются как текст с `contentType=mermaid`.
- [ ] Можно добавить custom MIME.
- [ ] Можно отключить MIME.
- [ ] Policy reset возвращает defaults.

## Indexing

- [ ] Создается indexing profile.
- [ ] Reindex запускается по profile.
- [ ] `maxPages=1` работает на тестовом стенде.
- [ ] `dryRun=true` не пишет chunks в Qdrant.
- [ ] Profile chunk size/overlap передаются в Syncer.
- [ ] Profile содержит `indexTargets` и reindex умеет `dense`, `bm25`, `colbert`, `attachments`, `semanticFacts`, `ontologyVectors`.
- [ ] Распознанные attachment chunks содержат filename/MIME/parent page context и после reindex видны в search-index, OpenSearch и Qdrant diagnostics.
- [ ] `source=qdrant_payload` для `indexTargets=["colbert"]` не вызывает MediaWiki, dense embeddings или LLM enrichment.
- [ ] Search/chat проверяют MediaWiki `readable` для каждого chunk.
- [ ] Закрытая page-level страница в публичном namespace не попадает в AI-ответ.
- [ ] Публичная page-level страница в закрытом namespace может попасть в AI-ответ, если MediaWiki разрешает чтение.
- [ ] Admin docs в `WikiAIAdmin` и legacy `CorpCommon:WikiAI/Администрирование...` не попадают в anonymous search.
- [ ] Admin docs chunks в `wiki_chunks` и `wiki_colbert_chunks` не имеют `allowed_groups:["*"]`.
- [ ] Candidate ColBERT index создается отдельно от active collection.
- [ ] Failed ColBERT build не меняет active search.
- [ ] Promote разрешен только для complete candidate index.
- [ ] Title/category filters отсекают страницы до `maxPages`.
- [ ] Вкладка `Индексация` показывает понятные help-тексты для фильтров страниц.
- [ ] Category include/exclude выбираются из MediaWiki categories selector, а не вводятся только вручную CSV.
- [ ] Category filter `ИТ` совпадает с `Категория:ИТ`, но не совпадает с `Категория:Аудит`.
- [ ] Profile содержит `documentPolicyId`, `runMode` и `scheduleIntervalMinutes`.
- [ ] Syncer при `profileId` может прочитать profile defaults из общего SQLite admin storage.
- [ ] Gateway scheduler запускает `runMode=scheduled` profiles по `scheduleIntervalMinutes`.
- [ ] Вкладка `Индексация` показывает scheduler status для scheduled profiles.
- [ ] Qdrant payload содержит служебные поля доступа и semantic facts.
- [ ] Qdrant payload после trust recalculation содержит trust fields.

## Trust

- [ ] Создается trust model.
- [ ] Создаются entities и rules.
- [ ] Trust entity/rule/preview используют справочники MediaWiki для namespaces, pages, categories, tags, user groups и templates.
- [ ] Preview использует chips для categories/tags/author groups/templates без ручного CSV-ввода.
- [ ] Preview показывает applied entities/rules, flags, decisions и score.
- [ ] Preview не вызывает LLM/OpenAI.
- [ ] Изменения trust model/entities/rules фиксируются в audit log.
- [ ] Search/chat фильтруют readable chunks по активной trust policy.
- [ ] Search/chat response содержит trust metadata у возвращенных источников/chunks.
- [ ] `Проверка противоречий` содержит настройку `attachmentParentConflictMode` с дефолтом `risk_only`.
- [ ] Если attachment chunk и обычный page chunk той же страницы оба попали в context, `risk_only` запускает conflict detector и debug показывает пару в блоке `Attachment vs parent page`.
- [ ] Если attachment chunk есть, но parent page не попал в context, Gateway не делает дополнительный fetch/retrieval страницы, а debug показывает missing parent.
- [ ] `POST /api/admin/trust-scores/recalculate` с `dryRun=true` не пишет Qdrant payload.
- [ ] `POST /api/admin/trust-scores/recalculate` с `dryRun=false` пишет trust payload в Qdrant.
- [ ] Qdrant payload содержит `trust_score`, `trust_flags`, `applied_rules`, `applied_entities`, `trust_model_id`.
- [ ] Gateway startup создает Qdrant payload indexes по trust-полям перед production-фильтрацией на стороне Qdrant.
- [ ] После successful non-dry-run reindex status Gateway один раз запускает trust recalculation.
- [ ] Dry-run reindex status не запускает запись trust payload.
- [ ] Webhook `edit/move/protect` после индексации вызывает page-scoped trust recalculation без OpenAI.
- [ ] Ошибка Gateway trust notification не отменяет успешную webhook-индексацию.
- [ ] Scheduled trust recalculation по умолчанию выключен.
- [ ] При включении scheduled trust recalculation использует `maxScan`/`batchSize` и не вызывает OpenAI.

## Chat Retention

- [ ] `GET /api/admin/chat-management/config` возвращает `defaultChatProfileId`, `selectedProfile` и список `chatProfiles`.
- [ ] `POST /api/admin/chat-profiles` сохраняет `promptHistoryScope`, `retrievalHistoryMode`, лимиты истории и флаг `experimental`.
- [ ] `Профили поиска` сохраняют `chatProfileId`, а чат показывает в diagnostics `chatProfileId`, `promptHistoryScope` и `retrievalHistoryMode`.
- [ ] Retention config сохраняется.
- [ ] `GET /api/admin/chat-retention/config` возвращает `metadata.redisTtlSeconds`.
- [ ] Default chat retention: `retentionMode=archive`, `activeDays=7`; активные чаты старше 7 дней попадают в `Архив`.
- [ ] Redis TTL соответствует active/archive policy.
- [ ] Export settings не включают secrets.
- [ ] Chat message создает или обновляет SQL session registry.
- [ ] Streaming chat возвращает `conversation` SSE event, и второй вопрос в UI продолжает тот же `conversationId`.
- [ ] Второй вопрос в активном чате использует недавний контекст этой session для prompt; retrieval использует историю только если выбранный chat profile это разрешает.
- [ ] Пользовательская вкладка `Чат` показывает собственные активные/архивные sessions и открывает сохраненные сообщения.
- [ ] Session в пользовательской вкладке называется первым вопросом пользователя, длинное название обрезается.
- [ ] На карточках бесед нет кнопок `Архив`/`Экспорт`; экспорт доступен одной кнопкой `Выгрузить архив` только в режиме `Архив`.
- [ ] `POST /api/chat/archive/export` выгружает только archived sessions текущего пользователя и не включает активные или чужие sessions.
- [ ] Пользователь не может открыть messages/export/archive для чужого `sessionId`.
- [ ] `maxActiveChats` и `maxTotalChats` применяются к новым sessions.
- [ ] `block_new` возвращает отказ без вызова LLM.
- [ ] `archive_oldest` архивирует старую активную session.
- [ ] `delete_oldest` очищает старую session и сообщения.
- [ ] `GET /api/admin/chat-sessions` показывает sessions и registry counters.
- [ ] В админке `Управление чатами` кнопка `Открыть` показывает сообщения выбранной session; ручных кнопок `Archive`/`Export JSON` на строке session нет.
- [ ] `POST /api/admin/chat-sessions/:id/archive` создает архив.
- [ ] `POST /api/admin/chat-sessions/:id/export` создает export в выбранном формате.

## Ontology Vectors

- [ ] SMW property metadata сохраняется.
- [ ] Начальный список свойств берется из `SMW_SYNC_PROPERTIES`, если SQL storage пустой.
- [ ] Вектор property генерируется через local Ollama.
- [ ] Similarity search не использует OpenAI без opt-in.
- [ ] Clusterize action возвращает диагностируемый результат.
- [ ] Admin API не возвращает сырой embedding-массив.
- [ ] `POST /api/admin/smw/ontology/classify-fragment` возвращает candidates/matches по локальному embedding.
- [ ] `classify fragment` не вызывает OpenAI и не сохраняет embedding фрагмента.
- [ ] Свойства с включенным исключением обработки не участвуют в классификации без `includeSensitive=true`.

## Live Tests Without OpenAI

- [ ] `node scripts/test-wikiai-env-dev.mjs` проходит быстрый package-local gate без живого стенда.
- [ ] `RUN_WIKIAI_ENV_DEV=1 node scripts/test-wikiai-env-dev.mjs` проверяет Gateway, Syncer, MediaWiki ResourceLoader и Qdrant temporary collection без записи в wiki pages.
- [ ] `RUN_WIKIAI_ENV_DEV=1 RUN_EXTERNAL_API_MCP_E2E=1 RUN_EXTERNAL_API_MCP_AUTH_MODE=cookie WIKIAI_COOKIE=... WIKIAI_ADMIN_COOKIE=... node scripts/test-wikiai-env-dev.mjs` проверяет `/api/v1/capabilities`, `/api/v1/search`, `/api/v1/chat` и MCP stdio adapter на стенде без IdP.
- [ ] В режиме `auto` Bearer branch выполняется только при наличии `WIKIAI_ACCESS_TOKEN` и `oidcConfigured=true`; иначе cookie fallback является основным live auth path.
- [ ] External API/MCP config восстанавливается после live E2E, если не задан `KEEP_EXTERNAL_API_CONFIG=1`.
- [ ] Redis доступен.
- [ ] Qdrant доступен.
- [ ] Ollama embeddings доступны или тест корректно помечен skipped.
- [ ] Limited reindex проходит без OpenAI.
- [ ] ColBERT `/health` доступен из Gateway/container network.
- [ ] Bounded ColBERT-only dry run `maxPages<=5` проходит без OpenAI и без dense embedding calls.
- [ ] `RUN_OPENSEARCH_E2E=1` включает OpenSearch status/analyze/search-preview только на подготовленном dev-стенде.
- [ ] `RUN_COLBERT_E2E=1` включает ColBERT `/health` и readiness проверки только на подготовленном dev-стенде.

## Opt-in LLM Smoke

- [ ] Перед запуском подтверждено использование платного API.
- [ ] Prompt минимальный.
- [ ] Результат и стоимость/токены, если доступны, зафиксированы.

## GitLab CI / Release Gates

- [ ] GitLab pipeline проходит `validate`, `test`, `typecheck`, `build`.
- [ ] `test` или `validate` выполняет `node scripts/test-wikiai-env-dev.mjs` как быстрый regression gate.
- [ ] `validate:repo` выполняет `node scripts/validate-contracts.mjs`.
- [ ] `docker:build` проходит на GitLab runner с Docker-in-Docker.
- [ ] `security:secret-scan` блокирует реальные ключи и unsafe placeholder defaults в продуктовых файлах.
- [ ] `security:npm-audit` блокирует high vulnerabilities для Gateway и Syncer.
- [ ] Live integration и LiteLLM/OpenAI smoke jobs запускаются только вручную.

## Production Storage Decision

- [ ] Для пилота подтвержден SQLite и прописан backup/restore `state/`.
- [ ] Для production SLA/HA/compliance подтвержден Postgres migration plan или зафиксирован release blocker.
