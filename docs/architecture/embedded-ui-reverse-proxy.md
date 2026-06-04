# WikiAI Embedded UI Reverse Proxy

## Decision

WikiAI UI should move toward a standalone frontend served through the same public
origin as MediaWiki, instead of keeping the real user and admin interfaces inside
MediaWiki special pages.

MediaWiki remains the source of truth for:

- users, sessions, groups and page ACL;
- content, namespaces, Semantic MediaWiki facts and uploaded files;
- edit/delete/move/protect webhooks;
- navigation entrypoints into WikiAI.

Gateway remains the enforcement point for WikiAI API calls. The frontend must not
decide access rights by itself.

## Target Shape

Preferred public routing:

```text
https://<wiki-origin>/ai/          -> WikiAI standalone UI
https://<wiki-origin>/api/...      -> WikiAI Gateway
https://<wiki-origin>/wiki/...     -> MediaWiki
```

The exact paths may differ per deployment, but the production default should be
same-origin routing. That keeps MediaWiki cookies usable by the browser without
opening broad CORS.

Gateway should continue to validate the caller through MediaWiki session cookie
or OIDC bearer token. Admin routes must keep the current `sysop`/`aiadmin`
server-side checks.

## MediaWiki Extension Role

After migration, MediaWiki special pages should be thin entrypoints:

- `Special:AIAssistant` redirects or links to the standalone assistant UI.
- `Special:AIAdmin` redirects or links to the standalone admin UI after checking
  `aiadmin`, or the Gateway rejects non-admin calls directly.
- The extension keeps webhook hooks and configuration needed by MediaWiki.

The extension should not own the full frontend lifecycle unless a future
MediaWiki-specific workflow requires it.

## Reverse Proxy Requirements

The deployment must define:

- UI upstream and Gateway upstream.
- Cookie and `Authorization` forwarding policy.
- `X-Forwarded-*` and request id propagation.
- CSRF policy for mutating API calls.
- Security headers: TLS/HSTS, CSP, cache policy and `frame-ancestors`.
- SSE support for chat streaming.
- Request body and timeout limits for admin operations.

If a deployment uses a different UI origin, it must explicitly document CORS,
`SameSite=None; Secure`, cookie domain and CSRF behavior. That is not the
preferred default.

## Testing And Deployment

Standalone UI should be tested and deployed as a normal frontend application:

- component/unit tests for assistant and admin UI;
- Playwright E2E through the public proxied route;
- auth scenarios: anonymous, authenticated user, non-admin, `sysop`/`aiadmin`,
  expired session;
- reverse proxy smoke for UI route, API route, cookies and security headers;
- build artifact versioning independent of MediaWiki ResourceLoader.

The current ResourceLoader-based UI can remain during migration, but it should be
treated as an interim bridge rather than the long-term product frontend.

## Implementation Slice

The first standalone migration slice lives in `packages/wiki-ui`:

- Vite/React build with public base `/ai/`.
- Route `/ai/assistant` reuses the current assistant React implementation with
  relative Gateway API calls.
- Route `/ai/admin` exposes an admin overview backed by
  `/api/admin/health`, `/api/admin/search-index/status` and
  `/api/admin/service-config`.
- Local Vite dev mode proxies `/api` to `http://127.0.0.1:3000` by default;
  override with `WIKIAI_GATEWAY_DEV_URL` when needed.
- `config/nginx.wikiai-ui.example.conf` documents the same-origin reverse proxy
  contract for `/ai/`, `/api/` and `/wiki/`; the example expects the built UI
  artifact under `/var/www/ai`.
- `docker-compose.wikiai-edge.yml` runs that config as a local edge proxy on
  `${WIKIAI_EDGE_PORT:-8084}` and attaches it to the existing `wikiai_default`
  and `mediawiki_default` Docker networks without restarting Gateway or Syncer.

The MediaWiki ResourceLoader packages remain available while the rest of the
admin workflows move into the standalone package.
