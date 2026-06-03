import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  downloadFile,
  editPageContent,
  fetchAllPages,
  fetchFileInfo,
  fetchPageCategories,
  fetchPageFiles,
  fetchSemanticFacts,
  normalizeSemanticPrintouts,
  semanticFactsToText,
  resetMediaWikiServiceAuthForTests,
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

describe('MediaWiki data access helpers', () => {
  it('edits pages after fetching CSRF tokens and rejects empty token responses', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(String(init.body)).toContain('action=edit');
        expect(String(init.body)).toContain('title=Target+Page');
        expect(String(init.body)).toContain('token=csrf-token');
        return new Response(JSON.stringify({
          edit: {
            result: 'Success',
            pageid: 12,
            title: 'Target Page',
            oldrevid: 100,
            newrevid: 101,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        query: { tokens: { csrftoken: 'csrf-token' } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(editPageContent('Target Page', 'new body', 'test edit')).resolves.toEqual({
      result: 'Success',
      pageId: 12,
      title: 'Target Page',
      oldRevisionId: 100,
      newRevisionId: 101,
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ query: { tokens: {} } }), { status: 200 })));
    await expect(editPageContent('Target Page', 'new body', 'test edit'))
      .rejects.toThrow('MediaWiki CSRF token was not returned');
  });

  it('paginates allpages requests and forwards namespace filters', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('apnamespace')).toBe('3030');
      if (!url.searchParams.get('apcontinue')) {
        return new Response(JSON.stringify({
          query: {
            allpages: [
              { pageid: 1, ns: 3030, title: 'CorpIT:A' },
            ],
          },
          continue: { apcontinue: 'next-page' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        query: {
          allpages: [
            { pageid: 2, ns: 3030, title: 'CorpIT:B' },
          ],
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllPages(3030)).resolves.toEqual([
      { pageid: 1, ns: 3030, title: 'CorpIT:A' },
      { pageid: 2, ns: 3030, title: 'CorpIT:B' },
    ]);
  });

  it('normalizes semantic facts and renders them as text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      query: {
        results: {
          'Target Page': {
            printouts: {
              Status: [{ fulltext: 'Published' }, 'Published', { raw: 'Verified' }],
              Count: [3],
              Active: [true],
              Empty: [{}],
            },
          },
        },
      },
    }), { status: 200 })));

    await expect(fetchSemanticFacts('Target Page', ['Status', 'Count'])).resolves.toEqual({
      Status: ['Published', 'Verified'],
      Count: ['3'],
      Active: ['true'],
    });
    expect(normalizeSemanticPrintouts({ Date: { timestamp: '2026-06-03T00:00:00Z' } })).toEqual({
      Date: ['2026-06-03T00:00:00Z'],
    });
    expect(semanticFactsToText({ Status: ['Published', 'Verified'] })).toBe(
      'Семантические свойства:\nStatus: Published, Verified'
    );
    expect(semanticFactsToText({})).toBe('');
  });

  it('reads categories, page files, and file metadata with safe fallbacks', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.searchParams.get('prop') === 'categories') {
        return new Response(JSON.stringify({
          query: {
            pages: {
              1: {
                categories: [
                  { title: 'Category:Runbooks' },
                  { title: 42 },
                ],
              },
            },
          },
        }), { status: 200 });
      }
      if (url.searchParams.get('action') === 'parse') {
        return new Response(JSON.stringify({
          parse: { images: ['Diagram.png', 'Page_Example.png', 'Manual.pdf'] },
        }), { status: 200 });
      }
      if (url.searchParams.get('prop') === 'imageinfo') {
        return new Response(JSON.stringify({
          query: {
            pages: {
              10: {
                imageinfo: [{
                  url: 'https://wiki.example/files/Diagram.png',
                  mime: 'image/png',
                  size: 1234,
                }],
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPageCategories('Target Page')).resolves.toEqual(['Category:Runbooks']);
    await expect(fetchPageFiles('Target Page')).resolves.toEqual(['Diagram.png', 'Manual.pdf']);
    await expect(fetchFileInfo('Diagram.png')).resolves.toEqual({
      filename: 'Diagram.png',
      url: 'https://wiki.example/files/Diagram.png',
      mime: 'image/png',
      size: 1234,
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ query: {} }), { status: 200 })));
    await expect(fetchFileInfo('Missing.png')).resolves.toBeNull();
  });

  it('re-authenticates downloads after service-session authorization failures', async () => {
    config.mwServiceUsername = 'WikiAISync';
    config.mwServicePassword = 'service-password';
    config.mwServicePasswordSecret = undefined;
    config.mwSyncCookie = undefined;

    let loginCount = 0;
    let downloadCount = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.searchParams.get('type') === 'login') {
        loginCount += 1;
        return new Response(JSON.stringify({
          query: { tokens: { logintoken: `login-token-${loginCount}` } },
        }), {
          status: 200,
          headers: { 'set-cookie': `mw_session=session-${loginCount}; Path=/` },
        });
      }

      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ login: { result: 'Success' } }), {
          status: 200,
          headers: { 'set-cookie': `mw_user=WikiAISync-${loginCount}; Path=/` },
        });
      }

      downloadCount += 1;
      if (downloadCount === 1) {
        expect((init?.headers as Record<string, string>).Cookie).toContain('mw_user=WikiAISync-1');
        return new Response('forbidden', { status: 403 });
      }

      expect((init?.headers as Record<string, string>).Cookie).toContain('mw_user=WikiAISync-2');
      return new Response('file-body', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadFile('https://wiki.example/files/Manual.pdf')).resolves.toEqual(Buffer.from('file-body'));
    expect(loginCount).toBe(2);
    expect(downloadCount).toBe(2);
  });
});
