import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  callSyncerAdmin,
  getSyncerMediaWikiServiceAuthStatus,
  isSyncerAdminError,
  startSyncerReindex,
  testSyncerMediaWikiServiceAuth,
} from '../syncer-admin.js';

const originalConfig = { ...config };

afterEach(() => {
  Object.assign(config, originalConfig);
  vi.unstubAllGlobals();
});

describe('syncer admin client', () => {
  it('forwards JSON requests and the configured admin token', async () => {
    config.syncerAdminToken = 'syncer-token';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startSyncerReindex({ maxPages: 1, dryRun: true })).resolves.toEqual({ accepted: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(url).toBe(`${config.syncerBaseUrl}/admin/reindex`);
    expect(init.method).toBe('POST');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-wikiai-admin-token')).toBe('syncer-token');
    expect(init.body).toBe(JSON.stringify({ maxPages: 1, dryRun: true }));
  });

  it('raises SyncerAdminError with status and response body on admin failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'MediaWiki service auth is required before protected reindex',
    }), { status: 409 })));

    const err = await callSyncerAdmin('/admin/reindex', { method: 'POST' })
      .then(() => undefined, (caught: unknown) => caught);

    expect(isSyncerAdminError(err)).toBe(true);
    expect(err).toMatchObject({
      statusCode: 409,
      message: 'MediaWiki service auth is required before protected reindex',
      responseBody: {
        message: 'MediaWiki service auth is required before protected reindex',
      },
    });
  });

  it('returns a redacted fallback auth status for malformed Syncer auth responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));

    await expect(getSyncerMediaWikiServiceAuthStatus('http://syncer.local')).resolves.toMatchObject({
      configured: false,
      source: 'unknown',
      usernameConfigured: false,
      passwordConfigured: false,
      passwordUsesSecretReference: false,
      pamProviderConfigured: false,
      deprecatedCookieConfigured: false,
      error: 'Unexpected Syncer auth status response',
    });
  });

  it('returns a safe error result for malformed Syncer auth test responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ auth: {} }), { status: 200 })));

    await expect(testSyncerMediaWikiServiceAuth('http://syncer.local')).resolves.toMatchObject({
      status: 'error',
      auth: {
        source: 'unknown',
        configured: false,
      },
      error: 'Unexpected Syncer auth test response',
    });
  });
});
