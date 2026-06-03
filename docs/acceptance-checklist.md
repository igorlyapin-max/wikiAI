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
- [ ] Перед поставкой/сборкой MediaWiki extension выполнен `npm --prefix packages/mw-extension/resources/ai-assistant run build`, и `resources/ai-assistant/dist/index.js` содержит актуальные UI-формулировки.
- [ ] Secrets не отображаются.
- [ ] `Служебная:AI-администрирование?uselang=ru` показывает русские вкладки, кнопки, labels и статусы inline-JS.
- [ ] `Special:AIAdmin?uselang=en` показывает английские вкладки, кнопки, labels и статусы inline-JS.
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
- [ ] `topK` применяется к chat/search context.
- [ ] Chunking параметры передаются в reindex profile.
- [ ] `searchMode=hybrid` смешивает Qdrant vector candidates и SQLite FTS5/BM25 candidates.
- [ ] `vectorWeight`, `lexicalWeight`, `vectorCandidateLimit`, `lexicalCandidateLimit`, `minFinalScore` меняются из Admin UI.
- [ ] Пользовательский AI Search не показывает raw score при `showRawScores=false`.
- [ ] Sources в search/chat используют внешний `MW_PUBLIC_BASE_URL` и не содержат Docker-internal `http://mediawiki`.
- [ ] `searchMode=hybrid` находит `кухня` по запросу `кухню` и не подмешивает нерелевантные vector-only chunks при наличии BM25-кандидатов.
- [ ] После full reindex FTS5 содержит chunks старых страниц, а webhook обновляет FTS5 для измененной страницы.

## Document Recognition

- [ ] MIME policy содержит PDF, изображения и неизвестные типы.
- [ ] Можно добавить custom MIME.
- [ ] Можно отключить MIME.
- [ ] Policy reset возвращает defaults.

## Indexing

- [ ] Создается indexing profile.
- [ ] Reindex запускается по profile.
- [ ] `maxPages=1` работает на тестовом стенде.
- [ ] `dryRun=true` не пишет chunks в Qdrant.
- [ ] Profile chunk size/overlap передаются в Syncer.
- [ ] Search/chat проверяют MediaWiki `readable` для каждого chunk.
- [ ] Закрытая page-level страница в публичном namespace не попадает в AI-ответ.
- [ ] Публичная page-level страница в закрытом namespace может попасть в AI-ответ, если MediaWiki разрешает чтение.
- [ ] Admin docs в `WikiAIAdmin` и legacy `CorpCommon:WikiAI/Администрирование...` не попадают в anonymous search.
- [ ] Admin docs chunks в `wiki_chunks` и `wiki_colbert_chunks` не имеют `allowed_groups:["*"]`.
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

- [ ] Retention config сохраняется.
- [ ] `GET /api/admin/chat-retention/config` возвращает `metadata.redisTtlSeconds`.
- [ ] Default chat retention: `retentionMode=archive`, `activeDays=7`; активные чаты старше 7 дней попадают в `Архив`.
- [ ] Redis TTL соответствует active/archive policy.
- [ ] Export settings не включают secrets.
- [ ] Chat message создает или обновляет SQL session registry.
- [ ] Streaming chat возвращает `conversation` SSE event, и второй вопрос в UI продолжает тот же `conversationId`.
- [ ] Второй вопрос в активном чате использует недавний контекст этой session для RAG retrieval без LLM rewrite и без распознавания специальных фраз.
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
- [ ] В админке `Хранение чатов` кнопка `Открыть` показывает сообщения выбранной session; ручных кнопок `Archive`/`Export JSON` на строке session нет.
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

- [ ] Redis доступен.
- [ ] Qdrant доступен.
- [ ] Ollama embeddings доступны или тест корректно помечен skipped.
- [ ] Limited reindex проходит без OpenAI.

## Opt-in LLM Smoke

- [ ] Перед запуском подтверждено использование платного API.
- [ ] Prompt минимальный.
- [ ] Результат и стоимость/токены, если доступны, зафиксированы.

## GitLab CI / Release Gates

- [ ] GitLab pipeline проходит `validate`, `test`, `typecheck`, `build`.
- [ ] `docker:build` проходит на GitLab runner с Docker-in-Docker.
- [ ] `security:secret-scan` блокирует реальные ключи и unsafe placeholder defaults в продуктовых файлах.
- [ ] `security:npm-audit` блокирует high vulnerabilities для Gateway и Syncer.
- [ ] Live integration и LiteLLM/OpenAI smoke jobs запускаются только вручную.

## Production Storage Decision

- [ ] Для пилота подтвержден SQLite и прописан backup/restore `state/`.
- [ ] Для production SLA/HA/compliance подтвержден Postgres migration plan или зафиксирован release blocker.
