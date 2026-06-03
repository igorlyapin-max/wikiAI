import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  fetchPageContent,
  getMediaWikiServiceAuthStatus,
  resetMediaWikiServiceAuthForTests,
  testMediaWikiServiceLogin,
} from '../mediawiki.js';

const originalConfig = { ...config };

function restoreConfig(): void {
  Object.assign(config, originalConfig);
  resetMediaWikiServiceAuthForTests();
}

afterEach(() => {
  restoreConfig();
  vi.unstubAllGlobals();
});

describe('MediaWiki service authentication', () => {
  it('logs in with service credentials and uses the in-memory session cookie for page reads', async () => {
    config.mwServiceUsername = 'WikiAISync';
    config.mwServicePassword = 'service-password';
    config.mwServicePasswordSecret = undefined;
    config.mwSyncCookie = undefined;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const call = fetchMock.mock.calls.length;

      if (call === 1) {
        expect(url.searchParams.get('action')).toBe('query');
        expect(url.searchParams.get('type')).toBe('login');
        return new Response(JSON.stringify({
          query: { tokens: { logintoken: 'login-token' } },
        }), {
          status: 200,
          headers: { 'set-cookie': 'mw_session=token-session; Path=/' },
        });
      }

      if (call === 2) {
        expect(init?.method).toBe('POST');
        expect(String((init?.headers as Record<string, string>).Cookie)).toContain('mw_session=token-session');
        expect(String(init?.body)).toContain('lgname=WikiAISync');
        expect(String(init?.body)).toContain('lgpassword=service-password');
        return new Response(JSON.stringify({ login: { result: 'Success' } }), {
          status: 200,
          headers: { 'set-cookie': 'mw_user=WikiAISync; Path=/' },
        });
      }

      expect(url.searchParams.get('titles')).toBe('Protected Page');
      expect(String((init?.headers as Record<string, string>).Cookie)).toContain('mw_user=WikiAISync');
      return new Response(JSON.stringify({
        query: {
          pages: {
            10: {
              pageid: 10,
              ns: 3030,
              title: 'Protected Page',
              revisions: [{
                timestamp: '2026-06-03T08:00:00Z',
                slots: { main: { '*': 'Protected body' } },
              }],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPageContent('Protected Page')).resolves.toMatchObject({
      title: 'Protected Page',
      content: 'Protected body',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports redacted service auth status and tests the logged-in MediaWiki user', async () => {
    config.mwServiceUsername = 'WikiAISync';
    config.mwServicePassword = 'secret://Vault/MediaWiki/wikiai-syncer';
    config.mwServicePasswordSecret = undefined;
    config.secretsProvider = 'IndeedPamAapm';
    config.pamBaseUrl = 'https://pam.example.local';
    config.pamToken = 'application-token';
    config.mwSyncCookie = undefined;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.hostname === 'pam.example.local') {
        return new Response(JSON.stringify({ password: 'resolved-password' }), { status: 200 });
      }

      if (url.searchParams.get('type') === 'login') {
        return new Response(JSON.stringify({
          query: { tokens: { logintoken: 'login-token' } },
        }), {
          status: 200,
          headers: { 'set-cookie': 'mw_session=token-session; Path=/' },
        });
      }

      if (init?.method === 'POST') {
        expect(String(init.body)).toContain('lgpassword=resolved-password');
        return new Response(JSON.stringify({ login: { result: 'Success' } }), {
          status: 200,
          headers: { 'set-cookie': 'mw_user=WikiAISync; Path=/' },
        });
      }

      return new Response(JSON.stringify({
        query: {
          userinfo: {
            id: 100,
            name: 'WikiAISync',
            groups: ['user', 'ai-exec'],
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(getMediaWikiServiceAuthStatus()).toMatchObject({
      configured: true,
      source: 'service_credentials',
      passwordConfigured: true,
      passwordUsesSecretReference: true,
      pamProviderConfigured: true,
    });
    await expect(testMediaWikiServiceLogin()).resolves.toMatchObject({
      status: 'ok',
      user: {
        username: 'WikiAISync',
        userId: 100,
        groups: ['user', 'ai-exec'],
      },
    });
  });
});
