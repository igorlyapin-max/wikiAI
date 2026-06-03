import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUserInfo, fetchWikiPages, fetchWikiTags, fetchWikiTemplates, userCanRead } from '../mediawiki.js';

describe('MediaWiki API session forwarding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates userinfo with session cookies and without anonymous CORS origin', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      query: {
        userinfo: {
          id: 42,
          name: 'Admin',
          groups: ['sysop', 'aiadmin'],
        },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const user = await fetchUserInfo('mw_session=valid; mwUserID=42');
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(input);

    expect(user?.username).toBe('Admin');
    expect(url.searchParams.get('origin')).toBeNull();
    expect(init.headers).toMatchObject({
      Cookie: 'mw_session=valid; mwUserID=42',
      'User-Agent': 'WikiAI-Gateway/0.1',
    });
  });

  it('checks page readability with cookies and without anonymous CORS origin', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      query: {
        pages: {
          1: {
            pageid: 1,
            readable: '',
          },
        },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(userCanRead('mw_session=valid', 'Main Page')).resolves.toBe(true);
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(input);

    expect(url.searchParams.get('origin')).toBeNull();
    expect(init.headers).toMatchObject({
      Cookie: 'mw_session=valid',
      'User-Agent': 'WikiAI-Gateway/0.1',
    });
  });

  it('checks public page readability without forwarding a Cookie header', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      query: {
        pages: {
          1: {
            pageid: 1,
            readable: '',
          },
        },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(userCanRead(undefined, 'Main Page')).resolves.toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(init.headers).toMatchObject({
      'User-Agent': 'WikiAI-Gateway/0.1',
    });
    expect(init.headers).not.toHaveProperty('Cookie');
  });

  it('strips namespace prefixes when searching pages in MediaWiki namespaces', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get('siprop') === 'namespaces') {
        return new Response(JSON.stringify({
          query: {
            namespaces: {
              0: { id: 0, '*': '', content: '' },
              3030: { id: 3030, '*': 'CorpIT', canonical: 'CorpIT', content: '' },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        query: {
          allpages: [
            { pageid: 1001, ns: 3030, title: 'CorpIT:Инструкция VPN' },
          ],
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWikiPages({
      search: 'CorpIT:Инструкция',
      limit: 10,
      sessionCookie: 'mw_session=valid',
    })).resolves.toEqual([
      { title: 'CorpIT:Инструкция VPN', namespace: 3030, pageId: 1001 },
    ]);

    const allPagesCall = fetchMock.mock.calls.find(([input]) => {
      const url = new URL(String(input));
      return url.searchParams.get('list') === 'allpages';
    });
    expect(allPagesCall).toBeDefined();
    const url = new URL(String(allPagesCall?.[0]));
    expect(url.searchParams.get('apnamespace')).toBe('3030');
    expect(url.searchParams.get('apprefix')).toBe('Инструкция');
  });

  it('uses the raw tag name when MediaWiki displayname contains HTML', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      query: {
        tags: [
          {
            name: 'editcheck-paste-shown',
            displayname: '<a href="https://www.mediawiki.org/wiki/Help:Edit_check">Edit Check shown</a>',
            description: 'EditCheck <b>description</b>',
            active: '',
          },
        ],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWikiTags({ limit: 5, sessionCookie: 'mw_session=valid' })).resolves.toEqual([
      {
        name: 'editcheck-paste-shown',
        displayName: 'editcheck-paste-shown',
        description: 'EditCheck description',
        active: true,
      },
    ]);
  });

  it('returns template names without the MediaWiki namespace prefix', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      query: {
        allpages: [
          { pageid: 170, ns: 10, title: 'Шаблон:Корпоративный документ' },
        ],
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWikiTemplates({ limit: 5, sessionCookie: 'mw_session=valid' })).resolves.toEqual([
      {
        name: 'Корпоративный документ',
        title: 'Шаблон:Корпоративный документ',
      },
    ]);
  });
});
