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

## Auth And Group Mapping

Production MCP clients should use `WIKIAI_ACCESS_TOKEN` with an OIDC access
token issued for the WikiAI audience. The adapter does not validate this token
itself and does not inspect groups; it forwards the Bearer header to Gateway.

Gateway validates RS256 signature through the configured JWKS, then checks
`iss`, `aud`, `exp` and `nbf`. When External API ACL mode is `groups_only`, raw
OIDC/AD groups from the token are mapped to MediaWiki ACL groups by Gateway
admin config:

```json
{
  "groupMappingMode": "mapped_only",
  "groupMappings": {
    "CN=WikiAI-IT-Readers,OU=Groups,DC=corp,DC=example": ["ai-it"]
  }
}
```

`mapped_only` is the recommended production mode for Variant A: raw IdP groups
are dropped after mapping, so only explicit MediaWiki ACL groups can grant
access. `passthrough_and_mapped` is a compatibility/diagnostic mode for cases
where raw group names already match MediaWiki groups.

MediaWiki login/password is not an MCP auth method. `WIKIAI_COOKIE` is a
local/admin fallback for embedded checks and should not be the customer-facing
multi-consumer path.

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
- `topK` - optional number from 1 to 50; overrides the selected retrieval profile `retrievalTopK` for this call.
- `format` - optional `compact` or `full`.

Gateway call:

```txt
POST /api/v1/search
```

### `wikiai_chat`

Input:

- `message` - required non-empty string.
- `conversationId` - optional string.
- `topK` - optional number from 1 to 50; overrides the selected retrieval profile `retrievalTopK` for this call, while prompt context still follows `contextTopK/contextMaxChars`.

Gateway call:

```txt
POST /api/v1/chat
```

The adapter forces `stream=false`; SSE streaming stays a direct Gateway concern.

## Error Handling

Gateway non-2xx responses become MCP JSON-RPC errors with code `-32000`.
Unknown MCP methods return `-32601`; unknown tools return `-32000`.
