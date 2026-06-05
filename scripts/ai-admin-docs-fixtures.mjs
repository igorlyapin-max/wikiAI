export const AI_ADMIN_DOC_HOME = 'WikiAIAdmin:Администрирование';
export const AI_ADMIN_DOC_NAMESPACE = 'WikiAIAdmin';
export const LEGACY_AI_ADMIN_DOC_HOME = 'CorpCommon:WikiAI/Администрирование';

export const MANAGED_DOC_NOTICE = `{| class="wikitable"
! Автоматически управляемая страница
| Эта документация создана WikiAI deployment seed и будет перезаписана при следующем развертывании. Для постоянных локальных заметок создавайте дочерние страницы вне управляемого списка.
|}`;

const pageTitles = {
  start: `${AI_ADMIN_DOC_HOME}/Быстрый старт`,
  overview: `${AI_ADMIN_DOC_HOME}/Обзор и состояние сервисов`,
  serviceHub: `${AI_ADMIN_DOC_HOME}/Сервисы и LLM`,
  services: `${AI_ADMIN_DOC_HOME}/Сервисы`,
  externalApi: `${AI_ADMIN_DOC_HOME}/Внешний API и MCP`,
  llm: `${AI_ADMIN_DOC_HOME}/LLM`,
  embeddings: `${AI_ADMIN_DOC_HOME}/Embeddings`,
  ragHub: `${AI_ADMIN_DOC_HOME}/RAG и индексация`,
  rag: `${AI_ADMIN_DOC_HOME}/RAG и Chunking`,
  indexing: `${AI_ADMIN_DOC_HOME}/Индексация`,
  documents: `${AI_ADMIN_DOC_HOME}/Распознавание документов`,
  trust: `${AI_ADMIN_DOC_HOME}/Модель доверия`,
  chats: `${AI_ADMIN_DOC_HOME}/Хранение чатов`,
  webhook: `${AI_ADMIN_DOC_HOME}/Webhook и переиндексация`,
  ontology: `${AI_ADMIN_DOC_HOME}/Онтологические векторы`,
  audit: `${AI_ADMIN_DOC_HOME}/Логи администрирования`,
  faq: `${AI_ADMIN_DOC_HOME}/FAQ и диагностика`,
};

const legacyPageTitles = Object.fromEntries(
  Object.entries(pageTitles).map(([key, title]) => [
    key,
    title.replace(AI_ADMIN_DOC_HOME, LEGACY_AI_ADMIN_DOC_HOME),
  ])
);

const navigation = [
  ['start', 'Быстрый старт'],
  ['overview', 'Обзор и состояние сервисов'],
  ['serviceHub', 'Сервисы, LLM и Embeddings'],
  ['services', 'Вкладка Сервисы'],
  ['externalApi', 'Внешний API и MCP'],
  ['llm', 'Вкладка LLM'],
  ['embeddings', 'Вкладка Embeddings'],
  ['ragHub', 'RAG и индексация'],
  ['rag', 'Вкладка RAG / Chunking'],
  ['indexing', 'Вкладка Индексация'],
  ['documents', 'Вкладка Распознавание документов'],
  ['trust', 'Вкладка Модель доверия'],
  ['chats', 'Вкладка Хранение чатов'],
  ['webhook', 'Вкладка Webhook'],
  ['ontology', 'Вкладка Онтологические векторы'],
  ['audit', 'Вкладка Логи'],
  ['faq', 'FAQ и диагностика'],
];

export const AI_ADMIN_DOC_PAGES = buildAiAdminDocPages();
export const LEGACY_AI_ADMIN_DOC_PAGES = buildLegacyAiAdminDocPages();

export function buildLegacyAiAdminDocPages() {
  return [
    LEGACY_AI_ADMIN_DOC_HOME,
    ...Object.values(legacyPageTitles),
  ].map((title) => ({
    title,
    text: `${MANAGED_DOC_NOTICE}

= WikiAI admin documentation moved =

Документация AI-администрирования перенесена в защищенный namespace.

Доступ для администраторов: [[${AI_ADMIN_DOC_HOME}]].

Эта legacy-страница оставлена только как безопасная заглушка для апгрейда старых стендов.
`,
  }));
}

export function buildAiAdminDocPages() {
  return [
    managedPage(
      AI_ADMIN_DOC_HOME,
      'AI-администрирование WikiAI',
      `
Центральная страница документации для служебной страницы [[Служебная:AI-администрирование|AI-администрирование]].

== Что это за раздел ==

Если совсем просто: это пульт управления для AI-помощника. Как у игрушечной железной дороги есть пульт со стрелками, скоростью и остановкой, так здесь есть настройки, которые говорят WikiAI:

* где лежит корпоративная вики;
* какой AI-моделью пользоваться;
* какие страницы и документы индексировать;
* каким источникам доверять;
* сколько хранить историю чатов;
* какие события MediaWiki должны запускать переиндексацию.

== Быстрые ссылки ==

${navigation.map(([key, label]) => `* [[${pageTitles[key]}|${label}]]`).join('\n')}

== Какие продукты участвуют ==

* <code>MediaWiki</code> - хранит страницы, пользователей, группы, права и служебную страницу администрирования.
* <code>AIAssistant MediaWiki extension</code> - добавляет чат, поиск, proxy к Gateway и страницу [[Служебная:AI-администрирование]].
* <code>Gateway</code> - Node.js сервис, который принимает запросы из MediaWiki, вызывает LLM, Qdrant, Redis и Syncer.
* <code>Syncer</code> - сервис переиндексации wiki-страниц и вложений.
* <code>Qdrant</code> - векторная база RAG-фрагментов.
* <code>Redis</code> - быстрые runtime-настройки и кэш пользовательских данных.
* <code>SQLite/Postgres</code> - registry для административных настроек, аудита, моделей доверия, чатов и онтологии.
* <code>LiteLLM / OpenAI-compatible endpoint</code> - шлюз к LLM для генерации ответов. На тестовом стенде этот вызов может быть платным.
* <code>Ollama-compatible embeddings</code> - локальный endpoint для embeddings и онтологических векторов по умолчанию.
* <code>Semantic MediaWiki, Page Forms, VEForAll</code> - семантическая разметка, формы и визуальное редактирование корпоративного контента.

== Правило безопасности ==

Ключи API, пароли и токены не показываются в UI. Админка показывает только признак вида <code>apiKeyConfigured=true</code>. Если нужно поменять секрет, меняйте переменную окружения/секрет стенда, а не wiki-страницу.
`
    ),
    managedPage(
      pageTitles.start,
      'Быстрый старт',
      `
== Доступ ==

Страница: [[Служебная:AI-администрирование]].

Доступ должен быть у пользователей с правом <code>aiadmin</code>. На тестовом стенде это право обычно есть у групп <code>sysop</code> и <code>aiadmin</code>.

== Язык интерфейса ==

Интерфейс использует язык пользователя MediaWiki. Для ручной проверки можно добавить <code>uselang</code>:

* русский: <code>Служебная:AI-администрирование?uselang=ru</code>
* английский: <code>Special:AIAdmin?uselang=en</code>

== Минимальная приемка после развертывания ==

# Открыть [[Служебная:AI-администрирование]] под администратором.
# Проверить вкладку [[${pageTitles.overview}|Обзор]]: должны отображаться состояние Syncer, Qdrant и базы настроек.
# Открыть [[${pageTitles.services}|Сервисы]] и убедиться, что секреты не раскрываются.
# Открыть [[${pageTitles.llm}|LLM]], но не запускать LLM test без необходимости: он может вызвать платный OpenAI-compatible endpoint.
# Открыть [[${pageTitles.embeddings}|Embeddings]] и выполнить embedding test, если выбран <code>provider=ollama</code> и Ollama доступна.
# Открыть [[${pageTitles.documents}|Распознавание документов]] и проверить MIME policy.
# Открыть [[${pageTitles.trust}|Модель доверия]] и выполнить preview: он не вызывает LLM.
# Открыть эту документацию по ссылке <code>Справка</code> из админки.

== Самое короткое объяснение ==

Сначала мы раскладываем wiki-страницы на маленькие кусочки. Потом для каждого кусочка строим числовой адрес в Qdrant. Когда пользователь задает вопрос, WikiAI ищет похожие кусочки, проверяет права и доверие, кладет подходящие фрагменты в контекст и только потом просит LLM написать ответ.
`
    ),
    managedPage(
      pageTitles.overview,
      'Обзор и состояние сервисов',
      `
== Что делает пункт меню ==

Вкладка <code>Обзор</code> отвечает на вопрос: "Живы ли основные части системы и понимают ли они друг друга?". Это не место для тонкой настройки. Это приборная панель.

Если совсем просто: как лампочки на роутере. Зеленая лампочка не объясняет весь интернет, но показывает, что кабель и питание в порядке.

== Какие продукты проверяются ==

* <code>Gateway</code> получает запрос от MediaWiki.
* <code>Syncer</code> проверяется через endpoint <code>/health</code>.
* <code>Qdrant</code> проверяется по коллекции и размерности векторов.
* <code>SQLite/Postgres</code> показывается как база административных настроек.
* <code>MediaWiki session</code> нужна, чтобы браузер отправил cookie пользователя и Gateway понял, кто делает действие.

== Что означают поля ==

{| class="wikitable"
! Поле !! Что значит простыми словами !! Нормальное значение
|-
| <code>syncer.status</code> || Syncer отвечает на health-запрос. || <code>ok</code>
|-
| <code>qdrant.status</code> || Qdrant доступен, коллекция найдена, размерность вектора совпадает. || <code>ok</code>
|-
| <code>expectedVectorSize</code> || Какой длины вектор ожидает Gateway. || <code>768</code>
|-
| <code>database.dialect</code> || Где хранятся admin registry и audit. || <code>sqlite</code> на малом стенде или <code>postgres</code> на промышленном
|-
| <code>latencyMs</code> || Сколько миллисекунд заняла проверка. || Чем меньше, тем лучше
|}

== Что делать при ошибке ==

* <code>Missing session cookie</code> - открыть админку именно через MediaWiki URL, например <code>http://127.0.0.1:8082/index.php/Служебная:AI-администрирование</code>.
* <code>Invalid or expired MediaWiki session</code> - обновить страницу, войти заново, не открывать Gateway напрямую.
* <code>Qdrant vector dimension mismatch</code> - проверить embedding model и коллекцию Qdrant: текущий Gateway ожидает размерность <code>768</code>.
* <code>NetworkError</code> - проверить, что запрос идет через same-origin MediaWiki proxy, а не с другой страницы/порта без cookie.
`
    ),
    managedPage(
      pageTitles.serviceHub,
      'Сервисы и LLM',
      `
== Что покрывает этот раздел ==

Этот раздел объединяет три соседние вкладки:

* [[${pageTitles.services}|Сервисы]] - адреса и инфраструктурные подключения.
* [[${pageTitles.externalApi}|Внешний API и MCP]] - REST API для сторонних приложений, OIDC Bearer и MCP adapter.
* [[${pageTitles.llm}|LLM]] - модель генерации ответа и параметры ответа.
* [[${pageTitles.embeddings}|Embeddings]] - модель, которая превращает текст в вектор для поиска.

Если совсем просто: <code>Сервисы</code> говорят "куда звонить", <code>LLM</code> говорит "кто пишет ответ", <code>Embeddings</code> говорит "как найти похожие документы".

== Как настройки применяются ==

Админка хранит override-значения в admin registry. Если override не задан, используется переменная окружения или дефолт из кода. Часть настроек применяется сразу, часть требует перезапуска сервиса или изменения <code>LocalSettings.php</code>.

== Назначение моделей ==

В блоке <code>Назначение моделей</code> администратор видит, какая модель используется для каждой функции:

* <code>Chat answer</code> - LLM пишет ответ пользователю после RAG-поиска.
* <code>Conflict detection</code> - LLM сравнивает найденные источники и ищет противоречия.
* <code>Embeddings</code> - embedding-модель строит вектор запроса, страниц, вложений и ontology vectors.
* <code>Reindex LLM enrichment</code> - LLM может добавлять краткое summary/keywords к странице во время full reindex.

== Платные операции ==

LLM test делает настоящий запрос <code>chat/completions</code> через LiteLLM/OpenAI-compatible API. На тестовом стенде это может стоить денег.

Embedding test зависит от выбранного provider. При <code>provider=ollama</code> он вызывает локальный <code>/api/embeddings</code>. При <code>provider=openai_compatible</code> он вызывает OpenAI-compatible <code>/embeddings</code> через LiteLLM и может быть платным.
`
    ),
    managedPage(
      pageTitles.services,
      'Вкладка Сервисы',
      `
== Что делает пункт меню ==

Вкладка <code>Сервисы</code> показывает и сохраняет адреса основных сервисов. Она нужна, когда стенд переехал, поменялся порт, коллекция Qdrant, URL Syncer или endpoint embeddings.

Если совсем просто: это список телефонных номеров. Если номер Qdrant неправильный, WikiAI не найдет документы. Если номер Syncer неправильный, переиндексация не запустится.

== Настройки по умолчанию ==

{| class="wikitable"
! Настройка !! Значение по умолчанию !! Что означает
|-
| <code>mediaWiki.baseUrl</code> || <code>http://localhost:8082</code> || Базовый URL MediaWiki.
|-
| <code>mediaWiki.apiPath</code> || <code>/api.php</code> || Путь к MediaWiki API.
|-
| <code>gateway.port</code> || <code>3000</code> || Порт Gateway.
|-
| <code>gateway.corsOrigins</code> || dev: <code>localhost/127.0.0.1:5173, 8082</code>; production: пусто || Кто может обращаться к Gateway напрямую из браузера.
|-
| <code>syncer.baseUrl</code> || <code>http://localhost:3001</code> || Адрес Syncer.
|-
| <code>redis.url</code> || <code>redis://localhost:16379/0</code> || Redis для runtime-настроек и кэша.
|-
| <code>database.url</code> || <code>sqlite://./state/wiki-ai.sqlite</code> || База admin registry. Поддерживаются <code>sqlite</code>, <code>postgres</code>, <code>postgresql</code>.
|-
| <code>qdrant.url</code> || <code>http://localhost:6333</code> || Адрес Qdrant.
|-
| <code>qdrant.collection</code> || <code>wiki_chunks</code> || Коллекция RAG-фрагментов.
|-
| <code>llm.baseUrl</code> || задается через <code>LITELLM_BASE_URL</code> || OpenAI-compatible endpoint. Без него Gateway не стартует.
|-
| <code>llm.model</code> || <code>mistral-7b-instruct</code> или <code>LITELLM_MODEL</code> || Модель генерации ответа.
|-
| <code>embeddings.provider</code> || <code>ollama</code> || Какой API использовать для embeddings: локальный Ollama-compatible или OpenAI-compatible.
|-
| <code>embeddings.baseUrl</code> || <code>http://localhost:11434</code> || Endpoint embeddings. Для OpenAI-compatible обычно LiteLLM <code>/v1</code>.
|-
| <code>embeddings.model</code> || <code>nomic-embed-text</code> || Модель embeddings.
|-
| <code>embeddings.dimensions</code> || <code>768</code> || Размерность вектора, совместимая с коллекцией Qdrant.
|}

== Что требует перезапуска ==

Сама админка сохраняет override, но инфраструктурные настройки могут требовать перезапуска контейнера или изменения конфигурации MediaWiki:

* база данных;
* порт Gateway;
* MediaWiki URL/API path;
* Syncer URL в <code>LocalSettings.php</code>;
* Qdrant URL/collection;
* embeddings provider/endpoint/model/dimensions.

== Что нельзя делать ==

Не вставляйте API keys в wiki-страницы и не ждите, что UI покажет секрет. UI показывает только <code>apiKeyConfigured</code> или <code>adminTokenConfigured</code>.
`
    ),
    managedPage(
      pageTitles.externalApi,
      'Внешний API и MCP',
      `
== Что делает пункт меню ==

Вкладка <code>Внешний API</code> управляет стабильными endpoint'ами для сторонних приложений и MCP adapter. Пользовательские чат и поиск внутри MediaWiki остаются на старых маршрутах <code>/api/search</code> и <code>/api/chat</code>; внешние клиенты используют <code>/api/v1/*</code>.

Если совсем просто: это дверь для внешних систем. Встроенная дверь MediaWiki работает по cookie пользователя, а внешняя дверь может работать по OIDC Bearer token.

== Endpoint'ы ==

{| class="wikitable"
! Endpoint !! Для чего нужен
|-
| <code>GET /api/v1/capabilities</code> || Показать, включен ли внешний API, MCP, chat/search, какой auth и max top-k доступны.
|-
| <code>POST /api/v1/search</code> || Поиск по wiki. Поддерживает MediaWiki cookie, OIDC Bearer или anonymous, если это разрешено настройкой.
|-
| <code>POST /api/v1/chat</code> || Чат по wiki. Требует MediaWiki cookie или OIDC Bearer. Anonymous chat не разрешается.
|-
| <code>GET /api/admin/external-api/config</code> || Прочитать настройки администратором.
|-
| <code>POST /api/admin/external-api/config</code> || Сохранить настройки администратором.
|}

== OIDC ==

Для сторонних приложений production-путь - OIDC Bearer. Настройки:

* <code>issuer</code>;
* <code>audience</code>;
* <code>jwksUrl</code>;
* <code>subjectClaim</code>, обычно <code>sub</code>;
* <code>usernameClaim</code>, обычно <code>preferred_username</code>;
* <code>groupsClaim</code>, обычно <code>groups</code>.

Gateway проверяет <code>RS256</code> подпись через JWKS, <code>iss</code>, <code>aud</code>, <code>exp</code> и <code>nbf</code>. Access token не хранится в admin registry и не пишется в audit log.

== ACL mode ==

<code>mediawiki_check</code> - production default. После поиска Gateway спрашивает MediaWiki API, можно ли текущему cookie или Bearer читать исходную страницу. Это самый надежный вариант.

<code>groups_only</code> - явный fallback. Gateway доверяет <code>allowed_groups</code>, которые были записаны в индекс при reindex. Используйте его только если MediaWiki не умеет проверять readable по Bearer для вашего IdP.

== Retrieval profiles ==

Retrieval profile - это готовый режим поиска, который администратор включает для внешних клиентов. Внешняя система не передает флаги BM25, ColBERT, trigram или editDistance напрямую. Она выбирает только <code>retrievalProfileId</code>.

Пример:

<syntaxhighlight lang="json">
{
  "query": "ошибка VPN после смены пароля",
  "topK": 5,
  "retrievalProfileId": "prod_hybrid_colbert"
}
</syntaxhighlight>

<code>GET /api/v1/capabilities</code> возвращает список профилей и их готовность:

* <code>prod_ready</code> - профиль готов для production-сценариев, включая ColBERT.
* <code>limited_ready</code> - профиль можно использовать для ограниченных сценариев, например точный BM25 или широкий semantic search.
* <code>not_ready</code> - профиль требует неготовый индекс или сервис. Если такой профиль явно запрошен, Gateway возвращает <code>409 retrieval_profile_not_ready</code>.

Базовые примеры: <code>prod_hybrid_colbert</code>, <code>lexical_exact</code>, <code>semantic_broad</code>, <code>typo_tolerant_experimental</code>, <code>colbert_full_strict</code>. Они не запускают reindex сами; они только выбирают поведение retrieval по уже построенным индексам.

== MCP adapter ==

MCP adapter не читает Qdrant, Redis, SQLite или MediaWiki напрямую. Он вызывает только Gateway external API:

<syntaxhighlight lang="bash">
WIKIAI_GATEWAY_URL=http://127.0.0.1:3000 \\
WIKIAI_ACCESS_TOKEN=<oidc-access-token> \\
node packages/mcp-adapter/src/server.mjs
</syntaxhighlight>

Для локального embedded-сценария можно передать <code>WIKIAI_COOKIE</code>, но для заказчика основной production-путь - OIDC Bearer.
`
    ),
    managedPage(
      pageTitles.llm,
      'Вкладка LLM',
      `
== Что делает пункт меню ==

Вкладка <code>LLM</code> управляет тем, как AI-помощник пишет ответ после того, как RAG уже нашел документы.

Если совсем просто: RAG приносит ребенку книжки, а LLM читает эти книжки и говорит ответ своими словами. Настройки LLM определяют, насколько длинно, осторожно и быстро она отвечает.

== Какие продукты используются ==

* <code>Gateway</code> собирает system prompt, историю чата и найденные источники.
* <code>LiteLLM / OpenAI-compatible endpoint</code> принимает запрос <code>chat/completions</code>.
* <code>OpenAI API</code> может быть конечным платным провайдером, если LiteLLM настроен на OpenAI.
* <code>MediaWiki</code> дает пользователя, группы и cookie, чтобы не показать источники без прав.

== Настройки по умолчанию ==

{| class="wikitable"
! Настройка !! Дефолт !! Как работает
|-
| <code>provider</code> || <code>openai-compatible</code> || Gateway ожидает API, совместимый с OpenAI chat completions.
|-
| <code>baseUrl</code> || <code>LITELLM_BASE_URL</code> || Адрес LiteLLM/OpenAI-compatible API.
|-
| <code>model</code> || <code>mistral-7b-instruct</code> или <code>LITELLM_MODEL</code> || Имя модели, которое должен знать LiteLLM.
|-
| <code>apiKeyConfigured</code> || true/false || Только признак наличия ключа. Сам ключ не показывается.
|-
| <code>temperature</code> || <code>0.3</code> || 0 - очень строго, 1 - свободнее. Для корпоративной базы обычно 0.2-0.4.
|-
| <code>maxTokens</code> || <code>1024</code> || Максимальная длина ответа. Больше - длиннее, дороже и медленнее.
|-
| <code>timeoutMs</code> || <code>30000</code> || Сколько ждать ответа модели.
|-
| <code>showSources</code> || <code>true</code> || Показывать ссылки на страницы-источники в ответе.
|-
| <code>systemPrompt</code> || корпоративный помощник, отвечать только по документам, честно говорить если ответа нет || Главная инструкция модели.
|}

== Какие значения допустимы ==

* <code>temperature</code>: от <code>0</code> до <code>2</code>.
* <code>maxTokens</code>: от <code>64</code> до <code>4096</code>.
* <code>timeoutMs</code>: от <code>5000</code> до <code>120000</code>.
* <code>systemPrompt</code>: до <code>8000</code> символов.

== Что стоит денег ==

Кнопка LLM test отправляет реальный короткий запрос: system "Reply with OK", user "healthcheck", <code>temperature=0</code>, <code>max_tokens=8</code>. Запрос маленький, но если endpoint идет в OpenAI, он все равно платный.

== Как переключиться на OpenAI ==

OpenAI key не вводится в WikiAI. Он задается в runtime LiteLLM как <code>OPENAI_API_KEY</code>. В WikiAI нужно указать только route alias LiteLLM, например <code>corp-openai-gpt-4.1-mini</code>. Если во вкладке <code>LLM</code> уже сохранена другая модель, это admin override и он важнее переменной <code>LITELLM_MODEL</code>.

Для продуктивной схемы:

* LiteLLM route <code>corp-openai-gpt-4.1-mini</code> ведет в <code>openai/gpt-4.1-mini</code>.
* Gateway использует <code>LITELLM_BASE_URL</code>, <code>LITELLM_API_KEY</code> и <code>LITELLM_MODEL=corp-openai-gpt-4.1-mini</code>.
* Embeddings остаются локальными <code>provider=ollama</code>, пока администратор явно не включит OpenAI-compatible embeddings.

== Как менять безопасно ==

Для тестового стенда сначала меняйте только <code>temperature</code>, <code>maxTokens</code> и <code>showSources</code>. Смену <code>baseUrl</code> и <code>model</code> проверяйте отдельно, потому что неправильная модель даст ошибку генерации ответа.
`
    ),
    managedPage(
      pageTitles.embeddings,
      'Вкладка Embeddings',
      `
== Что делает пункт меню ==

Вкладка <code>Embeddings</code> управляет моделью, которая превращает текст в набор чисел. Qdrant ищет похожие тексты именно по этим числам.

Если совсем просто: похожие фразы получают похожие "координаты". Поэтому вопрос "как оформить отпуск" может найти документ "регламент отсутствий", даже если слова не совпали дословно.

== Какие продукты используются ==

* <code>Ollama-compatible endpoint</code> - принимает <code>/api/embeddings</code>; это локальный дешевый режим по умолчанию.
* <code>OpenAI-compatible endpoint</code> - принимает <code>/embeddings</code>; обычно это LiteLLM <code>/v1</code>, который может маршрутизировать запросы во внешний платный API.
* <code>Gateway</code> вызывает выбранный endpoint для теста и ontology vectors.
* <code>Syncer</code> использует embedding модель при индексации страниц и вложений.
* <code>Qdrant</code> хранит получившиеся векторы.

== Настройки по умолчанию ==

{| class="wikitable"
! Настройка !! Дефолт !! Что означает
|-
| <code>provider</code> || <code>ollama</code> || Gateway считает embeddings локальными/Ollama-compatible.
|-
| <code>baseUrl</code> || <code>http://localhost:11434</code> || Адрес Ollama endpoint.
|-
| <code>model</code> || <code>nomic-embed-text</code> || Модель embedding.
|-
| <code>dimensions</code> || <code>768</code> || Размерность, которую ожидает Gateway для коллекции Qdrant.
|}

== Чем отличаются providers ==

<code>provider=ollama</code> отправляет запрос <code>{ model, prompt }</code> в <code>/api/embeddings</code>. OpenAI API не вызывается.

<code>provider=openai_compatible</code> отправляет запрос <code>{ model, input, dimensions }</code> в <code>/embeddings</code>. Ключ не вводится в UI и берется из runtime-конфигурации Gateway. Если LiteLLM настроен на OpenAI, такой запрос может быть платным.

== Почему нельзя просто поменять модель ==

Если новая embedding model возвращает вектор другой длины, старая коллекция Qdrant станет несовместимой. Тогда поиск может падать или давать плохие результаты. После смены embedding model обычно нужна новая коллекция или полная переиндексация.

== Стоимость ==

Embedding test, ontology vectors, classify-fragment, индексация страниц и вектор запроса используют текущий provider. Чтобы минимизировать стоимость на тестовом стенде, оставляйте <code>provider=ollama</code> для приемки UI и включайте <code>openai_compatible</code> только для короткой проверочной переиндексации с маленьким <code>maxPages</code>.
`
    ),
    managedPage(
      pageTitles.ragHub,
      'RAG и индексация',
      `
== Что покрывает этот раздел ==

RAG и индексация - это две половины одного процесса.

* [[${pageTitles.indexing}|Индексация]] кладет страницы, документы и семантические факты в Qdrant.
* [[${pageTitles.rag}|RAG / Chunking]] управляет тем, как потом искать фрагменты и сколько контекста отдавать LLM.

Если совсем просто: индексация - это разложить книги по полкам и наклеить ярлыки. RAG - это быстро найти нужные книги перед ответом.

== Где чаще всего ошибаются ==

* Делают слишком большой <code>chunkSize</code>: фрагмент становится размытым.
* Делают слишком маленький <code>chunkSize</code>: Qdrant получает слишком много кусочков.
* Ставят большой <code>topK</code>: LLM получает много текста, запрос становится дороже.
* Включают вложения без MIME policy: в индекс попадает шум.
* Отключают <code>dryRun</code> до проверки профиля: можно переиндексировать больше страниц, чем планировалось.
`
    ),
    managedPage(
      pageTitles.rag,
      'Вкладка RAG и Chunking',
      `
== Что делает пункт меню ==

Вкладка <code>RAG / Chunking</code> управляет тем, как текст режется на фрагменты и сколько найденных фрагментов попадет в prompt LLM.

Если совсем просто: нельзя дать ребенку сразу всю библиотеку. Мы даем несколько подходящих страниц. Chunking решает, какого размера эти страницы, а RAG решает, сколько страниц взять.

== Настройки по умолчанию ==

{| class="wikitable"
! Настройка !! Дефолт !! Что означает
|-
| <code>chunkSize</code> || <code>512</code> || Примерный размер одного фрагмента.
|-
| <code>chunkOverlap</code> || <code>50</code> || Сколько текста повторять между соседними фрагментами, чтобы не потерять смысл на границе.
|-
| <code>chunkSeparators</code> || заголовки, пустая строка, строка, точка, пробел || Где лучше резать текст.
|-
| <code>minChunkLength</code> || <code>40</code> || Слишком короткие куски отбрасываются.
|-
| <code>maxChunksPerPage</code> || <code>500</code> || Защита от огромных страниц.
|-
| <code>topK</code> || <code>4</code> || Сколько лучших фрагментов искать.
|-
| <code>maxContextChunks</code> || равно <code>topK</code> || Сколько фрагментов реально положить в контекст.
|-
| <code>maxContextChars</code> || <code>12000</code> || Верхний предел размера текстового контекста.
|-
| <code>chatRetrievalQueryMode</code> || <code>current_message</code> || Как чат строит поисковый запрос: только текущая реплика или текущая реплика плюс последние сообщения истории.
|-
| <code>minSearchScore</code> || <code>0</code> || Минимальная похожесть. 0 означает не отбрасывать по score.
|-
| <code>searchMode</code> || <code>hybrid</code> || Как искать: только vector search или hybrid из vector search + BM25.
|-
| <code>vectorWeight</code> || <code>0.65</code> || Вес смысловой близости Qdrant в итоговом ранжировании.
|-
| <code>lexicalWeight</code> || <code>0.35</code> || Вес точного текстового совпадения BM25.
|-
| <code>vectorCandidateLimit</code> || <code>50</code> || Сколько кандидатов брать из Qdrant до проверки прав и trust.
|-
| <code>lexicalCandidateLimit</code> || <code>50</code> || Сколько кандидатов брать из SQLite FTS5/BM25 до проверки прав и trust.
|-
| <code>lexicalMinMatchedTerms</code> || <code>2</code> || Сколько разных слов запроса должен содержать BM25-кандидат. Однословные запросы требуют одно слово. Для русских окончаний используется короткий нормализованный префикс: <code>древние</code>, <code>Древний</code> и <code>Древняя</code> считаются одним BM25-термом <code>древн</code>.
|-
| <code>lexicalGateMode</code> || <code>when_bm25_available</code> || Если BM25 нашел кандидатов, итоговая выдача строится только из этих chunks; vector score используется как дополнительный вес.
|-
| <code>lexicalNormalizationMode</code> || <code>simple_stem</code> || Базовая эвристика окончаний. <code>raw_prefix</code> оставляет только короткий prefix без снятия окончаний.
|-
| <code>lexicalSynonymsEnabled</code> || <code>false</code> || Experimental query-time синонимы. Формат в UI: <code>тикет=заявка,инцидент</code>. Индекс не меняется.
|-
| <code>lexicalTransliterationEnabled</code> || <code>false</code> || Experimental расширение латиница/кириллица: <code>server</code>/<code>сервер</code>, <code>router</code>/<code>роутер</code>. Индекс не меняется.
|-
| <code>lexicalEditDistanceEnabled</code> || <code>false</code> || Experimental tolerance для коротких опечаток. Gateway добавляет укороченный prefix и проверяет расстояние до 1.
|-
| <code>trigramIndexEnabled</code> || <code>false</code> || Experimental fallback по отдельному trigram index, если BM25 не дал пригодных chunks. Включается только после 100% покрытия trigram index.
|-
| <code>trigramCandidateLimit</code> || <code>50</code> || Сколько trigram-кандидатов брать до ACL/trust.
|-
| <code>trigramMinQueryLength</code> || <code>4</code> || Минимальная длина запроса для trigram fallback.
|-
| <code>vectorOnlyFallbackEnabled</code> || <code>true</code> || Разрешать чистый vector search, когда BM25 не нашел ни одного кандидата.
|-
| <code>vectorOnlyFallbackMinScore</code> || <code>0.78</code> || Минимальная semantic-похожесть для vector-only fallback.
|-
| <code>minFinalScore</code> || <code>0</code> || Минимальный итоговый score после смешивания vector и BM25.
|-
| <code>showRawScores</code> || <code>false</code> || Показывать ли пользователю технический score в AI Search. Обычно выключено.
|-
| <code>rerankMode</code> || <code>none</code> || Совместимый режим дополнительного rerank после текущего hybrid-поиска. <code>hybrid_colbert</code> в <code>searchMode</code> включает то же поведение как основной режим.
|-
| <code>colbertBaseUrl</code> || <code>http://colbert:8080</code> || Адрес on-prem ColBERT service. С хоста тестового стенда обычно <code>http://127.0.0.1:8083</code>.
|-
| <code>colbertModel</code> || <code>antoinelouis/colbert-xm</code> || Имя локальной multilingual ColBERT-модели.
|-
| <code>colbertCollection</code> || <code>wiki_colbert_chunks</code> || Отдельная Qdrant collection для ColBERT token-level vectors.
|-
| <code>colbertCandidateLimit</code> || <code>50</code> || Сколько ColBERT-кандидатов брать до ACL/trust или сколько разрешенных chunks отправлять в rerank.
|-
| <code>colbertTimeoutMs</code> || <code>5000</code> || Timeout запроса к ColBERT.
|-
| <code>colbertMinScore</code> || <code>0</code> || Минимальный score ColBERT для сохранения результата. Production-профиль <code>opensearch_hybrid_colbert</code> использует <code>0.58</code>, чтобы отсекать слабый ColBERT-хвост.
|-
| <code>colbertFailMode</code> || <code>fallback_current</code> || Что делать при ошибке ColBERT: вернуть текущую выдачу или остановить поиск.
|-
| <code>semanticFactsInContext</code> || <code>true</code> || Добавлять SMW-свойства в контекст.
|-
| <code>includeAttachments</code> || <code>false</code> || Включать вложения в RAG-контекст по умолчанию.
|-
| <code>includeSemanticHeader</code> || <code>true</code> || Добавлять краткую шапку с метаданными.
|}

== Допустимые диапазоны ==

* <code>chunkSize</code>: 128-4096.
* <code>chunkOverlap</code>: 0-2048 и строго меньше <code>chunkSize</code>.
* <code>topK</code>: 1-20.
* <code>maxContextChunks</code>: 1-50.
* <code>maxContextChars</code>: 1000-200000.
* <code>minSearchScore</code>: 0-1.
* <code>vectorWeight</code> и <code>lexicalWeight</code>: 0-1, но оба вместе не могут быть 0.
* <code>vectorCandidateLimit</code> и <code>lexicalCandidateLimit</code>: 5-200.
* <code>lexicalMinMatchedTerms</code>: 1-6.
* <code>lexicalGateMode</code>: <code>when_bm25_available</code> или <code>off</code>.
* <code>lexicalNormalizationMode</code>: <code>simple_stem</code> или <code>raw_prefix</code>.
* <code>lexicalSynonyms</code>: до 100 правил, в каждом 1-24 синонима.
* <code>trigramCandidateLimit</code>: 5-200.
* <code>trigramMinQueryLength</code>: 3-32.
* <code>vectorOnlyFallbackMinScore</code>: 0-1.
* <code>minFinalScore</code>: 0-1.
* <code>chatRetrievalQueryMode</code>: <code>current_message</code> или <code>history_augmented</code>. Дефолт <code>current_message</code>: история остается в prompt модели, но не загрязняет подбор источников.
* <code>searchMode</code>: <code>hybrid</code>, <code>vector_only</code>, <code>colbert_full</code> или <code>hybrid_colbert</code>.
* <code>rerankMode</code>: <code>none</code> или <code>colbert_v2</code>.
* <code>colbertCandidateLimit</code>: 5-200.
* <code>colbertTimeoutMs</code>: 500-60000.
* <code>colbertMinScore</code>: 0-1.
* <code>colbertFailMode</code>: <code>fallback_current</code> или <code>fail_search</code>.

== Hybrid search ==

Hybrid search нужен, чтобы не полагаться только на "похожесть по смыслу". Qdrant может считать близкими тексты, которые похожи общим стилем, но не отвечают на вопрос. BM25 проверяет более прямой сигнал: есть ли в документе слова из запроса.

Пример. Пользователь ищет <code>Администрирование систем</code>. Vector search может найти общую статью с высоким score, потому что она похожа по структуре текста. BM25 поднимает страницу, где действительно есть слова <code>администрирование</code> и <code>систем</code>.

По умолчанию включен <code>lexicalGateMode=when_bm25_available</code>. Это значит: если BM25 нашел страницы со словами запроса, semantic-only соседи из Qdrant не попадут в выдачу. Vector score все еще полезен, но только для BM25-кандидатов с тем же chunk id.

Также по умолчанию включен <code>lexicalMinMatchedTerms=2</code>. Это значит: если пользователь ищет несколько слов, страница, где найдено только одно широкое слово вроде <code>система</code>, не считается хорошим BM25-кандидатом. Для однословного запроса требование автоматически становится равным одному слову.

Для русского языка BM25 сравнивает короткие нормализованные префиксы слов. Поэтому запрос <code>древние цивилизации</code> найдет страницы <code>Древний Египет</code> и <code>Древняя Греция</code>: окончания разные, но префиксы <code>древн</code> и <code>цивил</code> совпадают.

Если BM25 ничего не нашел, включается <code>vectorOnlyFallbackEnabled</code>. Тогда Gateway возвращает только vector-кандидатов выше отдельного порога <code>vectorOnlyFallbackMinScore</code>. Это нужно для запросов с синонимами или формулировками, которых нет в тексте буквально.

Если FTS нашел raw BM25-кандидатов, но все они совпали только по одному слишком широкому слову и были отфильтрованы <code>lexicalMinMatchedTerms</code>, vector-only fallback не включается. Это сделано специально: лучше показать пустую или узкую выдачу, чем вернуть случайные semantic-only страницы.

== BM25 совсем просто ==

BM25 - это не AI. Это как искать карточки в коробке по словам.

# Gateway берет запрос пользователя и режет его на слова из букв/цифр длиной от 2 символов.
# Все слова приводятся к нижнему регистру.
# В базовом режиме <code>simple_stem</code> у русских слов снимаются частые окончания: <code>ами</code>, <code>ями</code>, <code>ого</code>, <code>ему</code>, <code>ыми</code>, <code>ими</code>, <code>ий</code>, <code>ый</code>, <code>ой</code>, <code>ая</code>, <code>ое</code>, <code>ее</code>, <code>ые</code>, <code>ие</code>, <code>ую</code>, <code>юю</code>, <code>ым</code>, <code>им</code>, <code>ом</code>, <code>ем</code>, <code>ах</code>, <code>ях</code>, <code>а</code>, <code>я</code>, <code>ы</code>, <code>и</code>, <code>у</code>, <code>ю</code>, <code>е</code>, <code>о</code>.
# Если после снятия окончания осталось меньше 4 символов, слово откатывается к исходному варианту.
# После этого берутся первые 5 символов. Поэтому <code>кухня</code>, <code>кухню</code>, <code>кухней</code> становятся <code>кухн*</code>; <code>администрирование</code> становится <code>админ*</code>.
# SQLite FTS5 ищет chunks по <code>term*</code>. Несколько слов соединяются через <code>OR</code>.
# Gateway проверяет, сколько разных термов реально совпало в найденном chunk. Если меньше <code>lexicalMinMatchedTerms</code>, chunk выкидывается.

Experimental features добавляют термы к поиску:

* <code>synonyms</code>: <code>тикет=заявка,инцидент</code> заставляет запрос <code>тикет</code> искать еще <code>заявк*</code> и <code>инцид*</code>.
* <code>transliteration</code>: <code>сервер</code> ищет еще <code>serve*</code>, а <code>router</code> ищет еще <code>роут*</code>.
* <code>editDistance</code>: для длинного терма добавляется более короткий prefix, а потом Gateway проверяет, что отличие не больше одной правки.
* <code>trigram</code>: если BM25 не дал пригодных chunks, запрос разбивается на кусочки по 3 символа и ищется по отдельному trigram index.

Soundex и rsoundex не используются: для русско-английской корпоративной вики они дают слишком много фонетического шума. Базовый режим остается эвристикой окончаний; experimental-переключатели включаются администратором по одному и проверяются на реальных запросах.

== ColBERT index ==

ColBERT index - это отдельный on-prem late-interaction индекс. Каждый chunk хранится как набор token-level vectors в отдельной Qdrant collection, а запрос сравнивается с ними через MaxSim. Это не Postgres и не замена правам MediaWiki.

Режимы:

* <code>hybrid</code> - текущий Qdrant dense + BM25.
* <code>colbert_full</code> - первый набор кандидатов приходит из ColBERT index.
* <code>hybrid_colbert</code> - текущий hybrid сначала находит кандидатов, затем ColBERT переставляет разрешенные ACL/trust chunks.

Модель по умолчанию: <code>antoinelouis/colbert-xm</code>. Она работает локально и не вызывает OpenAI. Перед production rollout проверьте лицензию модели и внутренние правила использования весов.

Кнопка <code>Тест</code> проверяет <code>/health</code> по текущему Base URL. Кнопка <code>Переиндексировать ColBERT</code> сохраняет RAG-настройки и запускает обычный Syncer reindex без LLM enrichment, чтобы не включать платный OpenAI API.

== Где здесь AI ==

В AI Search LLM не читает запрос и не выбирает документы. AI используется в embedding-модели:

* при индексации Syncer отправляет текст chunk в embedding-модель и получает числовой vector;
* при поиске Gateway отправляет пользовательский запрос в ту же embedding-модель и получает vector запроса;
* Qdrant сравнивает vector запроса с vectors chunks и возвращает ближайшие;
* BM25/FTS5 не использует AI, а ищет совпадения по словам.

Если совсем просто: embedding-модель переводит смысл текста в набор чисел. Qdrant не является AI-моделью; он только считает, какие наборы чисел ближе друг к другу.

Порядок работы:

# В режиме <code>colbert_full</code> Gateway берет кандидатов из ColBERT index и пропускает обычный dense embedding-запрос.
# В режимах <code>hybrid</code> и <code>hybrid_colbert</code> Gateway берет vector-кандидатов из Qdrant.
# Gateway берет lexical-кандидатов из SQLite FTS5.
# Gateway отбрасывает lexical-кандидатов, где найдено меньше <code>lexicalMinMatchedTerms</code> слов запроса.
# Если BM25 нашел кандидатов и включен BM25 gate, Gateway оставляет только lexical-кандидатов и добавляет им vector score при совпадении chunk id.
# Если BM25 не дал пригодных chunks и включен <code>trigramIndexEnabled</code>, Gateway пробует trigram fallback.
# Если FTS вообще не нашел raw BM25-кандидатов, Gateway может использовать vector-only fallback с отдельным высоким порогом.
# Итоговый score считается по весам <code>vectorWeight</code> и <code>lexicalWeight</code>.
# Затем MediaWiki ACL и trust model отбрасывают недоступные или недоверенные chunks.
# Если включен <code>hybrid_colbert</code> или <code>rerankMode=colbert_v2</code>, Gateway отправляет оставшиеся chunks в ColBERT <code>/rerank</code> и применяет новый порядок.

<code>showRawScores=false</code> скрывает score от пользователя. Это правильно: score показывает место chunk в сортировке, но не говорит "ответ надежный". Надежность источника отдельно рассчитывается во вкладке <code>Модель доверия</code>.

SQLite FTS5, trigram index и ColBERT index наполняются Syncer-ом при webhook и reindex через Gateway internal search-index endpoint. После включения hybrid, trigram или ColBERT search старые chunks не появятся в новых индексах сами по себе: нужен один full reindex или отдельный backfill.

Статус BM25-индекса в админке показывает страницы, chunks, FTS chunks и признак необходимости backfill. Статус trigram показывает chunks, FTS chunks и признак необходимости backfill. Если backfill нужен, hybrid search будет чаще уходить в vector-only fallback, а trigram fallback не будет покрывать старые chunks. Переключатель <code>trigramIndexEnabled</code> остается заблокированным, пока <code>trigramPopulated=false</code>.

Если нужно заполнить BM25 без повторного построения embeddings, можно использовать backfill из существующего Qdrant payload:

<syntaxhighlight lang="bash">
QDRANT_URL=http://127.0.0.1:6333 \\
GATEWAY_BASE_URL=http://127.0.0.1:3000 \\
node scripts/backfill-search-index-from-qdrant.mjs
</syntaxhighlight>

Trigram backfill не строит embeddings и не вызывает LLM. Он запускается как async job и пересобирает 3-граммы из уже сохраненных <code>ai_search_chunks</code>:

<syntaxhighlight lang="bash">
curl -s -X POST http://127.0.0.1:3000/api/admin/search-index/trigram/backfill \\
  -H 'Cookie: <admin-mediawiki-cookie>'
</syntaxhighlight>

API сразу возвращает <code>202 Accepted</code> и статус job. Ход выполнения читается отдельно:

<syntaxhighlight lang="bash">
curl -s http://127.0.0.1:3000/api/admin/search-index/trigram/backfill/status \\
  -H 'Cookie: <admin-mediawiki-cookie>'
</syntaxhighlight>

Если backfill мешает staging или обслуживанию, его можно остановить:

<syntaxhighlight lang="bash">
curl -s -X POST http://127.0.0.1:3000/api/admin/search-index/trigram/backfill/cancel \\
  -H 'Cookie: <admin-mediawiki-cookie>'
</syntaxhighlight>

Готовность считается строгой: <code>chunks &gt; 0</code>, <code>trigramChunks &gt;= chunks</code> и <code>trigramFtsChunks &gt;= chunks</code>. До этого <code>POST /api/admin/rag/config</code> с <code>trigramIndexEnabled=true</code> возвращает ошибку <code>trigram_index_not_ready</code>.

Стоимость trigram - дополнительное SQLite-хранилище и FTS-запросы. Для каждого слова длиной <code>N</code> создается <code>N-2</code> коротких термов. Это не добавляет embedding calls, OpenAI calls или ColBERT reindex, но требует disk I/O и backfill на уже проиндексированном корпусе.

Для staging-проверки используйте benchmark. Он может сам запустить backfill, дождаться завершения, сравнить размер SQLite до/после и прогнать контрольные запросы:

<syntaxhighlight lang="bash">
DATABASE_URL=sqlite://./state/admin.db \\
WIKIAI_ADMIN_COOKIE='<admin-mediawiki-cookie>' \\
node scripts/benchmark-trigram-readiness.mjs \\
  --base-url http://127.0.0.1:3000 \\
  --queries ./trigram-queries.txt \\
  --start-backfill \\
  --poll-ms 1000 \\
  --p95-threshold-ms 200
</syntaxhighlight>

Скрипт печатает JSON с <code>readiness.passed</code>, <code>readiness.reasons</code>, покрытием индекса, статусом job, размером БД и p50/p95/p99 latency. Нормальный критерий для включения в production: <code>readiness.passed=true</code>, backfill <code>completed</code>, покрытие 100%, <code>failed=0</code>, p95 trigram stage не выше 200 мс на representative queries.

Метрики Gateway в <code>/metrics</code>:

* <code>wikiai_search_trigram_queries_total{result}</code> - сколько trigram-поисков завершилось <code>hit</code>, <code>filtered</code>, <code>miss</code>, <code>skipped</code> или <code>error</code>.
* <code>wikiai_search_trigram_last_latency_ms</code> - latency последнего trigram stage.
* <code>wikiai_search_trigram_raw_candidates_total</code> - суммарные raw candidates из trigram.
* <code>wikiai_trigram_backfill_jobs_total{status}</code> - счетчик backfill jobs по статусам.
* <code>wikiai_trigram_backfill_progress_chunks</code> - последний processed chunk count.

BM25/ColBERT backfill и trigram backfill не вызывают LLM/OpenAI и не строят embeddings: BM25/ColBERT читает payload chunks из Qdrant, а trigram читает уже сохраненные <code>ai_search_chunks</code>.

== Как влияет на стоимость ==

Больше <code>topK</code>, <code>maxContextChunks</code> и <code>maxContextChars</code> - больше текста уходит в LLM prompt. Если LLM endpoint платный, это увеличивает стоимость. Для тестов начинайте с <code>topK=3</code> или <code>4</code>.
`
    ),
    managedPage(
      pageTitles.indexing,
      'Вкладка Индексация',
      `
== Что делает пункт меню ==

Вкладка <code>Индексация</code> описывает, какие страницы попадут в RAG-базу, с какими правами, метаданными и режимом запуска.

Если совсем просто: это инструкция грузчику. "Возьми страницы из этих шкафов, не трогай эти папки, подпиши ярлыки, вложения бери или не бери".

== Профиль по умолчанию ==

{| class="wikitable"
! Поле !! Дефолт !! Что означает
|-
| <code>id</code> || <code>default</code> || Техническое имя профиля.
|-
| <code>name</code> || <code>Default env profile</code> || Человекочитаемое имя.
|-
| <code>enabled</code> || <code>true</code> || Профиль можно запускать.
|-
| <code>namespaces</code> || <code>[0]</code> || Индексируется основной namespace.
|-
| <code>smwProperties</code> || берется из онтологии || Совместимое поле профиля. Основной выбор делается во вкладке "Онтологические векторы" флагом <code>indexed</code>.
|-
| <code>titleFilters</code> || пусто || Фильтры по названию страницы.
|-
| <code>categoryFilters</code> || пусто || Фильтры по категориям.
|-
| <code>documentPolicyId</code> || <code>default</code> || Какая MIME policy применяется к вложениям.
|-
| <code>runMode</code> || <code>manual</code> || Запуск вручную, не по расписанию.
|-
| <code>attachmentsEnabled</code> || <code>false</code> || Вложения не индексируются профилем по умолчанию.
|-
| <code>semanticFactsEnabled</code> || <code>true</code> || SMW-факты добавляются.
|-
| <code>ontologyVectorsEnabled</code> || <code>false</code> || Онтологические векторы не включены в default profile.
|-
| <code>dryRunDefault</code> || <code>false</code> || По умолчанию запуск пишет данные, если оператор не включил dry run.
|-
| <code>maxPagesDefault</code> || пусто || Лимит не задан: ручной reindex берет все страницы, подходящие под profile, namespace и фильтры.
|}

== Счетчики переиндексации ==

Статус reindex показывает разные величины:

* <code>найдено страниц</code> - сколько страниц подошло под profile до лимита.
* <code>в обработке</code> - сколько страниц реально поставлено в job после <code>maxPages</code>.
* <code>обработано страниц</code> - сколько страниц записано или было бы записано в dry run.
* <code>пропущено</code> - пустые или недоступные страницы.
* <code>фрагментов RAG</code> - сколько chunks получилось после разбиения текста. Это не количество страниц.
* <code>embedding calls</code> - сколько embedding-вызовов сделано при записи.
* <code>LLM enrichment</code> - сколько страниц было обогащено через LLM.
* <code>estimated paid calls</code> - оценка потенциально платных вызовов, если embeddings или enrichment идут через OpenAI-compatible endpoint.

Пустой <code>maxPages</code> означает "без лимита". Маленький <code>maxPages</code> используйте только для пробного запуска.

== LLM-обогащение при reindex ==

Флажок <code>Включить LLM-обогащение reindex</code> по умолчанию выключен. Если включить его и запускать не <code>dryRun</code>, Syncer один раз на страницу вызывает Gateway internal endpoint <code>/api/internal/reindex/llm-enrich</code>. Gateway делает короткий <code>chat/completions</code> запрос через LiteLLM и возвращает <code>summary</code> и <code>keywords</code>. Они сохраняются в chunk payload как <code>ai_summary</code>, <code>ai_keywords</code> и <code>ai_enrichment_model</code>.

Зачем это нужно: если страница плохо структурирована, краткое summary и ключевые слова могут помочь векторному поиску. Почему это выключено по умолчанию: это один LLM-вызов на каждую обработанную страницу и он может стоить денег.

Для дешевой приемки используйте <code>dryRun=true</code> и маленький <code>maxPages</code>. Dry-run показывает оценку, но не вызывает LLM и не пишет Qdrant.

== Фильтры страниц ==

Фильтры страниц отвечают на вопрос "какие страницы вообще брать в индекс?". Это не права доступа и не замена прав чтения MediaWiki.

* <code>Включать страницы по названию</code> - список фрагментов названия через запятую. Если поле заполнено, Syncer берет только страницы, где есть хотя бы один фрагмент. Пример: <code>CorpIT:,Регламент</code>.
* <code>Исключать страницы по названию</code> - список фрагментов, по которым страницы надо пропустить. Пример: <code>Черновик,Архив</code>. Исключение сильнее включения.
* <code>Включать страницы из категорий</code> - выбор MediaWiki-категорий из видимого списка "Доступные категории MediaWiki". Страница относится к категории, если в ней есть <code>[[Категория:ИТ]]</code> или <code>[[Category:IT]]</code>.
* <code>Исключать страницы из категорий</code> - категории, которые нужно убрать из индексации. Исключение сильнее включения.

Категории сравниваются точным совпадением по имени: <code>ИТ</code> совпадает с <code>Категория:ИТ</code>, но не совпадает с <code>Категория:Аудит</code>. Названия страниц сравниваются иначе: как поиск фрагмента без учета регистра.

Если совсем просто: категории - это уже существующие ярлыки MediaWiki. Администратор выбирает их из списка, чтобы не угадывать название руками и не получить случайное совпадение.

== Что решает доступ ==

Фильтры индексации не являются правами доступа. Финальное решение принимает MediaWiki. Перед тем как chunk попадет в ответ или prompt LLM, Gateway спрашивает MediaWiki API: "текущий пользователь может читать исходную страницу?". Если MediaWiki отвечает "нет", chunk отбрасывается.

Итог: администратор поддерживает права чтения в MediaWiki. В профиле индексации нужно выбирать область индексации, а не переносить матрицу групп.

== Как тестировать дешево ==

Для приемки профиля используйте <code>dryRun=true</code> и маленький <code>maxPages</code>. Это проверяет маршрут и выборку страниц без массовой записи в Qdrant.
`
    ),
    managedPage(
      pageTitles.documents,
      'Вкладка Распознавание документов',
      `
== Что делает пункт меню ==

Вкладка <code>Распознавание документов</code> решает, что делать с файлами-вложениями: читать текст, запускать OCR, брать только метаданные или не индексировать.

Если совсем просто: если файл - это книга, можно прочитать ее текст. Если файл - картинка с текстом, нужен OCR как "глаза". Если файл сложный или дорогой, можно записать только обложку: имя файла, страницу, описание.

== Настройки по умолчанию ==

{| class="wikitable"
! MIME type !! Дефолтный режим !! Что происходит
|-
| <code>application/pdf</code> || <code>text</code> || Извлекается текст PDF.
|-
| <code>text/plain</code> || <code>text</code> || Извлекается текст.
|-
| <code>image/png</code> || <code>ocr</code>, <code>eng+rus</code> || Запускается OCR для русского и английского.
|-
| <code>image/jpeg</code> || <code>ocr</code>, <code>eng+rus</code> || Запускается OCR для русского и английского.
|-
| <code>image/jpg</code> || <code>ocr</code>, <code>eng+rus</code> || Запускается OCR для русского и английского.
|-
| <code>image/webp</code> || <code>ocr</code>, <code>eng+rus</code> || Запускается OCR для русского и английского.
|-
| <code>application/vnd.openxmlformats-officedocument.wordprocessingml.document</code> || <code>metadata</code> || DOCX индексируется только по метаданным.
|-
| неизвестный MIME type || <code>metadata</code> || Без отдельного правила берутся только метаданные.
|}

== Какие режимы бывают ==

* <code>text</code> - извлечь текст и положить его в индекс.
* <code>ocr</code> - распознать текст на изображении; можно указать <code>ocrLanguages</code>.
* <code>metadata</code> - индексировать только имя файла, страницу, описание, MIME type.
* <code>disabled</code> - полностью исключить такой тип файла.

== Что означает <code>maxBytes</code> ==

Это верхний размер файла для обработки. Большие файлы могут быть медленными и дорогими для OCR. Если сомневаетесь, ставьте ограничение и смотрите audit.

== Как экономить ==

Не включайте OCR для всех типов. Начните с изображений, которые реально нужны пользователям. Для DOCX на текущем стенде по умолчанию выбран <code>metadata</code>, чтобы не обещать полноценное извлечение текста там, где оно еще не подтверждено.
`
    ),
    managedPage(
      pageTitles.trust,
      'Вкладка Модель доверия',
      `
== Что делает пункт меню ==

Модель доверия решает, можно ли использовать страницу как источник для ответа. Она не говорит, "страница хорошая или плохая" вообще. Она говорит: "достаточно ли этой странице доверять для RAG-контекста и прямого ответа".

Если совсем просто: учитель разрешает брать сведения из учебника, но не из черновика на полях тетради.

== Модель по умолчанию ==

{| class="wikitable"
! Поле !! Дефолт !! Что означает
|-
| <code>id</code> || <code>default</code> || Техническое имя модели.
|-
| <code>name</code> || <code>Default trust model</code> || Название модели.
|-
| <code>active</code> || <code>true</code> || Эта модель используется.
|-
| <code>baseScore</code> || <code>0.7</code> || Начальный балл доверия каждой страницы.
|-
| <code>minTrustScoreForContext</code> || <code>0.4</code> || Ниже этого балла страницу не кладем в RAG-контекст.
|-
| <code>includeDrafts</code> || <code>false</code> || Черновики не включаются.
|-
| <code>stalenessPenaltyPerYear</code> || <code>0.1</code> || За каждый полный год с последнего редактирования score уменьшается на 0.1.
|-
| <code>requireVerifiedForDirectAnswer</code> || <code>true</code> || Для прямого ответа нужны достаточно доверенные источники.
|-
| <code>requireSources</code> || <code>true</code> || Ответ должен быть со ссылками на источники.
|}

== Как работает устаревание ==

Syncer берет дату последней ревизии страницы MediaWiki и кладет ее в RAG payload как <code>last_modified</code>. Gateway не пытается угадать "устарела страница или нет" по слову в статусе. Он делает простую арифметику:

* смотрит, сколько полных лет прошло с <code>last_modified</code>;
* умножает это число на <code>stalenessPenaltyPerYear</code>;
* вычитает результат из score.

Пример. У страницы <code>baseScore=0.7</code>, последнее редактирование было 3 полных года назад, настройка <code>stalenessPenaltyPerYear=0.1</code>. Штраф будет <code>0.3</code>, итоговый score без других правил: <code>0.4</code>. Если порог <code>minTrustScoreForContext=0.4</code>, такой документ еще можно положить в RAG-контекст. Если порог <code>0.5</code>, уже нельзя.

После изменения этой логики нужен полный reindex, чтобы у старых chunks появился настоящий <code>last_modified</code> из MediaWiki. Новые изменения страниц через webhook обновляют эту дату автоматически.

== Пересчет trust payload в Qdrant ==

Пересчет trust payload применяет текущую модель доверия к chunks, которые уже лежат в Qdrant. Он обновляет только trust-поля payload: <code>trust_score</code>, <code>trust_flags</code>, <code>applied_rules</code>, <code>applied_entities</code>, <code>trust_model_id</code>, решения <code>trust_*</code> и <code>trust_calculated_at</code>.

Если совсем просто: документы уже лежат на полке, а пересчет заново наклеивает на них ярлыки доверия. Он не переписывает сами документы.

Пересчет не делает reindex, не строит embeddings, не вызывает LLM/OpenAI и не ходит в MediaWiki за свежими атрибутами страницы. Поэтому он не должен тратить деньги на OpenAI API.

Когда пересчет полезен:

* администратор изменил модель доверия, правила, пороги, флаги или <code>stalenessPenaltyPerYear</code>;
* нужно пересчитать устаревание по уже сохраненному <code>last_modified</code>;
* после reindex или webhook нужно записать новые trust-поля в payload.

Если у страницы изменились категории, SMW-свойства, шаблоны, namespace или дата ревизии, сначала эти данные должны попасть в Qdrant через webhook или reindex. После этого trust recalculation применит текущую модель доверия к обновленному payload.

Для обычных webhook <code>edit</code>, <code>move</code> и <code>protect</code> Syncer запускает точечный пересчет по <code>pageId</code>. Полный ручной пересчет нужен в основном после изменения самой модели доверия или политики устаревания.

В режиме <code>dryRun=true</code> Gateway только показывает расчет и не пишет payload. В режиме <code>dryRun=false</code> Gateway записывает trust-поля в Qdrant.

== Правила доверия ==

Правило доверия - это одна строка в таблице: "если поле равно/содержит/существует/старше N дней, то измени score, поставь флаги или включи ограничение".

Если совсем просто: правило похоже на наклейку на документ. Например, "если статус Утвержден, добавь доверия", "если документ старше 730 дней, снизь доверие", "если категория Черновик, не используй для ответа".

Операторы:

* <code>equals</code>
* <code>contains</code>
* <code>starts_with</code>
* <code>exists</code>
* <code>older_than_days</code>
* <code>newer_than_days</code>

Правило может менять score через <code>modifier</code> и ставить флаги:

* <code>excludeFromIndex</code> - не индексировать.
* <code>requireManualApproval</code> - требуется ручное подтверждение.
* <code>notifyAuthor</code> - нужно уведомить автора.

В интерфейсе правила показаны одной таблицей. Клик по строке правила заполняет форму редактирования, столбцы можно сортировать. Кнопка <code>Удалить</code> у обычного правила удаляет только это правило.

В интерфейсе больше нет отдельного блока "сначала признак, потом правила". Есть одна таблица <code>Правила доверия</code>. Клик по строке заполняет форму ниже. Кнопка <code>Добавить правило</code> очищает форму, <code>Сохранить правило</code> сохраняет обычное правило без выбора признака.

Старые записи признаков, если они уже есть в базе, показываются в этой же таблице с источником <code>Старый признак</code>. Если такую строку сохранить, админка превратит ее в обычное правило и сохранит старые вложенные правила как обычные правила. Если старый признак удалить, будут удалены сам признак и его старые вложенные правила; перед удалением будет подтверждение с количеством связанных правил.

Форма правила меняется по полю <code>Что проверяем</code>:

* <code>namespace</code> - проверяем числовой id namespace; значение выбирается из полного списка MediaWiki namespaces и показывается как <code>id - имя</code>, например <code>3030 - CorpHR</code>. В payload правила сохраняется id, например <code>3030</code>.
* <code>title</code> - проверяем заголовок страницы; подсказки берутся из поиска страниц MediaWiki.
* <code>category</code> - проверяем категорию страницы; значение выбирается из категорий MediaWiki.
* <code>tag</code> - проверяем тег страницы; значение выбирается из тегов MediaWiki. Админка показывает техническое имя тега, а не HTML displayname.
* <code>author_group</code> - проверяем группу автора; значение выбирается из MediaWiki user groups.
* <code>template</code> - проверяем шаблон страницы; значение выбирается из списка шаблонов MediaWiki без префикса <code>Шаблон:</code>.
* <code>property</code> - проверяем свойство страницы или SMW-свойство. Имя свойства выбирается из онтологии, а значения подсказываются из уже проиндексированного <code>semantic_facts</code> payload в Qdrant. Если свойство новое или еще не индексировалось, поле значения остается ручным вводом.
* <code>status</code> - короткий вариант для статуса документа; по умолчанию используется свойство <code>Статус документа</code>.
* <code>date_property</code> - проверяем дату в свойстве, обычно вместе с операторами <code>older_than_days</code> или <code>newer_than_days</code>.

Флаги результата - это короткие метки, которые правило добавляет к найденному источнику: например <code>verified</code>, <code>official</code>, <code>outdated</code>, <code>manual-review</code>. Это не права доступа и не категории. Они попадают в <code>trust_flags</code> и помогают объяснить, почему источник был выбран, понижен или требует ручной проверки.

Preview использует те же справочники: namespace выбирается из списка, title получает подсказки страниц, а категории, теги, группы автора и шаблоны добавляются chips-списками. Для правил доверия значения свойств подсказываются из Qdrant semantic diagnostics, поэтому список появится после индексации страниц с этими свойствами. Это удобнее и безопаснее ручного CSV-ввода.

== Почему нет выбора модели в каждом блоке ==

Вкладка работает с одной активной моделью доверия. Поэтому в блоках правил, preview и пересчета нет отдельных выпадающих списков "Модель". Так меньше шансов случайно отредактировать правило в одной модели, а проверять preview по другой.

== Проверка противоречий ==

Этот блок находится во вкладке <code>Модель доверия</code>, потому что проверка запускается после безопасности и доверия:

# MediaWiki говорит, какие страницы пользователь может читать.
# Trust model убирает черновики и низкодоверенные chunks из RAG-контекста.
# Проверка противоречий сравнивает оставшиеся источники через отдельный LLM-запрос.

Если совсем просто: сначала ребенку дают только разрешенные книжки, потом убирают сомнительные листочки, а потом взрослый проверяет, не говорят ли две книжки разные вещи.

Если конфликт найден, чат показывает блок про возможные противоречия. Если конфликта нет, но уверенность детектора низкая, чат показывает отдельное предупреждение о необходимости проверки источников. Это не запрещает ответ, но заставляет ассистента не выдавать спорные или слабоподтвержденные сведения как однозначные.

{| class="wikitable"
! Поле !! Дефолт !! Что означает
|-
| <code>enabled</code> || <code>true</code> || Включает автоматическую проверку в чате.
|-
| <code>runMode</code> || <code>risk_only</code> || Проверять только когда в контекст попали минимум два источника и есть сигнал риска: низкий trust, маленькая разница trust score или отсутствующие trust scores. <code>manual</code> оставляет только ручной тест, <code>always</code> проверяет каждый чат с двумя и более источниками.
|-
| <code>model</code> || текущая LLM-модель || Какая LiteLLM/OpenAI-compatible модель ищет противоречия.
|-
| <code>maxSources</code> || <code>5</code> || Сколько источников максимум отправлять анализатору.
|-
| <code>maxCharsPerSource</code> || <code>2000</code> || Сколько символов брать из каждого источника. Меньше - дешевле, но можно потерять контекст.
|-
| <code>trustGapThreshold</code> || <code>0.15</code> || Если trust score у источников почти одинаковый, системе сложнее выбрать приоритетный источник.
|-
| <code>lowConfidenceThreshold</code> || <code>0.7</code> || Ниже этого confidence предупреждение считается обязательным.
|-
| <code>showConflictBlock</code> || <code>true</code> || Показывать warning block пользователю в чате.
|}

Кнопка <code>Тест проверки противоречий</code> делает настоящий LLM-запрос на коротком встроенном примере про VPN/MFA. На тестовом стенде это может стоить денег, поэтому этот тест не должен запускаться автоматически без явного решения администратора.

== Recalculation ==

Автопересчет доверия по умолчанию выключен:

{| class="wikitable"
! Поле !! Дефолт
|-
| <code>enabled</code> || <code>false</code>
|-
| <code>intervalMinutes</code> || <code>1440</code>
|-
| <code>maxScan</code> || <code>1000</code>
|-
| <code>batchSize</code> || <code>128</code>
|}

Preview не вызывает LLM/OpenAI. Он считает score локально по тестовым метаданным. Это самый дешевый и безопасный способ проверить модель.
`
    ),
    managedPage(
      pageTitles.chats,
      'Вкладка Хранение чатов',
      `
== Что делает пункт меню ==

Вкладка <code>Хранение чатов</code> управляет тем, как долго хранится история диалогов, что делать со старыми чатами и какие данные включать в экспорт.

Если совсем просто: чат - это тетрадка с разговором. Настройки говорят, когда тетрадку выбросить, когда убрать в архив, а когда сначала сделать копию.

== Настройки по умолчанию ==

{| class="wikitable"
! Настройка !! Дефолт !! Что означает
|-
| <code>retentionMode</code> || <code>auto_delete</code> || Старые чаты удаляются автоматически.
|-
| <code>activeDays</code> || <code>30</code> || Сколько дней чат считается активным.
|-
| <code>recentDays</code> || <code>7</code> || Что считается недавней историей.
|-
| <code>archiveDays</code> || <code>365</code> || Сколько хранить архив, если выбран архивный режим.
|-
| <code>maxPinnedChats</code> || <code>20</code> || Сколько закрепленных чатов разрешено.
|-
| <code>maxActiveChats</code> || <code>200</code> || Лимит активных чатов.
|-
| <code>maxTotalChats</code> || <code>1000</code> || Общий лимит чатов.
|-
| <code>onLimitExceeded</code> || <code>delete_oldest</code> || При превышении лимита удалять самый старый.
|-
| <code>exportOptions.formats</code> || <code>json</code> || Формат экспорта.
|-
| <code>includeMetadata</code> || <code>true</code> || Включать метаданные.
|-
| <code>includeSources</code> || <code>true</code> || Включать источники.
|-
| <code>includeMessages</code> || <code>true</code> || Включать сообщения.
|}

== Режимы хранения ==

* <code>auto_delete</code> - удалить по сроку <code>activeDays</code>.
* <code>archive</code> - переносить в архив и хранить до <code>archiveDays</code>.
* <code>export_then_archive</code> - сначала экспортировать, потом архивировать.

== Лимиты и валидация ==

* <code>recentDays</code> не может быть больше <code>activeDays</code>.
* <code>archiveDays</code> не может быть меньше <code>activeDays</code>.
* <code>maxActiveChats</code> не может быть больше <code>maxTotalChats</code>.

Этот блок не вызывает LLM/OpenAI.
`
    ),
    managedPage(
      pageTitles.webhook,
      'Вкладка Webhook',
      `
== Что делает пункт меню ==

Вкладка <code>Webhook</code> управляет событиями MediaWiki, которые должны сообщать Syncer: "страница изменилась, нужно переиндексировать".

Если совсем просто: когда ребенок исправил страницу в тетради, он звонит библиотекарю и говорит "обнови карточку".

== Какие события включены по умолчанию ==

{| class="wikitable"
! Событие !! Дефолт !! Что означает
|-
| <code>edit</code> || <code>true</code> || Страница отредактирована.
|-
| <code>delete</code> || <code>true</code> || Страница удалена.
|-
| <code>move</code> || <code>true</code> || Страница переименована/перемещена.
|-
| <code>protect</code> || <code>true</code> || Изменились права/защита страницы.
|}

== Остальные настройки ==

{| class="wikitable"
! Настройка !! Дефолт !! Что означает
|-
| <code>syncerUrl</code> || <code>http://localhost:3001</code> || Куда отправлять webhook.
|-
| <code>timeoutMs</code> || <code>3000</code> || Сколько ждать ответ Syncer.
|-
| <code>retryCount</code> || <code>0</code> || Сколько повторов делать после ошибки.
|-
| <code>retryBackoffMs</code> || <code>1000</code> || Пауза между повторами, если они включены.
|}

== Важное ограничение ==

Сохранение Gateway config не меняет автоматически <code>$wgAIAssistantSyncerUrl</code> в <code>LocalSettings.php</code>. Вкладка показывает фактический MediaWiki URL и ожидаемый Gateway URL, чтобы администратор видел расхождение.

== Safe test ==

Webhook test проверяет health Syncer. Он не должен создавать, менять или удалять wiki-страницы.
`
    ),
    managedPage(
      pageTitles.ontology,
      'Вкладка Онтологические векторы',
      `
== Что делает пункт меню ==

Онтологические векторы описывают Semantic MediaWiki свойства так, чтобы AI-слой понимал, какие поля важны для индексации и классификации.

Если совсем просто: есть ярлык "Департамент", но компьютеру нужно объяснить, что это не просто слово, а направление бизнеса. Онтологический вектор делает для свойства смысловой "портрет".

== Где хранятся SMW-факты и ontology vectors ==

Ontology vector не записывается внутрь wiki-страницы. Внутри страницы хранится обычный wikitext с SMW-разметкой или вызовом шаблона, а embedding свойства хранится во внутреннем Gateway admin storage. В индекс WikiAI попадает не сам вектор свойства, а значения SMW-свойств страницы как <code>semantic_facts</code>.

Реальный фрагмент страницы может выглядеть так:

<pre>
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
</pre>

Шаблон разворачивает эти параметры в SMW-аннотации:

<pre>
| [[Департамент::{{{Департамент|}}}]]
| [[Отдел::{{{Отдел|}}}]]
| [[Тип документа::{{{Тип документа|}}}]]
| [[Владелец процесса::{{{Владелец процесса|}}}]]
| [[Статус документа::{{{Статус документа|Действует}}}]]
| [[Система::{{{Система|}}}]]
| [[Процесс::{{{Процесс|}}}]]
| [[Дата действия::{{{Дата действия|2026-05-31}}}]]
| [[Критичность::{{{Критичность|Средняя}}}]]
</pre>

Семантический блок можно держать в начале страницы, в конце, внутри шаблона или скрытым от обычного чтения. Для WikiAI важна не позиция блока в wikitext, а результат SMW после сохранения: Syncer получает значения через SMW <code>ask</code>, а не собственным парсингом текста страницы.

== Когда заполняется индекс ==

При создании или каждом сохранении страницы MediaWiki сначала сохраняет wikitext и обновляет состояние SMW. Затем hook <code>PageSaveComplete</code> отправляет webhook <code>edit</code> в Syncer.

Syncer перечитывает актуальный текст страницы, запрашивает у Gateway список SMW-свойств с <code>indexed=true</code>, выполняет SMW <code>ask</code> по этой странице, добавляет текстовый блок <code>Семантические свойства:</code> перед индексируемым текстом и перезаписывает chunks страницы в Qdrant с payload <code>semantic_facts</code>.

Если пользователь итерационно редактирует документ, каждое сохранение должно переиндексировать текущую версию страницы через webhook. Если webhook не сработал или Syncer недоступен, SMW-факты в MediaWiki уже могут быть новыми, но Qdrant/Search index останется старым до ручного или планового reindex.

Пользователь с правом редактирования страницы может поменять параметры шаблона или добавить прямую SMW-разметку вида <code>[[Департамент::Финансовый департамент]]</code>. WikiAI не отличает правку через форму от ручной правки wikitext: источником истины для индексации является фактический результат SMW после сохранения.

Поэтому контроль допустимых значений должен обеспечиваться правами MediaWiki, формами, шаблонами, процессом ревью или отдельной диагностикой некорректных SMW facts.

== Какие свойства создаются по умолчанию ==

Если в admin registry еще ничего нет, список строится из <code>SMW_SYNC_PROPERTIES</code>:

* Департамент
* Отдел
* Тип документа
* Владелец процесса
* Статус документа
* Система
* Процесс
* Дата действия
* Критичность

Все эти свойства получают <code>indexed=true</code>. Это значит: если профиль индексации включает <code>semanticFactsEnabled</code>, Syncer запросит эти свойства у SMW и положит найденные значения в <code>semantic_facts</code>.

Первая таблица во вкладке кликабельна. Нажмите строку, чтобы заполнить форму редактирования ниже. Выбранная строка подсвечивается, а под таблицей показывается подстрочник: с каким свойством сейчас работают нижние кнопки. В строках таблицы нет отдельных кнопок действий.

Поле <code>SMW-свойство</code> выбирается из уже существующих страниц namespace <code>Свойство</code> в MediaWiki. Если свойства нет в списке, сначала создайте страницу <code>Свойство:Имя</code> в MediaWiki/SMW и задайте <code>[[Has type::...]]</code>. AI-админка не создает новые SMW-свойства.

<code>ID</code>, <code>Метка</code> и <code>Тип данных</code> не редактируются вручную. <code>ID</code> вычисляется Gateway, метка равна имени SMW-свойства, а тип берется из SMW <code>Has type</code>.

Список SMW-свойств загружается постранично через <code>GET /api/admin/smw/properties?limit=100&amp;continue=...</code>. Если свойств больше 100, используйте поиск по началу имени свойства или кнопку <code>Показать еще</code>.

Если видите ошибку <code>Route GET:/api/admin/smw/properties... not found</code>, значит MediaWiki обращается к старому Gateway runtime. Нужно обновить или перезапустить Gateway на <code>127.0.0.1:3000</code>.

== Дефолты свойства ==

{| class="wikitable"
! Поле !! Дефолт !! Что означает
|-
| <code>description</code> || пусто || Подробное описание смысла свойства.
|-
| <code>dataType</code> || из SMW <code>Has type</code> || Тип значения, заданный на странице свойства.
|-
| <code>indexed</code> || <code>true</code> || Свойство попадает в SMW payload при индексации.
|-
| <code>aiExtractable</code> || <code>true</code> || AI может извлекать это свойство из текста.
|-
| <code>classificationThreshold</code> || <code>0.7</code> || Порог похожести для классификации.
|-
| <code>sensitive</code> || <code>false</code> || В UI называется <code>Исключения обработки</code> и управляется в отдельной вкладке.
|-
| <code>vector.status</code> || <code>missing</code> || Вектор еще не построен.
|}

Для типовых свойств UI подставляет пример описания и <code>AI prompt hint</code>. Это образец, который можно менять:

* <code>Департамент</code> - организационный департамент документа или процесса.
* <code>Отдел</code> - более точная организационная ветка внутри департамента.
* <code>Тип документа</code> - регламент, инструкция, FAQ, приказ, политика или процедура.
* <code>Владелец процесса</code> - роль или подразделение, ответственное за процесс.
* <code>Статус документа</code> - черновик, утвержден, архив, требует проверки.
* <code>Система</code> - информационная система, сервис или продукт.
* <code>Процесс</code> - бизнес-процесс или операционная процедура.
* <code>Дата действия</code> - дата вступления документа или правила в силу.
* <code>Критичность</code> - важность для бизнеса, безопасности или доступности сервиса.

== Действия в UI ==

* Клик по строке таблицы - выбирает свойство для редактирования, подсвечивает строку и обновляет подстрочник выбранного свойства.
* <code>Добавить свойство</code> - очищает форму и позволяет выбрать существующее SMW-свойство из списка.
* <code>Сохранить свойство онтологии</code> - сохраняет описание.
* <code>Индексировать</code> - включает или выключает попадание свойства в <code>semantic_facts</code> при reindex.
* <code>Сгенерировать вектор</code> - вызывает текущий embedding endpoint и сохраняет вектор. Если выбран <code>provider=openai_compatible</code>, операция может быть платной.
* <code>Similar</code> - ищет похожие свойства.
* <code>Clusterize</code> - группирует похожие свойства; UI использует порог <code>0.82</code>.
* <code>Классифицировать фрагмент</code> - проверяет, какие свойства подходят к тексту.
* <code>Удалить</code> - снимает свойство с управления WikiAI. Это не удаляет свойство и значения со страниц MediaWiki.

После удаления свойство не будет запрашиваться для новых webhook/reindex. Старые <code>semantic_facts</code> в уже записанных chunks останутся до переиндексации соответствующих страниц.

== Из чего строится вектор ==

Вектор строится не из одной строки названия. Gateway собирает source text из имени SMW-свойства, description, SMW type, <code>AI prompt hint</code> и ограниченной выборки известных значений из Qdrant <code>semantic_facts</code>.

Если для свойства включено исключение обработки, сами значения свойства в source text не включаются. Вектор все равно можно построить по описанию свойства.

В таблице показывается preview source text, чтобы администратор видел, из какого описания был построен вектор.

== Исключения обработки ==

Отдельная вкладка <code>Исключения обработки</code> управляет только флагом <code>sensitive</code> у свойств, которые уже есть в ontology registry. <code>sensitive</code> - техническое имя поля в API; в интерфейсе используется бизнес-название <code>Исключения обработки</code>.

Администратор сам решает, какие свойства исключать и почему. Чтобы включить исключение для SMW-свойства, сначала добавьте и настройте его во вкладке <code>Онтологические векторы</code>.

При необходимости сгенерируйте ontology vector, затем во вкладке <code>Исключения обработки</code> поставьте галку <code>Исключать из обработки</code>.

Снятие галки делает <code>sensitive=false</code>. SMW-свойство, значения на страницах, запись ontology registry, <code>indexed</code>, <code>aiExtractable</code>, <code>AI prompt hint</code> и threshold не меняются.

Если включено исключение обработки, свойство по умолчанию не включается в классификацию фрагмента. Чтобы включить такие свойства, оператор должен явно поставить <code>includeSensitive</code>.

<code>sensitive</code> и <code>indexed</code> - разные настройки. Исключение обработки управляет классификацией и source text для ontology vector. Indexed управляет тем, попадет ли свойство в индексируемые SMW-факты.

== Стоимость ==

Генерация ontology vectors использует текущий embedding provider. При <code>provider=ollama</code> это локальный Ollama-compatible endpoint и OpenAI не вызывается. При <code>provider=openai_compatible</code> Gateway вызывает OpenAI-compatible <code>/embeddings</code> через LiteLLM, поэтому UI/API помечают операцию как <code>paidApiPossible=true</code>.

Классификация фрагмента также строит embedding через текущий provider. Для дешевой приемки оставляйте <code>provider=ollama</code> и переключайтесь на OpenAI-compatible только для короткого контрольного запуска.

== Webhook и новые свойства ==

При full reindex Gateway передает Syncer актуальный список свойств с <code>indexed=true</code>.

При webhook <code>edit</code>, <code>move</code> или <code>protect</code> Syncer тоже запрашивает этот список у Gateway через внутренний endpoint. Если Gateway недоступен, Syncer использует fallback <code>SMW_SYNC_PROPERTIES</code> и возвращает это в диагностике как <code>smw_properties_source=config</code>.

Если администратор добавил новое свойство, например новый департамент или новое SMW-поле, оно попадет в <code>semantic_facts</code> при следующем webhook этой страницы при двух условиях:

* у свойства включен <code>indexed=true</code>;
* значение реально задано на странице в Semantic MediaWiki.

== Мягкое автозаполнение SMW-полей ==

SMW autofill управляет не полем глобально, а парой <code>документ + SMW-свойство</code>. Если пользователь вручную изменил <code>Департамент</code> в одном документе, ручным становится только <code>Департамент</code> этого документа. Остальные документы и остальные поля продолжают работать в автоматическом режиме.

По умолчанию autofill выключен, а безопасный режим по умолчанию - <code>suggest_only</code>. После включения Gateway может анализировать пустые поля шаблона <code>{{Корпоративный документ}}</code>, строить рекомендации по ontology registry и сохранять состояние владения в таблице <code>ai_smw_autofill_fields</code>.

Runtime-запись в MediaWiki делает только Syncer через сервисного пользователя MediaWiki. Для production используйте <code>MW_SERVICE_USERNAME</code> и <code>MW_SERVICE_PASSWORD</code> или <code>MW_SERVICE_PASSWORD_SECRET</code> с Indeed PAM/AAPM.

В админке управление доступно во вкладке <code>Автозаполнение SMW</code>: включение, режим, порог уверенности, шаблоны, namespaces, лимит текста страницы и таблица последних состояний полей.

Доступные режимы:

* <code>suggest_only</code> - Gateway сохраняет предложения и диагностику, но Syncer не пишет в wiki.
* <code>apply_empty</code> - Syncer заполняет только пустые auto-managed параметры шаблона, если confidence не ниже <code>minConfidence</code>.

Состояния поля:

* <code>auto</code> - поле может заполняться системой.
* <code>suggested</code> - есть рекомендация, но она еще не применена или ниже порога автоприменения.
* <code>user</code> - пользователь вручную изменил или очистил поле, система больше его не трогает.
* <code>disabled</code> - поле отключено для этого документа.

Если поле равно последнему AI-значению, оно остается auto-managed. Если после пользовательской правки значение отличается от последнего AI-значения или пользователь очистил поле, Gateway переводит только это поле этого документа в <code>user</code>.

Вернуть поле в автоуправление можно через <code>POST /api/admin/smw/autofill/reset-ownership</code>.
`
    ),
    managedPage(
      pageTitles.audit,
      'Вкладка Логи администрирования',
      `
== Что делает пункт меню ==

Вкладка <code>Логи</code> показывает audit log административных действий: кто, когда и какую настройку изменил или проверил.

Если совсем просто: это журнал у охранника. Он не хранит всю переписку и не заменяет историю MediaWiki, но записывает важные действия в админке.

== Какие действия попадают в audit ==

* изменение service config;
* изменение LLM config;
* изменение embeddings config или запуск embedding test;
* изменение RAG config;
* изменение webhook config или webhook test;
* изменение chat retention;
* создание/изменение trust model, entity, rule;
* пересчет trust payload;
* изменение indexing profile;
* изменение ontology property и генерация vector.

== Что видно в записи ==

Обычно запись содержит:

* <code>id</code> - номер записи;
* <code>action</code> - тип действия;
* <code>entityType</code> и <code>entityId</code> - что меняли;
* <code>actor</code> - кто сделал действие;
* <code>createdAt</code> - когда;
* <code>metadata</code> - технические детали без секретов.

== Чего audit не делает ==

* Не показывает API keys.
* Не заменяет логи контейнеров Gateway/Syncer.
* Не заменяет историю правок MediaWiki.
* Не доказывает, что LLM ответ был правильным; он доказывает только факт административного действия.
`
    ),
    managedPage(
      pageTitles.faq,
      'FAQ и диагностика',
      `
== "Ошибка при генерации ответа." ==

Это общий пользовательский текст ошибки чата. Проверяйте по цепочке:

# Открывается ли [[${pageTitles.overview}|Обзор]] без ошибок session cookie.
# Есть ли Qdrant collection <code>wiki_chunks</code> с размерностью <code>768</code>.
# Есть ли найденные chunks по вопросу пользователя.
# Может ли текущий пользователь читать исходные страницы в MediaWiki.
# Не отфильтрованы ли chunks моделью доверия.
# Настроены ли <code>LITELLM_BASE_URL</code>, <code>LITELLM_API_KEY</code> и model.
# Не истек ли timeout LLM.

== "Missing session cookie" ==

Обычно означает, что запрос ушел не через MediaWiki same-origin proxy или браузер не приложил cookie. Откройте Admin UI через MediaWiki:

<code>http://127.0.0.1:8082/index.php/Служебная:AI-администрирование</code>

== "Invalid or expired MediaWiki session" ==

Сессия MediaWiki устарела или была открыта не тем origin. Обновите страницу, войдите заново, не дергайте Gateway URL напрямую из браузера.

== "NetworkError when attempting to fetch resource" ==

Проверьте:

* открыт ли Admin UI через MediaWiki, а не standalone frontend;
* отвечает ли Gateway;
* не заблокирован ли same-origin proxy;
* не сломаны ли CORS origins, если запускается standalone UI.

== "Qdrant vector dimension mismatch" ==

Gateway ожидает Qdrant vector size <code>768</code>. Если embedding model поменяли, а коллекцию оставили старой, размерность может не совпасть. Решение: создать совместимую коллекцию или выполнить полную переиндексацию под новую модель.

== Как проверять дешевле ==

* Trust preview - бесплатно, без LLM.
* Webhook health test - бесплатно, без LLM.
* Embedding test при <code>provider=ollama</code> - без OpenAI.
* Dry-run индексации с маленьким <code>maxPages</code> - без LLM.
* LLM test и настоящий чат - потенциально платные, потому что идут через OpenAI-compatible endpoint.

== Где искать подробности ==

* [[${pageTitles.services}|Сервисы]] - адреса и переменные окружения.
* [[${pageTitles.externalApi}|Внешний API и MCP]] - OIDC Bearer, ACL mode и подключение MCP adapter.
* [[${pageTitles.llm}|LLM]] - модель ответа и платный тест.
* [[${pageTitles.rag}|RAG / Chunking]] - контекст, chunks и стоимость prompt.
* [[${pageTitles.documents}|Распознавание документов]] - MIME policy.
* [[${pageTitles.trust}|Модель доверия]] - почему документ попал или не попал в ответ.
`
    ),
  ];
}

function managedPage(title, heading, body) {
  return {
    title,
    text: [
      MANAGED_DOC_NOTICE,
      '',
      `= ${heading} =`,
      body.trim(),
      '',
      `[[${AI_ADMIN_DOC_HOME}|К документации AI-администрирования]]`,
      '[[Категория:WikiAI admin docs]]',
      '',
    ].join('\n'),
  };
}
