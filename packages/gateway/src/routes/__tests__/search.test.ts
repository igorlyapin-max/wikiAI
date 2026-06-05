import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchRoutes } from '../search.js';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import {
  getDefaultRetrievalProfiles,
  setRagAdminConfig,
  upsertRetrievalProfile,
  upsertTrustEntity,
  upsertTrustModel,
} from '../../services/admin-platform-config.js';
import { setMediaWikiProfileConfig } from '../../services/mediawiki-profile-config.js';
import { setRuntimeConfig } from '../../services/config.js';
import { SearchChunk } from '../../types/index.js';

const redisStore = vi.hoisted(() => new Map<string, string>());
const getEmbedding = vi.hoisted(() => vi.fn());
const searchRagChunks = vi.hoisted(() => vi.fn());
const filterReadableChunks = vi.hoisted(() => vi.fn());

vi.mock('../../services/mediawiki.js', () => ({
  fetchUserInfo: vi.fn(async () => ({
    username: 'SearchUser',
    userId: 88,
    groups: ['user', 'ai-it'],
  })),
}));

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
  },
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

describe('search routes trust filtering', () => {
  const chunks: SearchChunk[] = [
    {
      id: 1,
      pageId: 11,
      title: 'CorpIT:Черновик VPN',
      text: 'draft',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.95,
      semanticFacts: { 'Статус документа': ['Черновик'] },
    },
    {
      id: 2,
      pageId: 12,
      title: 'CorpIT:Инструкция VPN',
      text: 'approved',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.9,
      semanticFacts: { 'Статус документа': ['Утвержден'] },
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
        lexicalGateMode: 'when_bm25_available',
        vectorCandidates: 2,
        bm25Candidates: 1,
        bm25RawCandidates: 1,
        lexicalMinMatchedTerms: 2,
        lexicalRequiredMatchedTerms: 2,
        lexicalGateApplied: true,
        vectorOnlyFallbackUsed: false,
        vectorOnlyFallbackMinScore: 0.78,
      },
    });
    filterReadableChunks.mockResolvedValue(chunks);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = Fastify();
    app.decorate('rateLimit', () => async () => undefined);
    await app.register(searchRoutes);
    return app;
  }

  async function useMediaWikiVectorProfile(): Promise<void> {
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    if (!template) throw new Error('semantic_broad retrieval profile template is missing');
    await upsertRetrievalProfile({
      id: 'test_mediawiki_vector',
      name: 'Test MediaWiki vector',
      description: 'Test profile',
      enabled: true,
      apiEnabled: false,
      mcpEnabled: false,
      anonymousAllowed: false,
      maxTopK: 20,
      tags: ['test'],
      config: {
        ...template.config,
        searchMode: 'vector_only',
        rerankMode: 'none',
        colbertEnabled: false,
      },
    });
    await setMediaWikiProfileConfig({ defaultRetrievalProfileId: 'test_mediawiki_vector' });
  }

  async function useMediaWikiProfile(id: string, config: Record<string, unknown>): Promise<void> {
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    if (!template) throw new Error('semantic_broad retrieval profile template is missing');
    await upsertRetrievalProfile({
      id,
      name: id,
      description: 'Test profile',
      enabled: true,
      apiEnabled: false,
      mcpEnabled: false,
      anonymousAllowed: false,
      maxTopK: 20,
      tags: ['test'],
      config: {
        ...template.config,
        ...config,
      },
    });
    await setMediaWikiProfileConfig({ defaultRetrievalProfileId: id });
  }

  it('serves only safe UI config values', async () => {
    await useMediaWikiVectorProfile();
    await setRuntimeConfig({
      searchHistoryEnabled: false,
      searchHistoryLimit: 3,
      systemPrompt: 'secret prompt must not be exposed',
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/ui/config',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      values: {
        searchHistoryEnabled: false,
        searchHistoryLimit: 3,
        mediaWikiRetrievalProfileId: 'test_mediawiki_vector',
        mediaWikiRetrievalProfileName: 'Test MediaWiki vector',
        mediaWikiRetrievalProfileReadiness: 'limited_ready',
      },
    });
    expect(JSON.stringify(res.json())).not.toContain('secret prompt');

    await app.close();
  });

  it('returns only chunks allowed by the active trust policy', async () => {
    await useMediaWikiVectorProfile();
    await upsertTrustModel({
      id: 'corp-default',
      name: 'Corporate default',
      active: true,
      baseScore: 0.6,
      minTrustScoreForContext: 0.5,
      includeDrafts: false,
    });
    await upsertTrustEntity('corp-default', {
      id: 'approved-doc',
      entityType: 'smw_property',
      name: 'Approved document',
      value: 'Статус документа=Утвержден',
      weight: 0.2,
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: { query: 'vpn', topK: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0]).toMatchObject({
      title: 'CorpIT:Инструкция VPN',
      pageUrl: 'http://127.0.0.1:8082/index.php/CorpIT:%D0%98%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%86%D0%B8%D1%8F_VPN',
      trust: {
        modelId: 'corp-default',
        score: 0.8,
        appliedEntityIds: ['approved-doc'],
      },
    });
    expect(searchRagChunks).toHaveBeenCalledWith(expect.objectContaining({
      query: 'vpn',
      vector: [0.1, 0.2, 0.3],
      topK: 2,
      fallbackTopK: 4,
      config: expect.objectContaining({ searchMode: 'vector_only' }),
    }));
    expect(filterReadableChunks).toHaveBeenCalledWith(chunks, 'mw=1', 10);
    expect(res.json().diagnostics).toMatchObject({
      query: 'vpn',
      retrievalQuery: 'vpn',
      searchMode: 'hybrid',
      retrievalProfileId: 'test_mediawiki_vector',
      requestedTopK: 2,
      effectiveTopK: 2,
      rawChunks: 2,
      readableChunks: 2,
      trustedChunks: 1,
      finalResults: 1,
      bm25Candidates: 1,
      bm25RawCandidates: 1,
      lexicalMinMatchedTerms: 2,
      lexicalRequiredMatchedTerms: 2,
      lexicalGateApplied: true,
    });

    await app.close();
  });

  it('allows anonymous search and leaves page visibility to MediaWiki readable checks', async () => {
    await useMediaWikiVectorProfile();
    filterReadableChunks.mockResolvedValueOnce([chunks[1]]);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'vpn', topK: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: 'anonymous',
      groups: ['*'],
      diagnostics: {
        query: 'vpn',
        retrievalQuery: 'vpn',
        searchMode: 'hybrid',
        retrievalProfileId: 'test_mediawiki_vector',
        requestedTopK: 2,
        effectiveTopK: 2,
        rawChunks: 2,
        readableChunks: 1,
        trustedChunks: 1,
        finalResults: 1,
        bm25Candidates: 1,
        bm25RawCandidates: 1,
        lexicalMinMatchedTerms: 2,
        lexicalRequiredMatchedTerms: 2,
      },
      results: [
        {
          title: 'CorpIT:Инструкция VPN',
        },
      ],
    });
    expect(filterReadableChunks).toHaveBeenCalledWith(chunks, '', 10);

    await app.close();
  });

  it('does not let MediaWiki request bodies override the admin-selected retrieval profile', async () => {
    await useMediaWikiVectorProfile();

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: { cookie: 'mw=1' },
      payload: { query: 'vpn', topK: 2, retrievalProfileId: 'colbert_full_strict' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().diagnostics).toMatchObject({
      retrievalProfileId: 'test_mediawiki_vector',
      effectiveSearchMode: 'vector_only',
    });
    expect(searchRagChunks).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ searchMode: 'vector_only' }),
    }));

    await app.close();
  });

  it('rejects empty search queries before calling embeddings', async () => {
    await useMediaWikiVectorProfile();
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: '   ', topK: 2 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Query is required' });
    expect(getEmbedding).not.toHaveBeenCalled();
    await app.close();
  });

  it('reranks only readable trusted chunks with ColBERT when enabled', async () => {
    await setRagAdminConfig({
      rerankMode: 'colbert_v2',
      colbertEnabled: true,
      colbertBaseUrl: 'http://colbert.internal:8080',
      colbertModel: 'colbert-v2-multilingual',
      colbertCandidateLimit: 50,
      colbertTimeoutMs: 2500,
      colbertMinScore: 0,
      colbertFailMode: 'fallback_current',
    });
    await useMediaWikiProfile('test_mediawiki_colbert_rerank', {
      searchMode: 'vector_only',
      rerankMode: 'colbert_v2',
      colbertEnabled: true,
      colbertFailMode: 'fallback_current',
    });
    await upsertTrustModel({
      id: 'corp-default',
      name: 'Corporate default',
      active: true,
      baseScore: 0.6,
      minTrustScoreForContext: 0.5,
      includeDrafts: false,
    });
    await upsertTrustEntity('corp-default', {
      id: 'approved-doc',
      entityType: 'smw_property',
      name: 'Approved document',
      value: 'Статус документа=Утвержден',
      weight: 0.2,
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [{ id: 2, score: 0.93 }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: { cookie: 'mw=1' },
      payload: { query: 'vpn', topK: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      expect.objectContaining({
        title: 'CorpIT:Инструкция VPN',
      }),
    ]);
    expect(res.json().diagnostics).toMatchObject({
      rerankMode: 'colbert_v2',
      colbertApplied: true,
      colbertCandidates: 1,
      colbertFallbackUsed: false,
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? '{}'));
    expect(requestBody.candidates).toEqual([
      {
        id: 2,
        title: 'CorpIT:Инструкция VPN',
        text: 'approved',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://colbert.internal:8080/rerank',
      expect.objectContaining({ method: 'POST' })
    );

    await app.close();
  });

  it('uses ColBERT full index without calling the dense embedding pipeline', async () => {
    await setRagAdminConfig({
      searchMode: 'colbert_full',
      rerankMode: 'none',
      colbertEnabled: true,
      colbertBaseUrl: 'http://colbert.internal:8080',
      colbertModel: 'antoinelouis/colbert-xm',
      colbertCollection: 'wiki_colbert_chunks',
      colbertCandidateLimit: 25,
      colbertTimeoutMs: 2500,
      colbertMinScore: 0,
      colbertFailMode: 'fallback_current',
    });
    await useMediaWikiProfile('test_mediawiki_colbert_full', {
      searchMode: 'colbert_full',
      rerankMode: 'none',
      colbertEnabled: true,
      colbertFailMode: 'fallback_current',
      vectorOnlyFallbackEnabled: false,
    });
    filterReadableChunks.mockResolvedValueOnce([chunks[1]]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [{
          id: 2,
          score: 0.96,
          pageId: 12,
          title: 'CorpIT:Инструкция VPN',
          text: 'approved',
          namespace: 3030,
          allowedGroups: ['ai-it'],
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: { cookie: 'mw=1' },
      payload: { query: 'vpn', topK: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(getEmbedding).not.toHaveBeenCalled();
    expect(searchRagChunks).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://colbert.internal:8080/search',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"collection":"wiki_colbert_chunks"'),
      })
    );
    expect(res.json()).toMatchObject({
      searchMode: 'colbert_full',
      diagnostics: {
        searchMode: 'colbert_full',
        query: 'vpn',
        retrievalQuery: 'vpn',
        requestedTopK: 2,
        effectiveTopK: 2,
        rawChunks: 1,
        readableChunks: 1,
        trustedChunks: 1,
        finalResults: 1,
        colbertIndexApplied: true,
        colbertCandidates: 1,
      },
      results: [{ title: 'CorpIT:Инструкция VPN' }],
    });
    await app.close();
  });

  it('returns RuntimeHttpError payloads from ColBERT fail_search mode', async () => {
    await setRagAdminConfig({
      searchMode: 'colbert_full',
      rerankMode: 'none',
      colbertEnabled: true,
      colbertBaseUrl: 'http://colbert.internal:8080',
      colbertModel: 'antoinelouis/colbert-xm',
      colbertCollection: 'wiki_colbert_chunks',
      colbertCandidateLimit: 25,
      colbertTimeoutMs: 2500,
      colbertMinScore: 0,
      colbertFailMode: 'fail_search',
    });
    await useMediaWikiProfile('test_mediawiki_colbert_full_fail', {
      searchMode: 'colbert_full',
      rerankMode: 'none',
      colbertEnabled: true,
      colbertFailMode: 'fail_search',
      vectorOnlyFallbackEnabled: false,
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' })
      .mockResolvedValueOnce(new Response('bad gateway', {
        status: 502,
        statusText: 'Bad Gateway',
      })));

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: { cookie: 'mw=1' },
      payload: { query: 'vpn', topK: 2 },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: 'ColBERT search failed',
    });
    expect(getEmbedding).not.toHaveBeenCalled();
    await app.close();
  });
});
