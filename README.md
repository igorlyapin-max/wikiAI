# Wiki AI — AI-поиск и чат-ассистент для MediaWiki

Self-hosted система AI-поиска и чат-ассистента поверх корпоративной MediaWiki с учётом ACL пользователей.

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

- **Conservative ACL**: deny by default
- **Stale access приемлем**, утечка — нет
- **Post-check** через MW API для сомнительных результатов

## Структура

```
wikiAI/
├── docker-compose.yml          # Только Qdrant
├── .env.example                # Шаблон переменных
├── README.md
├── packages/
│   ├── gateway/                # AI Gateway (Node.js + Fastify + TS)
│   ├── syncer/                 # Индексатор (Node.js)
│   └── mw-extension/           # MediaWiki Extension (PHP + React)
└── scripts/
```

## Быстрый старт

### 1. Qdrant (единственный сервис в Docker)

```bash
cp .env.example .env
# Отредактируй .env — укажи URL существующих внешних сервисов

docker-compose up -d
```

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

```bash
cd packages/mw-extension
cp -r . /var/www/html/extensions/AIAssistant

# Добавь в LocalSettings.php:
# wfLoadExtension('AIAssistant');
# $wgAIAssistantGatewayUrl = 'http://gateway-host:3000';
# $wgAIAssistantSyncerUrl = 'http://syncer-host:3001';

php maintenance/update.php
```

### 5. Frontend

```bash
cd packages/mw-extension/resources/ai-assistant
npm install
npm run build
```

### 6. Переиндексация

```bash
cd packages/syncer
npm run build
node dist/cli/reindex.js
```

## API

| Сервис | Endpoint | Описание |
|--------|----------|----------|
| Gateway | `GET /health` | Статус всех сервисов |
| Gateway | `POST /api/search` | AI-поиск с ACL |
| Gateway | `POST /api/chat` | Чат-ассистент (SSE) |
| Syncer | `POST /webhook/page` | Webhook от MediaWiki |

## AD-интеграция (этап заказчика)

1. Установить LDAP Stack в MW: PluggableAuth + LDAPProvider + LDAPAuthentication2 + LDAPGroups
2. Настроить `nestedgroups: true`
3. Gateway и Syncer **не меняются** — они работают с MW-группами

## Лицензия

MIT
