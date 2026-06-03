import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSmwProperties,
  fetchUserInfo,
  fetchWikiCategories,
  fetchWikiNamespaces,
  fetchWikiPages,
  fetchWikiTags,
  fetchWikiTemplates,
  fetchWikiUserGroups,
  userCanRead,
  userCanReadWithBearer,
} from '../mediawiki.js';

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

  it('checks page readability with bearer tokens and safely rejects malformed responses', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get('titles') === 'Protected Page') {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer access-token',
          'User-Agent': 'WikiAI-Gateway/0.1',
        });
        return new Response(JSON.stringify({
          query: {
            pages: {
              1: { pageid: 1, readable: '' },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ query: {} }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(userCanReadWithBearer('access-token', 'Protected Page')).resolves.toBe(true);
    await expect(userCanReadWithBearer('access-token', 'Missing Page')).resolves.toBe(false);
  });

  it('normalizes categories, namespaces, and user groups from siteinfo APIs', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get('list') === 'allcategories') {
        expect(url.searchParams.get('aclimit')).toBe('100');
        expect(url.searchParams.get('acprefix')).toBe('Dev Ops');
        return new Response(JSON.stringify({
          query: {
            allcategories: [
              { category: 'Dev Ops' },
              { title: 'AI' },
              { '*': 'Security' },
              { bad: '' },
            ],
          },
        }), { status: 200 });
      }
      if (url.searchParams.get('siprop') === 'namespaces') {
        return new Response(JSON.stringify({
          query: {
            namespaces: {
              0: { id: 0, '*': '', content: '' },
              3030: { id: '3030', name: 'CorpIT', canonical: 'CorpIT', content: true },
              bad: { id: 'bad' },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        query: {
          usergroups: [
            { name: 'sysop', rights: ['read', 42, 'edit'] },
            { name: '' },
            'bad',
          ],
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWikiCategories({
      search: 'Категория:Dev_Ops',
      limit: 500,
      sessionCookie: 'mw_session=valid',
    })).resolves.toEqual([
      { name: 'Dev Ops', title: 'Category:Dev Ops' },
      { name: 'AI', title: 'Category:AI' },
      { name: 'Security', title: 'Category:Security' },
    ]);
    await expect(fetchWikiNamespaces({ sessionCookie: 'mw_session=valid' })).resolves.toEqual([
      { id: 0, name: '', displayName: 'Main', content: true },
      { id: 3030, name: 'CorpIT', canonical: 'CorpIT', displayName: 'CorpIT', content: true },
    ]);
    await expect(fetchWikiUserGroups({ sessionCookie: 'mw_session=valid' })).resolves.toEqual([
      { name: 'sysop', displayName: 'sysop', rights: ['read', 'edit'] },
    ]);
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

  it('returns SMW properties with parsed types, descriptions, and continue tokens', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get('list') === 'allpages') {
        expect(url.searchParams.get('apnamespace')).toBe('102');
        expect(url.searchParams.get('apprefix')).toBe('Owner');
        expect(url.searchParams.get('apcontinue')).toBe('next-1');
        return new Response(JSON.stringify({
          continue: { apcontinue: 'next-2' },
          query: {
            allpages: [
              { title: 'Property:Owner' },
              { title: 'Property:Owner#ignored' },
              { title: 'Property:Status date' },
            ],
          },
        }), { status: 200 });
      }

      expect(url.searchParams.get('prop')).toBe('revisions');
      return new Response(JSON.stringify({
        query: {
          pages: {
            10: {
              title: 'Property:Owner',
              revisions: [{
                slots: { main: { '*': '[[Has type::Page]]\nOwner description' } },
              }],
            },
            11: {
              title: 'Property:Status date',
              revisions: [{ '*': '[[Has type::Date]]\nStatus date description' }],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSmwProperties({
      search: 'Property:Owner',
      limit: 10,
      continue: 'next-1',
      sessionCookie: 'mw_session=valid',
    })).resolves.toEqual({
      count: 1,
      nextContinue: 'next-2',
      values: [{
        name: 'Owner',
        title: 'Property:Owner',
        type: 'Page',
        description: 'Owner description',
      }],
    });
  });

  it('returns empty catalog results for non-OK and malformed MediaWiki responses', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get('list') === 'tags') {
        return new Response('bad gateway', { status: 502 });
      }
      if (url.searchParams.get('meta') === 'siteinfo') {
        return new Response(JSON.stringify({ query: { namespaces: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ query: { allpages: 'not-an-array' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWikiTags({ search: 'edit' })).resolves.toEqual([]);
    await expect(fetchWikiNamespaces()).resolves.toEqual([]);
    await expect(fetchWikiTemplates()).resolves.toEqual([]);
  });
});
