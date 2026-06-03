# WikiAI MCP Adapter Contract

`packages/mcp-adapter` is a stdio JSON-RPC MCP server. It has no direct access
to Qdrant, Redis, SQLite, MediaWiki or secrets. It calls only Gateway external
API endpoints through `WIKIAI_GATEWAY_URL`.

## Environment

- `WIKIAI_GATEWAY_URL` - Gateway base URL, default `http://127.0.0.1:3000`.
- `WIKIAI_ACCESS_TOKEN` - optional OIDC/JWT bearer token for external API auth.
- `WIKIAI_COOKIE` - optional MediaWiki cookie fallback for local/admin testing.

Do not configure both token and cookie unless the client has an explicit reason
to prefer Gateway's normal auth precedence.

## MCP Methods

- `initialize` returns protocol version `2024-11-05` and server
  `wikiai-mcp-adapter`.
- `tools/list` returns the tools below.
- `tools/call` calls a named tool with JSON arguments.

## Tools

### `wikiai_capabilities`

Input: empty object.

Gateway call:

```txt
GET /api/v1/capabilities
```

### `wikiai_search`

Input:

- `query` - required non-empty string.
- `topK` - optional number from 1 to 50.
- `format` - optional `compact` or `full`.

Gateway call:

```txt
POST /api/v1/search
```

### `wikiai_chat`

Input:

- `message` - required non-empty string.
- `conversationId` - optional string.
- `topK` - optional number from 1 to 50.

Gateway call:

```txt
POST /api/v1/chat
```

The adapter forces `stream=false`; SSE streaming stays a direct Gateway concern.

## Error Handling

Gateway non-2xx responses become MCP JSON-RPC errors with code `-32000`.
Unknown MCP methods return `-32601`; unknown tools return `-32000`.
