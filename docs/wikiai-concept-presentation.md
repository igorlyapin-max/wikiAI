# WikiAI: концепция презентации продукта

## Рекомендуемый стиль

**Consulting Executive Brief + Engineering Architecture.** Для этой аудитории нужен не маркетинговый рассказ, а понятная управленческая линия: какую проблему закрывает продукт, где именно используется AI, почему сохраняется контроль доступа, как система эксплуатируется и какие решения нужны перед production.

## Главный тезис

WikiAI превращает корпоративную MediaWiki из пассивного хранилища документов в управляемую AI-платформу знаний: сотрудники получают поиск и чат по корпоративному контенту, руководители сохраняют контроль над доступом, качеством источников, стоимостью AI и эксплуатационной готовностью.

## Рабочие допущения

- Продукт почти готов к production, но финальная формулировка должна звучать как "готов к production rollout после закрытия приемочного чек-листа", а не как "production завершен".
- Главный акцент презентации: места использования AI и контролируемость AI, а не глубокая реализация каждого API.
- В одной основной презентации помещаем 20 слайдов. Термины и технические детали можно вынести в приложение.
- Production-readiness нужно показывать честно: health, CI, secret scan и audit log есть; debug/diagnostic levels `Basic`/`Verbose` и multi-sink operational logging по inspected files не подтверждены и должны быть отдельным P0 follow-up перед жестким prod-claim.

## Storyline

1. **Зачем продукт нужен**: корпоративные знания уже есть в MediaWiki, но ими трудно пользоваться быстро, безопасно и с учетом качества источников.
2. **Что меняется с WikiAI**: AI-поиск, AI-чат, прозрачные источники, trust model, semantic facts, администрирование и интеграции.
3. **Где используется AI**: embeddings, RAG, LLM-ответ, conflict detection, semantic autofill, ontology vectors, ColBERT. Отдельно показать, где AI не принимает решение: права доступа, политики, секреты, audit.
4. **Как система работает**: индексация, поиск, чат, runtime ACL-check, админка, external API/MCP.
5. **Почему это управляемо**: self-hosted контур, MediaWiki как источник истины, deny-by-default ACL, LiteLLM как управляемый LLM-шлюз, отключаемые режимы AI.
6. **Что нужно для запуска**: приемка, стабильная SMW-версия/commit, service-user credentials, observability/logging, backup/restore, решение SQLite/Postgres.

## Структура слайдов

### 1. WikiAI: AI-платформа знаний поверх MediaWiki

**Назначение:** открыть презентацию управленческим тезисом.

**Ключевые сообщения:**
- WikiAI - self-hosted AI-поиск и чат-ассистент для корпоративной MediaWiki.
- Система работает с учетом прав чтения пользователя и показывает источники ответа.
- Ценность не в "чат-боте", а в управляемом доступе к корпоративным знаниям.

**Фокус AI:** AI помогает найти и объяснить знания, но не заменяет систему прав MediaWiki.

**Визуал:** титульный слайд с простой схемой: "MediaWiki content -> WikiAI -> сотрудники / эксперты / администраторы / внешние системы".

### 2. Почему текущей wiki недостаточно

**Назначение:** зафиксировать организационную проблему.

**Ключевые сообщения:**
- Документы есть, но пользователи не всегда знают точные названия страниц и категории.
- Обычный keyword search плохо отвечает на вопросы естественным языком.
- Устаревшие, противоречивые и неофициальные материалы могут выглядеть одинаково.
- Закрытые документы нельзя просто отправить в внешний AI-сервис без риска утечки.

**Фокус AI:** AI нужен не ради генерации текста, а чтобы уменьшить время поиска и связать вопрос пользователя с релевантными фрагментами знаний.

**Визуал:** "до/после": слева ручной поиск по wiki, справа вопрос естественным языком с ответом и источниками.

### 3. Что получает организация

**Назначение:** показать управленческую ценность для всей аудитории.

**Ключевые сообщения:**
- Сотрудники быстрее находят регламенты, инструкции, FAQ и внутренние решения.
- Руководители получают контролируемое распространение знаний без обхода прав доступа.
- Эксперты видят источники, trust score, конфликты и кандидаты на обновление.
- Эксплуатация получает health checks, админку, reindex, backup/restore и CI gates.

**Фокус AI:** AI становится интерфейсом к знаниям, а не отдельной неконтролируемой базой.

**Визуал:** матрица "роль -> сценарий -> эффект".

### 4. Где именно используется AI

**Назначение:** сразу сфокусировать презентацию на AI-сценариях.

**Ключевые сообщения:**
- **Embeddings:** текст wiki и запрос пользователя переводятся в векторы для смыслового поиска.
- **RAG:** LLM отвечает только после подбора разрешенных источников.
- **LLM через LiteLLM:** генерация ответа, streaming chat, fallback/routing на уровне LLM-шлюза.
- **Semantic autofill:** AI помогает заполнить семантические поля документа, с контролем режима и чувствительных свойств.
- **Ontology vectors:** свойства Semantic MediaWiki получают embedding-представление для классификации и поиска похожих свойств.
- **ColBERT:** отдельный on-prem neural ranking слой для более точного поиска по токенам.
- **Conflict detection:** отдельный механизм выявления противоречий и низкого доверия к источникам.

**Важно:** ACL, секреты, audit, политики индексации и trust rules не отдаются AI на самостоятельное решение.

**Визуал:** heatmap "функция продукта -> используется AI / не используется AI".

### 5. Пользовательский сценарий: AI Search

**Назначение:** показать основной user-facing workflow.

**Ключевые сообщения:**
- Пользователь задает вопрос естественным языком.
- Gateway проверяет MediaWiki-сессию, получает группы пользователя и ищет только доступные chunks.
- Результаты показывают страницы, фрагменты и ссылки на источники.
- Hybrid search объединяет смысловой поиск, BM25/FTS5 и опциональный ColBERT.

**Фокус AI:** embeddings и neural ranking помогают найти смысловые совпадения, BM25 удерживает точные слова запроса.

**Визуал:** экран/макет "вопрос -> результаты -> источник".

### 6. Пользовательский сценарий: AI Chat

**Назначение:** объяснить чат как продолжение поиска, а не отдельную память без контроля.

**Ключевые сообщения:**
- Каждый вопрос чата заново проходит через RAG и ACL-check.
- Ответ стримится через Server-Sent Events, пользователь видит генерацию постепенно.
- Источники возвращаются вместе с ответом.
- История чатов хранится управляемо: активные, архивные, экспорт собственного архива.

**Фокус AI:** LLM формирует ответ на основе подобранных источников; история диалога не расширяет права доступа.

**Визуал:** sequence diagram "сообщение -> retrieval -> LLM -> streaming answer -> sources".

### 7. RAG простыми словами

**Назначение:** объяснить базовый AI-механизм без перегруза.

**Ключевые сообщения:**
- **Embedding** - числовое представление смысла текста.
- **Vector database** - хранилище таких числовых представлений; в WikiAI это Qdrant.
- **RAG** - сначала найти релевантные источники, потом дать их LLM как контекст для ответа.
- **BM25/FTS5** - классический текстовый поиск по словам; полезен, когда важны точные термины.
- **ColBERT** - более детальный neural search/rerank, который сравнивает запрос и документ на уровне token-level vectors.

**Фокус AI:** generative AI отвечает, retrieval AI и классический поиск подбирают источник.

**Визуал:** три слоя: "текст -> retrieval -> LLM answer".

### 8. Принцип безопасности: права MediaWiki остаются источником истины

**Назначение:** снять ключевой риск ИБ и руководителей.

**Ключевые сообщения:**
- MediaWiki хранит контент, пользователей, сессии и права доступа.
- Gateway аутентифицирует через MediaWiki cookie/API.
- Qdrant хранит chunks с `allowed_groups`, но для сомнительных случаев Gateway делает runtime-readable check через MediaWiki API.
- Модель безопасности conservative: если доступ нельзя подтвердить, документ не показывается.
- Приемлем stale access после изменения группы до истечения сессии/кеша; неприемлема выдача документа пользователю, у которого доступа никогда не было.

**Фокус AI:** AI видит только уже разрешенный контекст; AI не принимает решение о праве чтения.

**Визуал:** "MediaWiki ACL gate" перед Qdrant results и перед LLM context.

### 9. Качество источников: trust model и конфликты

**Назначение:** показать, что продукт управляет надежностью знаний, а не только релевантностью.

**Ключевые сообщения:**
- Trust score рассчитывается по явным правилам: namespace, category, tag, author group, template, page properties, date freshness, SMW facts.
- Администратор настраивает модели доверия, сущности и правила через UI.
- Search/chat фильтруют context по trust policy: drafts, outdated, low-trust и verified sources могут обрабатываться по-разному.
- Conflict detection помогает показать противоречие и рекомендуемый источник.

**Фокус AI:** AI помогает сформулировать ответ и обнаружить конфликт, но правила доверия явные и управляемые.

**Визуал:** шкала trust score и пример "официальный документ vs устаревшая wiki-страница".

### 10. Semantic MediaWiki: переход от текста к структурированным знаниям

**Назначение:** объяснить SMW как усилитель AI, а не отдельную сложность.

**Ключевые сообщения:**
- SMW хранит структурированные факты: департамент, отдел, тип документа, владелец процесса, статус, система, процесс, критичность и другие свойства.
- Syncer индексирует semantic facts вместе с текстовыми chunks.
- Chat добавляет "Свойства документа" в prompt context.
- Диагностический поиск по свойствам работает без LLM.
- ACL semantic facts наследует ACL исходной страницы.

**Фокус AI:** структурированные факты делают ответы точнее, а ontology vectors помогают классифицировать и связывать свойства.

**Визуал:** карточка документа: "текст + свойства + ACL + trust metadata".

### 11. AI-assisted markup и онтологические векторы

**Назначение:** показать advanced AI use case для владельцев контента и экспертов.

**Ключевые сообщения:**
- Администратор задает семантические свойства и генерирует для них ontology vectors через локальные embeddings.
- При сохранении страницы AI может предложить заполнение пустых семантических полей.
- Для чувствительных свойств и автоприменения есть настройки, ограничения и audit.
- Подход снижает ручную разметку, но сохраняет human control и возможность dry-run.

**Фокус AI:** AI предлагает структуру и классификацию, человек или политика подтверждают применение.

**Визуал:** lifecycle "свойство -> vector -> edit page -> AI proposal -> confirm/apply".

### 12. Индексация и переиндексация

**Назначение:** показать, как wiki-контент попадает в AI-контур.

**Ключевые сообщения:**
- MediaWiki extension отправляет webhook при edit/delete/move/protect.
- Syncer получает страницу через MediaWiki API, извлекает текст, semantic facts и вложения по policy.
- Текст разбивается на chunks, получает embeddings и записывается в Qdrant.
- Gateway обновляет BM25/FTS5 и опционально ColBERT index.
- Full reindex нужен для первичной загрузки и восстановления после потерянных событий.

**Фокус AI:** embeddings строятся на этапе индексации; LLM не нужен для обычного reindex.

**Визуал:** pipeline "webhook/full reindex -> fetch page -> chunk -> embed -> Qdrant/FTS/ColBERT".

### 13. Вложения и распознавание документов

**Назначение:** показать, что знания не ограничены текстовыми wiki-страницами.

**Ключевые сообщения:**
- Файлы MediaWiki рассматриваются как страницы `File:`.
- Минимум индексируются метаданные файла.
- PDF/DOCX/XLSX и текстовые форматы могут идти в text extraction.
- Изображения могут идти в OCR; vision model рассматривается как отключаемый будущий слой.
- MIME policy управляет режимами: `text`, `ocr`, `metadata`, `disabled`.

**Фокус AI:** OCR/vision и последующая RAG-обработка расширяют доступ к знаниям, но включаются по политике и с учетом нагрузки.

**Визуал:** таблица MIME-типа и режима обработки.

### 14. Административная платформа

**Назначение:** показать, что продукт управляем изнутри MediaWiki.

**Ключевые сообщения:**
- `Служебная:AI-администрирование` доступна только `sysop`/`aiadmin`.
- Основные вкладки: обзор, сервисы, LLM, embeddings, webhook, RAG/chunking, индексация, document recognition, trust, chat retention, ontology vectors, external API, audit log.
- Secrets не показываются: только `configured: true/false`.
- Safe tests проверяют сервисы без изменения страниц.
- Audit log фиксирует admin mutations.

**Фокус AI:** AI-поведение управляется через настройки: модель, RAG, enrichment, trust, sensitive properties, cost guards.

**Визуал:** схема вкладок админки как control plane.

### 15. Интеграции и границы ответственности

**Назначение:** показать архитектуру понятную CIO/CTO/архитекторам/ИБ.

**Ключевые сообщения:**
- MediaWiki + AD/LDAP: контент, пользователи, группы и права.
- Nginx/reverse proxy: same-origin `/api/*` к Gateway, обычные wiki routes в MediaWiki.
- Gateway: search/chat/admin/external API, ACL runtime checks, prompt/context, streaming.
- Syncer: webhook, reindex, chunks, embeddings, Qdrant payload, semantic facts.
- Qdrant: dense vectors и ColBERT collection.
- Redis: группы пользователя, быстрый runtime cache и chat history cache.
- SQLite/Postgres: admin config, audit log, profiles, trust, chat registry.
- LiteLLM: единый OpenAI-compatible LLM proxy, routing/fallback/rate limits.
- Ollama/vLLM/OpenAI через LiteLLM: embeddings и/или generation по выбранной политике.
- External API/MCP adapter: безопасный слой для сторонних систем через Gateway, без прямого доступа к Qdrant/Redis/MediaWiki.

**Фокус AI:** AI-провайдеры подключаются через управляемый proxy и не становятся источником истины.

**Визуал:** block diagram с границами ответственности и стрелками данных.

### 16. Режимы и вариативность

**Назначение:** показать, что продукт можно адаптировать без переписывания кода.

**Ключевые сообщения:**
- Search mode: `vector_only`, `hybrid`, `colbert_full`, `hybrid_colbert`.
- ColBERT можно выключить, использовать как full index или rerank.
- LLM можно менять через LiteLLM alias без изменения Gateway.
- Semantic facts, attachments, OCR, AI enrichment и autofill имеют включаемые режимы.
- External API поддерживает MediaWiki cookie, OIDC Bearer и ограниченный anonymous search, если включено.
- Storage: SQLite-first для dev/test/pilot, Postgres при SLA, HA, compliance/audit или нескольких инстансах.

**Фокус AI:** AI-возможности включаются дозированно: от локальных embeddings до LLM enrichment и внешних интеграций.

**Визуал:** feature toggles / режимная матрица "режим -> эффект -> риск/ограничение".

### 17. Нелинейные процессы и исключения

**Назначение:** показать зрелость для реальной эксплуатации.

**Ключевые сообщения:**
- Protected namespace reindex блокируется, если нет MediaWiki service-user credentials.
- Если readable check не подтверждает доступ, chunk отбрасывается.
- Если LLM недоступен, система может вернуть деградированный ответ с источниками, если они найдены.
- Если ColBERT недоступен, режим `fallback_current` возвращает текущую hybrid-выдачу; режим `fail_search` делает ошибку явной.
- `dryRun=true` позволяет проверять reindex/trust/autofill без записи.
- OpenAI/LiteLLM smoke tests manual/opt-in, чтобы не тратить платный API автоматически.
- AI autofill не должен создавать бесконечную петлю: service edit определяется и обрабатывается отдельно.

**Фокус AI:** критические ветки имеют fallback, dry-run или явное отключение AI.

**Визуал:** process map с ветками "успех / нет доступа / нет LLM / dry-run / fallback".

### 18. Production readiness: что уже есть и что надо закрыть

**Назначение:** честно показать состояние почти production.

**Ключевые сообщения:**
- Есть Docker compose для Gateway/Syncer/Qdrant/Ollama/ColBERT и локальный override для стенда.
- Есть health endpoints Gateway/Syncer/Qdrant/ColBERT и admin health/status.
- Есть GitLab CI: validate, test, typecheck, build, docker build, secret scan.
- Есть non-root Docker images для Gateway/Syncer и поставочный artifact MediaWiki extension.
- Есть operations runbook, deployment guide, acceptance checklist, backup/restore процедуры.
- Есть audit log админских изменений и redaction secrets в UI/API.
- Необходимо закрыть перед жестким prod-claim: browser acceptance, stable SMW compatibility/commit policy, service-user credentials, npm audit baseline, решение SQLite/Postgres для SLA, debug/diagnostic levels `Basic`/`Verbose`, structured logging через stdout/stderr плюс операционный log sink.

**Фокус AI:** production readiness включает не только качество модели, но и контролируемость, стоимость, диагностику и восстановление.

**Визуал:** readiness table "готово / требует решения / owner".

### 19. Данные, хранение и восстановление

**Назначение:** дать архитекторам и эксплуатации ясную картину stateful-зон.

**Ключевые сообщения:**
- Stateful: MediaWiki DB/uploads, Qdrant collections, Redis runtime/cache/chat, SQLite/Postgres admin DB, ColBERT model cache/index.
- Stateless/replaceable: Gateway, Syncer, MediaWiki extension code artifact, MCP adapter.
- Backup минимум: MediaWiki DB/uploads, Qdrant `wiki_chunks`, ColBERT collection при использовании, admin DB, Redis runtime settings если еще используются.
- Full reindex - рабочий путь восстановления search index, если MediaWiki является источником истины.
- DR/BCP требует определить RPO/RTO, backup frequency, restore drills и поведение при недоступности LLM/Qdrant/MediaWiki.

**Фокус AI:** индексы AI восстановимы из MediaWiki, но operational recovery должен быть проверен до production.

**Визуал:** state map "source of truth / cache / derived index / external dependency".

### 20. Решения для запуска и следующие шаги

**Назначение:** завершить deck decision-ready списком решений.

**Ключевые сообщения:**
- Утвердить production target: pilot, limited rollout или full rollout.
- Зафиксировать LLM policy: локальная LLM, OpenAI через LiteLLM, гибридный режим, бюджет live tests.
- Утвердить ACL/service-user модель для protected namespaces.
- Выбрать storage target: SQLite для pilot или Postgres для SLA/compliance.
- Утвердить observability baseline: diagnostic modes, structured logs, log sink, audit retention.
- Пройти acceptance checklist на стенде и зафиксировать результаты.
- Подготовить короткий demo script: поиск, чат, источники, trust conflict, admin health, reindex dry-run, ontology vector.

**Фокус AI:** финальное решение не "включить AI", а "включить управляемую AI-платформу знаний с понятными границами".

**Визуал:** decision checklist с владельцами и статусами.

## Приложение: термины для простого объяснения

| Термин | Простое объяснение |
| --- | --- |
| RAG | Подход, где система сначала находит источники, а потом просит LLM ответить на их основе. |
| Embedding | Числовое представление смысла текста. Похожие тексты получают похожие векторы. |
| Vector database | База, которая быстро ищет похожие векторы; в WikiAI используется Qdrant. |
| BM25 / FTS5 | Классический поиск по словам и их совпадениям; не является AI. |
| ColBERT | Нейросетевой поиск/rerank, который сравнивает запрос и документ более детально, на уровне токенов. |
| LLM | Большая языковая модель, которая формирует текст ответа. |
| LiteLLM | Прокси-шлюз к LLM: единый API, routing, fallback, rate limiting и аудит на уровне LLM-инфраструктуры. |
| Semantic MediaWiki | Расширение MediaWiki, позволяющее хранить факты как свойства страниц. |
| Ontology vectors | Embedding-представления семантических свойств, чтобы находить близкие свойства и классифицировать фрагменты. |
| Trust score | Настраиваемая оценка надежности источника по явным правилам. |
| Webhook | Событие от MediaWiki в Syncer при изменении страницы. |
| SSE | Server-Sent Events; способ стримить ответ ассистента в браузер. |
| OIDC Bearer | Токен внешней системы/пользователя для доступа к external API. |
| MCP adapter | Адаптер, через который внешние AI-инструменты могут использовать Gateway API без прямого доступа к внутренним базам. |
| Stateless | Сервис не хранит критическое состояние и может быть пересоздан. |
| Stateful | Компонент хранит данные и требует backup/restore. |

## Технические follow-ups вне основной презентации

- Закрыть P0 observability: debug/diagnostic mode без изменения кода, уровни `Basic`/`Verbose`, `Verbose` только временно и с masking, structured logging через stdout/stderr и минимум один operational sink.
- Подтвердить acceptance checklist на живом стенде: UI, админка, ACL, protected docs, hybrid/ColBERT, chat retention, trust, ontology vectors.
- Зафиксировать production-путь SMW для MediaWiki 1.45.x: стабильный релиз или конкретный проверенный commit dev-ветки.
- Определить, когда pilot SQLite переводится на Postgres.
- Зафиксировать LLM cost policy и порядок manual/opt-in smoke tests.
- Подготовить demo data script: разные группы пользователей, закрытые namespace, противоречивые документы, low-trust/draft/outdated источники.
- Подготовить один architecture appendix со схемами: indexing flow, search/chat flow, ACL flow, admin control plane, DR state map.

## Основание из репозитория

- `README.md` - назначение, компоненты, безопасность, быстрый старт, CI.
- `REQUIREMENTS.md` - извлеченная спецификация требований.
- `mediawiki-ai-search-architecture.md` - архитектура AI-поиска и чата.
- `TZ_MediaWiki_AI_Knowledge_Management_v1.2.md` - финальное ТЗ базового продукта.
- `TZ_SMW_AI_Integration_v1.2.md` - финальное ТЗ SMW/ontology vectors.
- `docs/admin-guide.md` - админка, RAG, ColBERT, external API, MCP.
- `docs/admin-platform-roadmap.md` - статус реализованных блоков администрирования.
- `docs/roadmap-ai-smw.md` - rollout SMW и текущий статус стенда.
- `docs/deployment-guide.md` - deployment, LiteLLM/OpenAI, ColBERT, storage.
- `docs/operations-runbook.md` - health checks, protected docs, reindex, backup/restore.
- `docs/acceptance-checklist.md` - приемочные проверки.
- `packages/gateway/src/app.ts`, `packages/gateway/src/routes/*` - Gateway routes: search, chat, admin, external API.
- `packages/syncer/src/server.ts` - webhook/reindex flow.
- `packages/mw-extension/extension.json`, `packages/mw-extension/src/SpecialAIAdmin.php`, `packages/mw-extension/resources/ai-assistant/src/*` - MediaWiki extension, admin UI, user UI.
- `packages/colbert-service/app.py` - ColBERT service.
