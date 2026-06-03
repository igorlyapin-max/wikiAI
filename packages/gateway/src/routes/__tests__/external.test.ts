import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { externalRoutes } from '../external.js';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { setExternalApiConfig } from '../../services/external-api-config.js';
import { SearchChunk } from '../../types/index.js';
import { fetchUserInfo } from '../../services/mediawiki.js';

const redisStore = vi.hoisted(() => new Map<string, string>());
const getEmbedding = vi.hoisted(() => vi.fn());
const searchRagChunks = vi.hoisted(() => vi.fn());
const filterReadableChunks = vi.hoisted(() => vi.fn());
const prepareRuntimeChat = vi.hoisted(() => vi.fn());
const completeRuntimeChat = vi.hoisted(() => vi.fn());
const streamRuntimeChat = vi.hoisted(() => vi.fn());

vi.mock('../../services/redis.js', () => ({
  getCachedUserGroups: vi.fn(async () => null),
  cacheUserGroups: vi.fn(async () => undefined),
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    }),
    ping: vi.fn(async () => 'PONG'),
    quit: vi.fn(async () => 'OK'),
  },
}));

vi.mock('../../services/mediawiki.js', () => ({
  fetchUserInfo: vi.fn(async () => null),
  userCanRead: vi.fn(async () => true),
  userCanReadWithBearer: vi.fn(async () => true),
}));

vi.mock('../../services/embedding.js', () => ({
  getEmbedding,
}));

vi.mock('../../services/hybrid-search.js', () => ({
  searchRagChunks,
}));

vi.mock('../../services/acl.js', () => ({
  filterReadableChunks,
  filterReadableChunksForPrincipal: vi.fn(async (chunks: SearchChunk[]) => chunks),
}));

vi.mock('../../services/runtime-chat.js', () => ({
  prepareRuntimeChat,
  completeRuntimeChat,
  streamRuntimeChat,
}));

describe('external routes', () => {
  const chunks: SearchChunk[] = [
    {
      id: 1,
      pageId: 10,
      title: 'CorpCommon:Public FAQ',
      text: 'Public answer',
      namespace: 0,
      allowedGroups: ['*'],
      score: 0.9,
    },
  ];

  beforeEach(() => {
    redisStore.clear();
    resetAdminStoreForTests();
    vi.clearAllMocks();
    getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    searchRagChunks.mockResolvedValue({
      chunks,
      limit: 2,
      aclCandidateLimit: 10,
      showRawScores: false,
      mode: 'hybrid',
      diagnostics: {
        searchMode: 'hybrid',
        rerankMode: 'none',
      },
    });
    filterReadableChunks.mockResolvedValue(chunks);
    prepareRuntimeChat.mockResolvedValue({
      message: 'hello',
      principal: { username: 'Admin' },
      chunks,
    });
    completeRuntimeChat.mockResolvedValue({
      answer: 'Use MFA.',
      sources: [{ title: 'CorpIT:VPN' }],
    });
    streamRuntimeChat.mockImplementation(async (_prepared, emit) => {
      emit({ type: 'delta', text: 'Use MFA.' });
      emit('[DONE]');
    });
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = Fastify();
    app.decorate('rateLimit', () => async () => undefined);
    await app.register(externalRoutes);
    return app;
  }

  it('reports disabled capabilities by default', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      searchEnabled: false,
      mcpEnabled: false,
      anonymousSearchAllowed: true,
      aclMode: 'mediawiki_check',
    });

    await app.close();
  });

  it('runs anonymous external search through the shared runtime pipeline and clamps topK', async () => {
    await setExternalApiConfig({
      enabled: true,
      anonymousSearchAllowed: true,
      maxTopK: 2,
      aclMode: 'mediawiki_check',
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers: { origin: 'http://127.0.0.1:8082' },
      payload: { query: 'public faq', topK: 20 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authMode: 'anonymous',
      user: 'anonymous',
      groups: ['*'],
      results: [{ title: 'CorpCommon:Public FAQ' }],
    });
    expect(searchRagChunks).toHaveBeenCalledWith({
      query: 'public faq',
      vector: [0.1, 0.2, 0.3],
      topK: 2,
      fallbackTopK: 4,
    });
    expect(filterReadableChunks).toHaveBeenCalledWith(chunks, '', 10);

    await app.close();
  });

  it('rejects external search while the API is disabled', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      payload: { query: 'public faq' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'External API disabled' });

    await app.close();
  });

  it('rejects invalid external search payloads before running retrieval', async () => {
    await setExternalApiConfig({ enabled: true });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      payload: { query: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Invalid search request' });
    expect(searchRagChunks).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects invalid MediaWiki cookies when anonymous search is disabled', async () => {
    await setExternalApiConfig({
      enabled: true,
      anonymousSearchAllowed: false,
    });
    vi.mocked(fetchUserInfo).mockResolvedValueOnce(null);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers: { cookie: 'mw=expired' },
      payload: { query: 'private faq' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid or expired MediaWiki session' });
    expect(searchRagChunks).not.toHaveBeenCalled();

    await app.close();
  });

  it('runs authenticated external chat through the runtime chat pipeline', async () => {
    await setExternalApiConfig({
      enabled: true,
      maxTopK: 3,
      aclMode: 'mediawiki_check',
    });
    vi.mocked(fetchUserInfo).mockResolvedValueOnce({
      username: 'Admin',
      userId: 42,
      groups: ['sysop', 'aiadmin'],
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      headers: {
        cookie: 'mw=valid',
        origin: 'http://127.0.0.1:8082',
      },
      payload: { message: 'How do I connect VPN?', topK: 20 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      answer: 'Use MFA.',
      sources: [{ title: 'CorpIT:VPN' }],
    });
    expect(prepareRuntimeChat).toHaveBeenCalledWith(expect.objectContaining({
      message: 'How do I connect VPN?',
      topK: 20,
      maxTopK: 3,
      principal: expect.objectContaining({
        authMode: 'mediawiki_cookie',
        username: 'Admin',
        groups: ['sysop', 'aiadmin'],
      }),
    }));
    expect(completeRuntimeChat).toHaveBeenCalled();

    await app.close();
  });

  it('streams external chat responses with allowed CORS headers', async () => {
    await setExternalApiConfig({ enabled: true });
    vi.mocked(fetchUserInfo).mockResolvedValueOnce({
      username: 'Admin',
      userId: 42,
      groups: ['sysop'],
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      headers: {
        cookie: 'mw=valid',
        origin: 'http://127.0.0.1:8082',
      },
      payload: { message: 'Stream answer', stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8082');
    expect(res.body).toContain('data: {"type":"delta","text":"Use MFA."}');
    expect(res.body).toContain('data: [DONE]');

    await app.close();
  });

  it('rejects unauthenticated external chat requests', async () => {
    await setExternalApiConfig({ enabled: true });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: { message: 'Private question' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Missing authentication; OIDC is not configured',
    });
    expect(prepareRuntimeChat).not.toHaveBeenCalled();

    await app.close();
  });
});
