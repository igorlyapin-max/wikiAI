# cmdbdynamicpages and WikiAI contract

## Purpose

This contract describes how WikiAI indexes MediaWiki pages that contain
`cmdbdynamicpages` blocks.

MediaWiki remains the source of truth for moderated static content and page
ACL. `cmdbdynamicpages` business data is indexed only when it is exposed as an
anonymous `staticSnapshot`. User-dependent `dynamicUser` runtime results are
not written into the shared WikiAI index.

## Deployment Routes

All browser-facing routes should be same-origin behind the reverse proxy:

```text
/wiki/* or normal wiki routes          -> MediaWiki
/api/v1/* and /api/*                   -> WikiAI Gateway
/cmdbuild/dynamicpages/*               -> cmdbdynamicpages
/cmdbuild/custom-api/*                 -> cmdbdynamicpages
```

The proxy forwards `Cookie`, `Authorization`, `X-Forwarded-*`, and request id
headers. Browser code should use relative URLs and should not call internal
ports directly.

## Marker Detection

WikiAI Syncer detects dynamic blocks from explicit MediaWiki markup. Supported
forms:

```wiki
{{#cmdb:
 |template=AssetsByOwner
 |owner={{PAGENAME}}
 |mode=widget
}}

{{CmdbPage
 |template=AssetsByOwner
 |owner={{PAGENAME}}
}}
```

Rendered-output markers are also supported for future integrations:

```html
<div
  data-wikiai-dynamic-source="cmdbdynamicpages"
  data-template-code="AssetsByOwner"
  data-params='{"owner":"Router42"}'></div>
```

Arbitrary links to `/cmdbuild/dynamicpages/ui/run/...` are not treated as
indexable blocks.

## Indexing Rules

For each marker, Syncer tries an anonymous JSON request:

```text
GET /cmdbuild/dynamicpages/ui/run/<templateCode>?<params>&json=true
```

No `CMDBuild-Authorization` cookie is sent by Syncer for this request.

If the response contains `snapshotFound=true`, Syncer writes additional chunks
with:

```text
source_type=cmdbdynamicpages
content_type=cmdbdynamicpages_static_snapshot
```

The chunk inherits the ACL of the parent MediaWiki page. CMDBuild ACL is not
rechecked for this snapshot because the snapshot was explicitly published by
`cmdbdynamicpages`.

If the snapshot is missing, failed, or contains unresolved wiki parameters,
Syncer writes only a status/metadata chunk:

```text
content_type=cmdbdynamicpages_snapshot_status
```

Runtime rows from `dynamicUser`, `permissionOnly`, `visibilityHash`,
`privateUser`, and `disabled` cache modes are not written to the shared index.

## Runtime Context

External API requests may include optional `context.dynamicBlocks[]`. Gateway
validates the shape but still derives identity and access rights server-side.
The context must not contain trusted usernames, groups, tokens, or secrets.

Live user-dependent runtime enrichment can be added later only through a
server-side adapter that validates the current CMDBuild session. Until that
adapter exists, WikiAI uses indexed static content and anonymous snapshots.

## Syncer Configuration

```text
CMDBDYNAMICPAGES_ENABLED=false
CMDBDYNAMICPAGES_BASE_URL=http://cmdbdynamicpages:8093
CMDBDYNAMICPAGES_MAX_BLOCKS_PER_PAGE=10
CMDBDYNAMICPAGES_MAX_SNAPSHOT_CHARS=20000
CMDBDYNAMICPAGES_SNAPSHOT_TIMEOUT_MS=10000
CMDBDYNAMICPAGES_REDACT_PARAMS=password,passwd,pwd,token,secret,authorization,auth,csrf
```

`CMDBDYNAMICPAGES_ENABLED` is off by default so existing reindex runs do not
call external runtime endpoints until the deployment contract is configured.

## Logging And Diagnostics

Syncer and Gateway must keep debug/diagnostic mode configuration-driven and off
by default. `Basic` diagnostics may include marker counts and snapshot statuses.
`Verbose` must still redact cookies, bearer tokens, CSRF values, Redis secrets,
and sensitive runtime parameters.
