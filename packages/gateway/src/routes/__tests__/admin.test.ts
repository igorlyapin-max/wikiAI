import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../admin.js';
import { config } from '../../config.js';
import { getAdminStore, resetAdminStoreForTests } from '../../db/admin-store.js';
import { resetIndexingProfileSchedulerForTests } from '../../services/indexing-profile-scheduler.js';
import { resetTrustAutoRecalculationForTests } from '../../services/trust-auto-recalculation.js';
import { resetTrustRecalculationSchedulerForTests } from '../../services/trust-recalculation-scheduler.js';
import { recordChatMessage, resetChatStoreForTests } from '../../services/chat-store.js';
import { searchLexicalChunks, upsertSearchIndexPage } from '../../services/search-index.js';
import { getDefaultRetrievalProfiles, setRagAdminConfig } from '../../services/admin-platform-config.js';

const userGroups = vi.hoisted(() => ({ groups: ['sysop'] }));
const store = vi.hoisted(() => new Map<string, string>());
const qdrantGetCollection = vi.hoisted(() => vi.fn());
const qdrantScroll = vi.hoisted(() => vi.fn());
const qdrantSetPayload = vi.hoisted(() => vi.fn());
const getQdrantAttachmentDiagnostics = vi.hoisted(() => vi.fn());
const userCanRead = vi.hoisted(() => vi.fn(async () => true));
const fetchWikiCategories = vi.hoisted(() => vi.fn());
const fetchWikiNamespaces = vi.hoisted(() => vi.fn());
const fetchWikiUserGroups = vi.hoisted(() => vi.fn());
const fetchWikiTags = vi.hoisted(() => vi.fn());
const fetchWikiTemplates = vi.hoisted(() => vi.fn());
const fetchWikiPages = vi.hoisted(() => vi.fn());
const fetchSmwProperties = vi.hoisted(() => vi.fn());
const startSyncerReindex = vi.hoisted(() => vi.fn());
const getSyncerReindexStatus = vi.hoisted(() => vi.fn());
const getSyncerReindexSourceDiagnostics = vi.hoisted(() => vi.fn());
const getSyncerMediaWikiServiceAuthStatus = vi.hoisted(() => vi.fn());
const testSyncerMediaWikiServiceAuth = vi.hoisted(() => vi.fn());
const runAdminChatDebugTrace = vi.hoisted(() => vi.fn());
const getIndexStatusSummary = vi.hoisted(() => vi.fn());
const originalConfig = { ...config };

vi.mock('../../services/mediawiki.js', () => ({
  fetchUserInfo: vi.fn(async () => ({
    username: 'TestAdmin',
    userId: 42,
    groups: userGroups.groups,
  })),
  userCanRead,
  fetchWikiCategories,
  fetchWikiNamespaces,
  fetchWikiUserGroups,
  fetchWikiTags,
  fetchWikiTemplates,
  fetchWikiPages,
  fetchSmwProperties,
}));

vi.mock('../../services/redis.js', () => ({
  getCachedUserInfo: vi.fn(async () => null),
  cacheUserInfo: vi.fn(async () => undefined),
  getCachedUserGroups: vi.fn(async () => null),
  cacheUserGroups: vi.fn(async () => undefined),
  clearUserGroupCache: vi.fn(async () => {
    const keys = Array.from(store.keys()).filter((key) => key.startsWith('mw:groups:') || key.startsWith('mw:user:'));
    keys.forEach((key) => store.delete(key));
    return keys.length;
  }),
  readJson: vi.fn(async (key: string) => {
    const value = store.get(key);
    return value ? JSON.parse(value) : undefined;
  }),
  writeJson: vi.fn(async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  }),
  acquireRedisLock: vi.fn(async (key: string) => {
    if (store.has(key)) return null;
    const owner = 'test-owner';
    store.set(key, owner);
    return {
      key,
      owner,
      release: vi.fn(async () => {
        if (store.get(key) === owner) store.delete(key);
      }),
    };
  }),
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    scan: vi.fn(async (_cursor: string, _mode: string, pattern: string) => {
      const prefix = pattern === 'mw:user:*' ? 'mw:user:' : 'mw:groups:';
      return ['0', Array.from(store.keys()).filter((key) => key.startsWith(prefix))];
    }),
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach((key) => store.delete(key));
      return keys.length;
    }),
    flushdb: vi.fn(async () => {
      store.clear();
      return 'OK';
    }),
    ping: vi.fn(async () => 'PONG'),
    quit: vi.fn(async () => 'OK'),
  },
}));

vi.mock('../../services/qdrant.js', () => ({
  QDRANT_VECTOR_SIZE: 768,
  getQdrantAttachmentDiagnostics,
  qdrant: {
    getCollections: vi.fn(async () => ({ collections: [] })),
    getCollection: qdrantGetCollection,
    scroll: qdrantScroll,
    setPayload: qdrantSetPayload,
  },
}));

vi.mock('../../services/syncer-admin.js', () => ({
  startSyncerReindex,
  getSyncerReindexStatus,
  getSyncerReindexSourceDiagnostics,
  getSyncerMediaWikiServiceAuthStatus,
  testSyncerMediaWikiServiceAuth,
  isSyncerAdminError: (err: unknown) =>
    err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number',
}));

vi.mock('../../services/chat-debug-trace.js', () => ({
  runAdminChatDebugTrace,
}));

vi.mock('../../services/index-status-summary.js', () => ({
  getIndexStatusSummary,
}));

describe('admin routes', () => {
  beforeEach(() => {
    Object.assign(config, originalConfig);
    userGroups.groups = ['sysop'];
    store.clear();
    resetChatStoreForTests();
    resetAdminStoreForTests();
    resetIndexingProfileSchedulerForTests();
    resetTrustAutoRecalculationForTests();
    resetTrustRecalculationSchedulerForTests();
    qdrantGetCollection.mockReset();
    qdrantScroll.mockReset();
    qdrantSetPayload.mockReset();
    getQdrantAttachmentDiagnostics.mockReset();
    getQdrantAttachmentDiagnostics.mockResolvedValue({
      status: 'ok',
      ready: true,
      collection: 'wiki_chunks',
      filename: 'Wikiai-architecture.pptx',
      chunks: 0,
      found: false,
      samples: [],
    });
    fetchWikiCategories.mockReset();
    fetchWikiCategories.mockResolvedValue([
      { name: 'ИТ', title: 'Category:ИТ' },
      { name: 'Регламенты', title: 'Category:Регламенты' },
    ]);
    fetchWikiNamespaces.mockReset();
    fetchWikiNamespaces.mockResolvedValue([
      { id: 0, name: '', displayName: 'Main', content: true },
      { id: 3030, name: 'CorpIT', displayName: 'CorpIT', content: true },
    ]);
    fetchWikiUserGroups.mockReset();
    fetchWikiUserGroups.mockResolvedValue([
      { name: 'sysop', displayName: 'sysop' },
      { name: 'hr', displayName: 'hr' },
    ]);
    fetchWikiTags.mockReset();
    fetchWikiTags.mockResolvedValue([
      { name: 'verified', displayName: 'verified', active: true },
    ]);
    fetchWikiTemplates.mockReset();
    fetchWikiTemplates.mockResolvedValue([
      { name: 'ApprovedDocument', title: 'Template:ApprovedDocument' },
    ]);
    fetchWikiPages.mockReset();
    fetchWikiPages.mockResolvedValue([
      { title: 'CorpIT:Инструкция VPN', namespace: 3030, pageId: 1001 },
    ]);
    fetchSmwProperties.mockReset();
    fetchSmwProperties.mockResolvedValue({
      values: [
        { name: 'Департамент', title: 'Свойство:Департамент', type: 'Text', description: 'Департамент-владелец документа.' },
        { name: 'Дата действия', title: 'Свойство:Дата действия', type: 'Date', description: 'Дата вступления в действие.' },
      ],
      nextContinue: 'Дата_действия',
      count: 2,
    });
    qdrantGetCollection.mockResolvedValue({
      points_count: 299,
      indexed_vectors_count: 0,
      config: { params: { vectors: { size: 768, distance: 'Cosine' } } },
    });
    userCanRead.mockClear();
    startSyncerReindex.mockReset();
    getSyncerReindexStatus.mockReset();
    getSyncerReindexSourceDiagnostics.mockReset();
    getSyncerReindexSourceDiagnostics.mockResolvedValue({
      values: {
        source: 'qdrant_payload',
        mediaWikiNamespaces: [0],
        mediaWikiPages: 102,
        denseCollection: 'wiki_chunks',
        qdrantPayloadPoints: 1,
        qdrantPayloadPages: 1,
        qdrantPayloadGroups: 1,
        qdrantPayloadChunks: 1,
        densePagesBehindMediaWiki: true,
      },
    });
    getSyncerMediaWikiServiceAuthStatus.mockReset();
    getSyncerMediaWikiServiceAuthStatus.mockResolvedValue({
      configured: true,
      source: 'service_credentials',
      usernameConfigured: true,
      passwordConfigured: true,
      passwordUsesSecretReference: true,
      pamProviderConfigured: true,
      deprecatedCookieConfigured: false,
    });
    testSyncerMediaWikiServiceAuth.mockReset();
    testSyncerMediaWikiServiceAuth.mockResolvedValue({
      status: 'ok',
      auth: {
        configured: true,
        source: 'service_credentials',
        usernameConfigured: true,
        passwordConfigured: true,
        passwordUsesSecretReference: true,
        pamProviderConfigured: true,
        deprecatedCookieConfigured: false,
      },
      user: {
        username: 'WikiAISync',
        userId: 100,
        groups: ['ai-exec'],
      },
    });
    runAdminChatDebugTrace.mockReset();
    runAdminChatDebugTrace.mockResolvedValue({
      traceId: 'chat-debug-test',
      verbosity: 'full',
      answer: 'Debug answer',
      diagnostics: { retrievalQuery: 'Как подключить VPN?' },
      finalLlm: {
        trace: {
          request: {
            method: 'POST',
            url: 'http://llm.local/v1/chat/completions',
            timeoutMs: 30000,
            headers: { Authorization: 'Bearer [redacted]' },
            body: { messages: [{ role: 'user', content: 'Как подключить VPN?' }] },
          },
        },
        request: { body: { messages: [{ role: 'user', content: 'Как подключить VPN?' }] } },
        response: { choices: [{ message: { content: 'Debug answer' } }] },
      },
      retrieval: { chunks: { context: [] }, attachmentIndexCoverage: [] },
      promptStack: [{ index: 1, role: 'user', label: 'current user question', chars: 18, content: 'Как подключить VPN?' }],
      promptText: '### 1. user\nКак подключить VPN?',
    });
    getIndexStatusSummary.mockReset();
    getIndexStatusSummary.mockResolvedValue({
      status: 'warning',
      source: {
        status: 'ok',
        namespaces: [0],
        pages: 103,
        fetchedPages: 103,
        truncated: false,
      },
      indexes: {
        dense: { status: 'ok', collection: 'wiki_chunks', pages: 103, chunks: 105, points: 105 },
        colbert: {
          status: 'ok',
          collection: 'wiki_colbert_chunks',
          chunks: 105,
          points: 105,
          state: 'completed',
          source: 'live_health',
          lastReindexIncludedColbert: false,
        },
        bm25: {
          status: 'warning',
          pages: 185,
          chunks: 650,
          diff: {
            staleCount: 82,
            missingCount: 0,
            staleSamples: [{ pageId: 11, title: 'Old page', chunks: 4 }],
            missingSamples: [],
            sourceTruncated: false,
            indexTruncated: false,
          },
        },
        opensearch: { status: 'warning', enabled: true, ready: true, indexName: 'wikiai_chunks', pages: 183, docs: 644 },
        trigram: { status: 'warning', chunks: 645, expectedChunks: 650, backfillRequired: true },
      },
      lastReindex: { status: { state: 'completed' } },
      recommendations: ['Run BM25/OpenSearch rebuild or full all-index reindex.'],
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeApp(): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify();
    await app.register(adminRoutes);
    return app;
  }

  it('allows sysop and aiadmin users', async () => {
    const app = await makeApp();
    const sysop = await app.inject({ method: 'GET', url: '/api/admin/config', headers: { cookie: 'mw=1' } });
    expect(sysop.statusCode).toBe(200);

    userGroups.groups = ['aiadmin'];
    const aiadmin = await app.inject({ method: 'GET', url: '/api/admin/config', headers: { cookie: 'mw=2' } });
    expect(aiadmin.statusCode).toBe(200);

    await app.close();
  });

  it('rejects non-admin users', async () => {
    userGroups.groups = ['user'];
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/admin/config', headers: { cookie: 'mw=1' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('reports limited readiness when BM25 exists but ColBERT is disabled', async () => {
    await upsertSearchIndexPage({
      pageId: 1,
      title: 'Public',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{ id: 10000, text: 'Public search chunk', chunkIndex: 0, totalChunks: 1 }],
    });
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/search-index/status',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values.readiness).toMatchObject({
      status: 'limited_ready',
    });
    await app.close();
  });

  it('reports production readiness when BM25 and ColBERT health are ready', async () => {
    await upsertSearchIndexPage({
      pageId: 1,
      title: 'Public',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{ id: 10000, text: 'Public search chunk', chunkIndex: 0, totalChunks: 1 }],
    });
    await setRagAdminConfig({
      colbertEnabled: true,
      colbertBaseUrl: 'http://colbert:8080',
      searchMode: 'colbert_full',
      colbertFailMode: 'fail_search',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'antoinelouis/colbert-xm',
        collection: 'wiki_colbert_chunks',
        collectionStatus: { exists: true, points: 1, vectors: 1 },
      }),
    })));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/search-index/status',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values.readiness).toMatchObject({
      status: 'prod_ready',
    });
    await app.close();
  });

  it('returns degraded admin health as JSON instead of failing the overview request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })));

    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/admin/health', headers: { cookie: 'mw=1' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      checks: {
        litellm: { status: 'error' },
      },
    });
    await app.close();
  });

  it('serves document processing config', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/document-processing',
      headers: { cookie: 'mw=1' },
      payload: { mimeTypes: { 'application/pdf': { mode: 'metadata' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.mimeTypes['application/pdf'].mode).toBe('metadata');
    await app.close();
  });

  it('serves redacted service config and saves desired overrides', async () => {
    const app = await makeApp();
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/service-config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().metadata.secretsRedacted).toBe(true);
    expect(read.json().values.llm.apiKeyConfigured).toBe(true);
    expect(read.json().values.opensearch).toMatchObject({
      enabled: false,
      indexName: 'wikiai_chunks',
      authConfigured: false,
    });
    expect(read.json().values.syncer.mediaWikiServiceAuth).toMatchObject({
      configured: true,
      source: 'service_credentials',
      passwordUsesSecretReference: true,
      pamProviderConfigured: true,
    });
    expect(JSON.stringify(read.json())).not.toContain('test-key');
    expect(JSON.stringify(read.json())).not.toContain('WikiAISyncPassword');

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/service-config',
      headers: { cookie: 'mw=1' },
      payload: {
        mediaWiki: { baseUrl: 'http://wiki.internal:8082' },
        llm: { model: 'corporate-test-model', timeoutMs: 10000 },
        opensearch: {
          enabled: true,
          baseUrl: 'http://opensearch.internal:9200',
          indexName: 'wikiai_chunks_v2',
          analyzer: 'russian',
          candidateLimit: 75,
        },
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().values.mediaWiki.baseUrl).toBe('http://wiki.internal:8082');
    expect(saved.json().values.llm.model).toBe('corporate-test-model');
    expect(saved.json().values.opensearch).toMatchObject({
      enabled: true,
      baseUrl: 'http://opensearch.internal:9200/',
      indexName: 'wikiai_chunks_v2',
      candidateLimit: 75,
    });

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { cookie: 'mw=1' },
    });

    expect(audit.statusCode).toBe(200);
    expect(audit.json().values[0]).toMatchObject({
      actor: 'TestAdmin',
      action: 'service-config.update',
      entityType: 'service-config',
    });
    await app.close();
  });

  it('defaults an enabled OpenSearch config when the URL field is empty', async () => {
    const app = await makeApp();

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/service-config',
      headers: { cookie: 'mw=1' },
      payload: {
        opensearch: {
          enabled: true,
          baseUrl: '',
          indexName: 'wikiai_chunks',
        },
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().values.opensearch).toMatchObject({
      enabled: true,
      baseUrl: 'http://opensearch:9200/',
    });

    await app.close();
  });

  it('serves the compose OpenSearch URL for legacy empty overrides', async () => {
    await getAdminStore().setJson('service-config', 'default', {
      opensearch: {
        enabled: true,
        baseUrl: '',
        indexName: 'wikiai_chunks',
      },
    });
    const app = await makeApp();

    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/service-config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().values.opensearch).toMatchObject({
      enabled: true,
      baseUrl: 'http://opensearch:9200/',
    });

    await app.close();
  });

  it('serves OpenSearch status and analyze preview without exposing secrets', async () => {
    const app = await makeApp();
    await upsertSearchIndexPage({
      pageId: 104,
      title: 'CorpCommon:Приказы/Режим рабочего времени',
      namespace: 6,
      allowedGroups: ['*'],
      chunks: [{
        id: 10450000,
        text: 'Архитектурный WikiAI: AI-платформа знаний поверх MediaWiki.',
        sourceType: 'attachment',
        attachmentFilename: 'Wikiai-architecture.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        processingMode: 'text',
      }],
    });
    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/opensearch/status',
      headers: { cookie: 'mw=1' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().values).toMatchObject({
      status: 'disabled',
      ready: false,
      indexName: 'wikiai_chunks',
    });

    const analyze = await app.inject({
      method: 'POST',
      url: '/api/admin/opensearch/analyze',
      headers: { cookie: 'mw=1' },
      payload: { query: 'как там цивилизации' },
    });
    expect(analyze.statusCode).toBe(200);
    expect(analyze.json().values).toMatchObject({
      status: 'disabled',
      tokens: ['как', 'там', 'цивилизации'],
    });
    const attachmentDiagnostics = await app.inject({
      method: 'POST',
      url: '/api/admin/opensearch/attachment-diagnostics',
      headers: { cookie: 'mw=1' },
      payload: { filename: 'Wikiai-architecture.pptx' },
    });
    expect(attachmentDiagnostics.statusCode).toBe(200);
    expect(attachmentDiagnostics.json().values).toMatchObject({
      mismatch: true,
      searchIndex: {
        chunks: 1,
        found: true,
      },
      opensearch: {
        status: 'disabled',
        found: false,
      },
      qdrant: {
        status: 'ok',
        found: false,
      },
    });
    expect(JSON.stringify(status.json())).not.toContain('test-key');
    await app.close();
  });

  it('keeps OpenSearch admin routes registered even without a session cookie', async () => {
    const app = await makeApp();

    for (const request of [
      { method: 'GET' as const, url: '/api/admin/opensearch/status' },
      { method: 'POST' as const, url: '/api/admin/opensearch/analyze', payload: { query: 'как там цивилизации' } },
      { method: 'POST' as const, url: '/api/admin/opensearch/search-preview', payload: { query: 'как там цивилизации', limit: 3 } },
      { method: 'POST' as const, url: '/api/admin/opensearch/attachment-diagnostics', payload: { filename: 'Wikiai-architecture.pptx' } },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('Route');
    }

    await app.close();
  });

  it('rejects invalid service config', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/service-config',
      headers: { cookie: 'mw=1' },
      payload: { mediaWiki: { baseUrl: 'not-a-url' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid service config');
    await app.close();
  });

  it('serves MediaWiki categories for indexing selectors', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/wiki/categories?search=%D0%98%D0%A2&limit=25',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toEqual([
      { name: 'ИТ', title: 'Category:ИТ' },
      { name: 'Регламенты', title: 'Category:Регламенты' },
    ]);
    expect(fetchWikiCategories).toHaveBeenCalledWith({
      search: 'ИТ',
      limit: 25,
      sessionCookie: 'mw=1',
    });
    await app.close();
  });

  it('serves MediaWiki reference dictionaries for trust selectors', async () => {
    const app = await makeApp();
    const headers = { cookie: 'mw=1' };

    const namespaces = await app.inject({ method: 'GET', url: '/api/admin/wiki/namespaces', headers });
    const groups = await app.inject({ method: 'GET', url: '/api/admin/wiki/user-groups', headers });
    const tags = await app.inject({ method: 'GET', url: '/api/admin/wiki/tags?search=ver&limit=25', headers });
    const templates = await app.inject({ method: 'GET', url: '/api/admin/wiki/templates?search=Approved&limit=25', headers });
    const pages = await app.inject({ method: 'GET', url: '/api/admin/wiki/pages?search=CorpIT&limit=25', headers });
    const smwProperties = await app.inject({ method: 'GET', url: '/api/admin/smw/properties?search=%D0%94&limit=25', headers });
    const nextSmwProperties = await app.inject({ method: 'GET', url: '/api/admin/smw/properties?limit=25&continue=%D0%94%D0%B0%D1%82%D0%B0_%D0%B4%D0%B5%D0%B9%D1%81%D1%82%D0%B2%D0%B8%D1%8F', headers });

    expect(namespaces.statusCode).toBe(200);
    expect(namespaces.json().values[1]).toMatchObject({ id: 3030, displayName: 'CorpIT' });
    expect(groups.statusCode).toBe(200);
    expect(groups.json().values[1]).toMatchObject({ name: 'hr' });
    expect(tags.statusCode).toBe(200);
    expect(tags.json().values[0]).toMatchObject({ name: 'verified' });
    expect(templates.statusCode).toBe(200);
    expect(templates.json().values[0]).toMatchObject({ name: 'ApprovedDocument' });
    expect(pages.statusCode).toBe(200);
    expect(pages.json().values[0]).toMatchObject({ title: 'CorpIT:Инструкция VPN' });
    expect(smwProperties.statusCode).toBe(200);
    expect(smwProperties.json().values[0]).toMatchObject({ name: 'Департамент', type: 'Text' });
    expect(smwProperties.json()).toMatchObject({ nextContinue: 'Дата_действия', count: 2 });
    expect(nextSmwProperties.statusCode).toBe(200);
    expect(fetchWikiNamespaces).toHaveBeenCalledWith({ sessionCookie: 'mw=1' });
    expect(fetchWikiUserGroups).toHaveBeenCalledWith({ sessionCookie: 'mw=1' });
    expect(fetchWikiTags).toHaveBeenCalledWith({ search: 'ver', limit: 25, sessionCookie: 'mw=1' });
    expect(fetchWikiTemplates).toHaveBeenCalledWith({ search: 'Approved', limit: 25, sessionCookie: 'mw=1' });
    expect(fetchWikiPages).toHaveBeenCalledWith({ search: 'CorpIT', limit: 25, sessionCookie: 'mw=1' });
    expect(fetchSmwProperties).toHaveBeenCalledWith({ search: 'Д', limit: 25, continue: undefined, sessionCookie: 'mw=1' });
    expect(fetchSmwProperties).toHaveBeenCalledWith({ search: undefined, limit: 25, continue: 'Дата_действия', sessionCookie: 'mw=1' });
    await app.close();
  });

  it('reports Qdrant collection vector diagnostics in service config test', async () => {
    qdrantGetCollection.mockResolvedValueOnce({
      points_count: 42,
      indexed_vectors_count: 40,
      config: { params: { vectors: { size: 512, distance: 'Cosine' } } },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/service-config/test',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values.qdrant).toMatchObject({
      status: 'error',
      url: 'http://localhost:6333',
      collection: 'test_chunks',
      expectedVectorSize: 768,
      vectorSize: 512,
      vectorSizeCompatible: false,
      pointsCount: 42,
      indexedVectorsCount: 40,
    });
    expect(res.json().values.mediaWikiServiceAuth).toMatchObject({
      status: 'ok',
      auth: {
        source: 'service_credentials',
        passwordUsesSecretReference: true,
      },
      user: {
        username: 'WikiAISync',
      },
    });
    await app.close();
  });

  it('serves and saves redacted LLM config', async () => {
    const app = await makeApp();
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/llm/config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().values).toMatchObject({
      provider: 'openai-compatible',
      model: 'test-model',
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(read.json())).not.toContain('test-key');

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/config',
      headers: { cookie: 'mw=1' },
      payload: {
        baseUrl: 'http://llm.internal:4000/v1',
        model: 'corporate-llm',
        timeoutMs: 12000,
        temperature: 0.2,
        maxTokens: 512,
        showSources: false,
        systemPrompt: 'Ответь кратко по корпоративной базе знаний.',
        searchHistoryEnabled: false,
        searchHistoryLimit: 3,
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().values).toMatchObject({
      baseUrl: 'http://llm.internal:4000/v1',
      model: 'corporate-llm',
      timeoutMs: 12000,
      temperature: 0.2,
      maxTokens: 512,
      showSources: false,
      searchHistoryEnabled: false,
      searchHistoryLimit: 3,
    });

    const runtime = await app.inject({
      method: 'GET',
      url: '/api/admin/config',
      headers: { cookie: 'mw=1' },
    });

    expect(runtime.json().values).toMatchObject({
      litellmModel: 'corporate-llm',
      timeoutMs: 12000,
      temperature: 0.2,
      maxTokens: 512,
      showSources: false,
      searchHistoryEnabled: false,
      searchHistoryLimit: 3,
    });

    await app.close();
  });

  it('runs LLM diagnostics against the configured OpenAI-compatible URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/admin/llm/config',
      headers: { cookie: 'mw=1' },
      payload: {
        baseUrl: 'http://llm.internal:4000/v1',
        model: 'diagnostic-model',
      },
    });

    const test = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/test',
      headers: { cookie: 'mw=1' },
    });

    expect(test.statusCode).toBe(200);
    expect(test.json().values).toMatchObject({
      status: 'ok',
      url: 'http://llm.internal:4000/v1/chat/completions',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm.internal:4000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      })
    );
    await app.close();
  });

  it('runs one-shot admin chat debug trace without exposing it to non-admin users', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/chat/debug-trace',
      headers: { cookie: 'mw=1' },
      payload: {
        message: 'Как подключить VPN?',
        retrievalProfileId: 'prod_hybrid_colbert',
        topK: 5,
        verbosity: 'full',
        runConflictDetection: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      traceId: 'chat-debug-test',
      answer: 'Debug answer',
      promptText: expect.stringContaining('Как подключить VPN?'),
    });
    expect(res.json().metadata).toMatchObject({
      paidApiPossible: true,
      sideEffects: 'dry-run',
    });
    expect(runAdminChatDebugTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Как подключить VPN?',
        verbosity: 'full',
      }),
      expect.objectContaining({
        principal: expect.objectContaining({
          username: 'TestAdmin',
          authMode: 'mediawiki_cookie',
        }),
      })
    );

    userGroups.groups = ['user'];
    const denied = await app.inject({
      method: 'POST',
      url: '/api/admin/chat/debug-trace',
      headers: { cookie: 'mw=2' },
      payload: { message: 'Нет доступа' },
    });
    expect(denied.statusCode).toBe(403);

    await app.close();
  });

  it('serves saves and tests conflict detection config with an explicit paid opt-in', async () => {
    const app = await makeApp();
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/conflict-detection/config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().values).toMatchObject({
      enabled: true,
      runMode: 'risk_only',
      attachmentParentConflictMode: 'risk_only',
      model: 'test-model',
      systemPrompt: expect.stringContaining('wiki-источники на противоречия'),
      showConflictBlock: true,
    });
    expect(read.json().metadata.paidApiPossible).toBe(true);

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/conflict-detection/config',
      headers: { cookie: 'mw=1' },
      payload: {
        enabled: true,
        runMode: 'manual',
        attachmentParentConflictMode: 'always',
        model: 'conflict-checker',
        systemPrompt: 'Проверяй только прямые несовместимые утверждения. Верни JSON.',
        maxSources: 3,
        maxCharsPerSource: 800,
        trustGapThreshold: 0.2,
        lowConfidenceThreshold: 0.65,
        showConflictBlock: false,
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().values).toMatchObject({
      runMode: 'manual',
      attachmentParentConflictMode: 'always',
      model: 'conflict-checker',
      systemPrompt: 'Проверяй только прямые несовместимые утверждения. Верни JSON.',
      maxSources: 3,
      maxCharsPerSource: 800,
      trustGapThreshold: 0.2,
      lowConfidenceThreshold: 0.65,
      showConflictBlock: false,
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                hasConflict: true,
                confidence: 0.9,
                summary: 'VPN MFA conflict.',
                conflictingSources: [{ sourceIndex: 1, claim: 'MFA required.' }],
                recommendedSourceIndex: 1,
              }),
            },
          },
        ],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const test = await app.inject({
      method: 'POST',
      url: '/api/admin/conflict-detection/test',
      headers: { cookie: 'mw=1' },
    });

    expect(test.statusCode).toBe(200);
    expect(test.json().values).toMatchObject({
      checked: true,
      hasConflict: true,
      confidence: 0.9,
      recommendedSourceTitle: 'CorpIT:Инструкция VPN',
    });
    expect(test.json().metadata.paidApiPossible).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    );
    await app.close();
  });

  it('serves, saves and tests embedding config without OpenAI', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/config',
      headers: { cookie: 'mw=1' },
      payload: {
        provider: 'ollama',
        baseUrl: 'http://ollama.internal:11434',
        model: 'nomic-embed-text',
        dimensions: 768,
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().values).toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://ollama.internal:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
      apiKeyConfigured: false,
    });

    const test = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/test',
      headers: { cookie: 'mw=1' },
    });

    expect(test.statusCode).toBe(200);
    expect(test.json().values.lastTest).toMatchObject({
      status: 'ok',
      url: 'http://ollama.internal:11434/api/embeddings',
      httpStatus: 200,
      dimension: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.internal:11434/api/embeddings',
      expect.objectContaining({ method: 'POST' })
    );
    await app.close();
  });

  it('serves, saves and tests OpenAI-compatible embedding config', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.4, 0.5, 0.6, 0.7] }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/config',
      headers: { cookie: 'mw=1' },
      payload: {
        provider: 'openai_compatible',
        baseUrl: 'http://litellm.internal:4000/v1',
        model: 'text-embedding-3-small',
        dimensions: 768,
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().values).toMatchObject({
      provider: 'openai_compatible',
      baseUrl: 'http://litellm.internal:4000/v1',
      model: 'text-embedding-3-small',
      dimensions: 768,
    });

    const test = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/test',
      headers: { cookie: 'mw=1' },
    });

    expect(test.statusCode).toBe(200);
    expect(test.json().metadata.paidApiPossible).toBe(true);
    expect(test.json().values.lastTest).toMatchObject({
      status: 'ok',
      url: 'http://litellm.internal:4000/v1/embeddings',
      httpStatus: 200,
      dimension: 4,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://litellm.internal:4000/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'embedding healthcheck',
          dimensions: 768,
        }),
      })
    );
    await app.close();
  });

  it('serves internal embedding vectors for Syncer through the effective provider', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.8, 0.9] }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/config',
      headers: { cookie: 'mw=1' },
      payload: {
        provider: 'openai_compatible',
        baseUrl: 'http://litellm.internal:4000/v1',
        model: 'text-embedding-3-small',
        dimensions: 768,
      },
    });

    const vector = await app.inject({
      method: 'POST',
      url: '/api/internal/embedding/vector',
      payload: { text: 'Corporate page text' },
    });

    expect(vector.statusCode).toBe(200);
    expect(vector.json().values).toMatchObject({
      vector: [0.8, 0.9],
      provider: 'openai_compatible',
      model: 'text-embedding-3-small',
      dimensions: 2,
    });
    expect(vector.json().metadata.paidApiPossible).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://litellm.internal:4000/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'Corporate page text',
          dimensions: 768,
        }),
      })
    );
    await app.close();
  });

  it('serves internal LLM enrichment for Syncer reindex', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'VPN access requires MFA.',
                keywords: ['VPN', 'MFA'],
              }),
            },
          },
        ],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const enrichment = await app.inject({
      method: 'POST',
      url: '/api/internal/reindex/llm-enrich',
      payload: {
        title: 'CorpIT:VPN',
        text: 'VPN access policy body.',
        model: 'gpt-4.1-mini',
        maxChars: 1200,
      },
    });

    expect(enrichment.statusCode).toBe(200);
    expect(enrichment.json().values).toMatchObject({
      summary: 'VPN access requires MFA.',
      keywords: ['VPN', 'MFA'],
      model: 'gpt-4.1-mini',
      inputChars: 'VPN access policy body.'.length,
    });
    expect(enrichment.json().metadata.paidApiPossible).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"gpt-4.1-mini"'),
      })
    );
    await app.close();
  });

  it('saves RAG config and syncs compatible runtime fields', async () => {
    await upsertSearchIndexPage({
      pageId: 900,
      title: 'Trigram ready',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{ id: 9000001, text: 'Trigram readiness chunk' }],
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/config',
      headers: { cookie: 'mw=1' },
      payload: {
        topK: 7,
        chunkSize: 640,
        chunkOverlap: 80,
        maxContextChunks: 7,
        searchMode: 'hybrid',
        rerankMode: 'colbert_v2',
        lexicalBackend: 'opensearch',
        vectorWeight: 0.6,
        lexicalWeight: 0.4,
        vectorCandidateLimit: 80,
        lexicalCandidateLimit: 60,
        lexicalMinMatchedTerms: 3,
        lexicalGateMode: 'when_bm25_available',
        lexicalNormalizationMode: 'simple_stem',
        lexicalSynonymsEnabled: true,
        lexicalSynonyms: [{ term: 'тикет', synonyms: ['заявка', 'инцидент'] }],
        lexicalTransliterationEnabled: true,
        lexicalEditDistanceEnabled: true,
        trigramIndexEnabled: true,
        trigramCandidateLimit: 70,
        trigramMinQueryLength: 5,
        vectorOnlyFallbackEnabled: true,
        vectorOnlyFallbackMinScore: 0.82,
        minFinalScore: 0.1,
        showRawScores: true,
        colbertEnabled: true,
        colbertBaseUrl: 'http://colbert.internal:8080',
        colbertModel: 'colbert-v2-multilingual',
        colbertCandidateLimit: 40,
        colbertTimeoutMs: 3000,
        colbertMinScore: 0.05,
        colbertTailDropEnabled: true,
        colbertTailMaxGap: 0.18,
        colbertTailMinScore: 0.72,
        colbertTailMinKeep: 2,
        colbertFailMode: 'fallback_current',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      retrievalTopK: 7,
      contextTopK: 7,
      contextMaxChars: 12000,
      topK: 7,
      chunkSize: 640,
      chunkOverlap: 80,
      chunkingPolicy: expect.objectContaining({
        sources: expect.objectContaining({
          wiki_page: expect.objectContaining({ chunkSize: 800, chunkOverlap: 120 }),
          attachment_text: expect.objectContaining({ chunkSize: 1200, chunkOverlap: 180 }),
        }),
        namespaceOverrides: {},
      }),
      maxContextChunks: 7,
      searchMode: 'hybrid',
      rerankMode: 'colbert_v2',
      lexicalBackend: 'opensearch',
      vectorWeight: 0.6,
      lexicalWeight: 0.4,
      vectorCandidateLimit: 80,
      lexicalCandidateLimit: 60,
      lexicalMinMatchedTerms: 3,
      lexicalGateMode: 'when_bm25_available',
      lexicalNormalizationMode: 'simple_stem',
      lexicalSynonymsEnabled: true,
      lexicalSynonyms: [{ term: 'тикет', synonyms: ['заявка', 'инцидент'] }],
      lexicalTransliterationEnabled: true,
      lexicalEditDistanceEnabled: true,
      trigramIndexEnabled: true,
      trigramCandidateLimit: 70,
      trigramMinQueryLength: 5,
      vectorOnlyFallbackEnabled: true,
      vectorOnlyFallbackMinScore: 0.82,
      minFinalScore: 0.1,
      showRawScores: true,
      colbertEnabled: true,
      colbertBaseUrl: 'http://colbert.internal:8080',
      colbertModel: 'colbert-v2-multilingual',
      colbertCandidateLimit: 40,
      colbertTimeoutMs: 3000,
      colbertMinScore: 0.05,
      colbertTailDropEnabled: true,
      colbertTailMaxGap: 0.18,
      colbertTailMinScore: 0.72,
      colbertTailMinKeep: 2,
      colbertFailMode: 'fallback_current',
    });

    const runtime = await app.inject({
      method: 'GET',
      url: '/api/admin/config',
      headers: { cookie: 'mw=1' },
    });

    expect(runtime.json().values).toMatchObject({
      topK: 7,
      chunkSize: 640,
      chunkOverlap: 80,
    });
    await app.close();
  });

  it('lists and restores retrieval profile examples with readiness', async () => {
    const app = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'prod_hybrid_colbert',
        config: expect.objectContaining({
          retrievalTopK: expect.any(Number),
          contextTopK: expect.any(Number),
          contextMaxChars: expect.any(Number),
          chatRetrievalQueryMode: 'current_message',
        }),
        readiness: expect.objectContaining({ status: 'not_ready' }),
      }),
      expect.objectContaining({
        id: 'semantic_broad',
        readiness: expect.objectContaining({ status: expect.any(String) }),
      }),
    ]));

    const restored = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-profiles/restore-defaults',
      headers: { cookie: 'mw=1' },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().values.map((profile: { id: string }) => profile.id)).toContain('colbert_full_strict');

    await app.close();
  });

  it('saves retrieval profile runtime limits with canonical and legacy aliases', async () => {
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    expect(template).toBeDefined();

    const app = await makeApp();
    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'custom_runtime_limits',
        name: 'Custom runtime limits',
        description: 'Regression profile for retrieval/context limits',
        enabled: true,
        apiEnabled: true,
        mcpEnabled: true,
        anonymousAllowed: false,
        maxTopK: 20,
        tags: ['test'],
        config: {
          ...template!.config,
          retrievalTopK: 8,
          contextTopK: 3,
          contextMaxChars: 9000,
          chatRetrievalQueryMode: 'history_augmented',
          topK: 8,
          maxContextChunks: 3,
          maxContextChars: 9000,
          systemPrompt: 'Profile answer prompt. Use only selected sources.',
          conflictSystemPrompt: 'Profile conflict detector prompt. Return JSON only.',
        },
      },
    });

    expect(saved.statusCode).toBe(200);
    const profile = saved.json().values.find((item: { id: string }) => item.id === 'custom_runtime_limits');
    expect(profile.config).toMatchObject({
      retrievalTopK: 8,
      contextTopK: 3,
      contextMaxChars: 9000,
      chatRetrievalQueryMode: 'history_augmented',
      topK: 8,
      maxContextChunks: 3,
      maxContextChars: 9000,
      systemPrompt: 'Profile answer prompt. Use only selected sources.',
      conflictSystemPrompt: 'Profile conflict detector prompt. Return JSON only.',
    });

    const invalidMode = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'custom_bad_history_mode',
        name: 'Custom bad history mode',
        config: {
          ...template!.config,
          chatRetrievalQueryMode: 'auto',
        },
      },
    });

    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json().error).toBe('Invalid retrieval profile');
    expect(invalidMode.json().message).toContain('chatRetrievalQueryMode');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'custom_bad_runtime_limits',
        name: 'Custom bad runtime limits',
        config: {
          ...template!.config,
          badField: true,
        },
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('Invalid retrieval profile');
    expect(invalid.json().message).toContain('badField');

    await app.close();
  });

  it('manages chat profiles and links them to retrieval profiles', async () => {
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    expect(template).toBeDefined();

    const app = await makeApp();
    const defaults = await app.inject({
      method: 'GET',
      url: '/api/admin/chat-management/config',
      headers: { cookie: 'mw=1' },
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      values: { defaultChatProfileId: 'chat_current_session' },
      selectedProfile: expect.objectContaining({ id: 'chat_current_session' }),
      chatProfiles: expect.arrayContaining([
        expect.objectContaining({ id: 'chat_followup_questions' }),
      ]),
    });

    const profileSave = await app.inject({
      method: 'POST',
      url: '/api/admin/chat-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'chat_followup_questions',
        name: 'Follow-up questions',
        description: 'Use previous user questions for retrieval.',
        enabled: true,
        defaultForChat: true,
        experimental: false,
        promptHistoryScope: 'current_session',
        promptHistoryTurns: 5,
        retrievalHistoryMode: 'current_session_questions',
        retrievalHistoryTurns: 3,
        maxPromptHistoryChars: 16000,
        maxRetrievalHistoryChars: 1800,
      },
    });
    expect(profileSave.statusCode).toBe(200);
    expect(profileSave.json().values.defaultChatProfileId).toBe('chat_followup_questions');

    const managementSave = await app.inject({
      method: 'POST',
      url: '/api/admin/chat-management/config',
      headers: { cookie: 'mw=1' },
      payload: { defaultChatProfileId: 'chat_current_session' },
    });
    expect(managementSave.statusCode).toBe(200);
    expect(managementSave.json().selectedProfile).toMatchObject({ id: 'chat_current_session' });

    const retrievalSave = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'custom_chat_profile_link',
        name: 'Custom chat profile link',
        description: 'Regression profile with chat profile',
        enabled: true,
        apiEnabled: true,
        mcpEnabled: true,
        anonymousAllowed: false,
        maxTopK: 20,
        chatProfileId: 'chat_followup_questions',
        tags: ['test'],
        config: {
          ...template!.config,
          chatRetrievalQueryMode: 'current_message',
        },
      },
    });
    expect(retrievalSave.statusCode).toBe(200);
    const linked = retrievalSave.json().values.find((item: { id: string }) => item.id === 'custom_chat_profile_link');
    expect(linked).toMatchObject({
      chatProfileId: 'chat_followup_questions',
      chatProfile: expect.objectContaining({
        id: 'chat_followup_questions',
        retrievalHistoryMode: 'current_session_questions',
      }),
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'custom_missing_chat_profile',
        name: 'Missing chat profile',
        chatProfileId: 'missing_chat_profile',
        config: template!.config,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain('Chat profile not found or disabled');

    await app.close();
  });

  it('merges missing default retrieval profiles into stale stored profile lists', async () => {
    const defaults = await getDefaultRetrievalProfiles();
    const semanticBroad = defaults.find((profile) => profile.id === 'semantic_broad');
    expect(semanticBroad).toBeDefined();
    await getAdminStore().setJson('retrieval-profiles', 'default', [semanticBroad!]);

    const app = await makeApp();
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/mediawiki-profile/config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    const ids = read.json().retrievalProfiles.map((profile: { id: string }) => profile.id);
    expect(ids).toContain('semantic_broad');
    expect(ids).toContain('opensearch_hybrid');
    expect(ids).toContain('opensearch_hybrid_colbert');
    expect(read.json().selectedProfile).toMatchObject({ id: 'opensearch_hybrid_colbert' });
    const openSearchColbert = read.json().retrievalProfiles.find((profile: { id: string }) =>
      profile.id === 'opensearch_hybrid_colbert'
    );
    expect(openSearchColbert?.config).toMatchObject({
      colbertTimeoutMs: 12000,
      colbertMinScore: 0.58,
      colbertTailDropEnabled: true,
      colbertTailMaxGap: 0.2,
      colbertTailMinScore: 0.7,
      colbertTailMinKeep: 1,
    });

    const storedAfterRead = await getAdminStore().getJson<Array<{ id: string }>>('retrieval-profiles', 'default');
    expect(storedAfterRead?.map((profile) => profile.id)).toEqual(['semantic_broad']);

    await app.close();
  });

  it('keeps admin-customized retrieval profiles when merging default examples', async () => {
    const defaults = await getDefaultRetrievalProfiles();
    const openSearchProfile = defaults.find((profile) => profile.id === 'opensearch_hybrid_colbert');
    if (!openSearchProfile) throw new Error('opensearch_hybrid_colbert retrieval profile template is missing');
    const legacyConfig: Partial<typeof openSearchProfile.config> = { ...openSearchProfile.config };
    delete legacyConfig.chatRetrievalQueryMode;
    delete legacyConfig.colbertTailDropEnabled;
    delete legacyConfig.colbertTailMaxGap;
    delete legacyConfig.colbertTailMinScore;
    delete legacyConfig.colbertTailMinKeep;
    await getAdminStore().setJson('retrieval-profiles', 'default', [{
      ...openSearchProfile,
      name: 'Custom OpenSearch + ColBERT',
      description: 'Customized by admin',
      config: legacyConfig,
    }]);

    const app = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/retrieval-profiles',
      headers: { cookie: 'mw=1' },
    });

    expect(list.statusCode).toBe(200);
    const profile = list.json().values.find((item: { id: string }) => item.id === 'opensearch_hybrid_colbert');
    expect(profile).toMatchObject({
      id: 'opensearch_hybrid_colbert',
      name: 'Custom OpenSearch + ColBERT',
      description: 'Customized by admin',
      config: expect.objectContaining({
        chatRetrievalQueryMode: 'current_message',
        colbertTailDropEnabled: true,
        colbertTailMaxGap: 0.2,
        colbertTailMinScore: 0.7,
        colbertTailMinKeep: 1,
      }),
    });
    expect(list.json().values.map((item: { id: string }) => item.id)).toContain('opensearch_hybrid');

    await app.close();
  });

  it('configures the MediaWiki retrieval profile separately from External API defaults', async () => {
    const app = await makeApp();
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/mediawiki-profile/config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().values).toEqual({ defaultRetrievalProfileId: 'opensearch_hybrid_colbert' });
    expect(read.json().selectedProfile).toMatchObject({
      id: 'opensearch_hybrid_colbert',
      readiness: expect.objectContaining({ status: expect.any(String) }),
    });
    expect(read.json().retrievalProfiles.map((profile: { id: string }) => profile.id)).toContain('semantic_broad');

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/mediawiki-profile/config',
      headers: { cookie: 'mw=1' },
      payload: { defaultRetrievalProfileId: 'semantic_broad' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      status: 'saved',
      values: { defaultRetrievalProfileId: 'semantic_broad' },
      selectedProfile: { id: 'semantic_broad' },
      metadata: { secretsRedacted: true },
    });

    const external = await app.inject({
      method: 'GET',
      url: '/api/admin/external-api/config',
      headers: { cookie: 'mw=1' },
    });
    expect(external.json().values.defaultRetrievalProfileId).toBe('');

    await app.close();
  });

  it('configures the built-in knowledge source profile and keeps the legacy MediaWiki selector in sync', async () => {
    const app = await makeApp();
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/knowledge-source-profile/config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().values).toMatchObject({
      id: 'default',
      sourceIds: ['mediawiki'],
      retrievalProfileId: 'opensearch_hybrid_colbert',
      failurePolicy: 'partial_with_warning',
      mergePolicy: 'normalize_rerank',
    });
    expect(read.json().sources).toEqual([
      expect.objectContaining({
        id: 'mediawiki',
        type: 'mediawiki',
        aclMode: 'source_acl_callback',
        semanticProviderId: 'smw',
      }),
    ]);

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/knowledge-source-profile/config',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'default',
        sourceIds: ['mediawiki'],
        retrievalProfileId: 'semantic_broad',
        failurePolicy: 'partial_with_warning',
        mergePolicy: 'normalize_rerank',
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      status: 'saved',
      values: {
        id: 'default',
        sourceIds: ['mediawiki'],
        retrievalProfileId: 'semantic_broad',
      },
      selectedProfile: { id: 'semantic_broad' },
      metadata: { secretsRedacted: true },
    });

    const legacy = await app.inject({
      method: 'GET',
      url: '/api/admin/mediawiki-profile/config',
      headers: { cookie: 'mw=1' },
    });
    expect(legacy.json().values).toEqual({ defaultRetrievalProfileId: 'semantic_broad' });

    const external = await app.inject({
      method: 'GET',
      url: '/api/admin/external-api/config',
      headers: { cookie: 'mw=1' },
    });
    expect(external.json().values.defaultRetrievalProfileId).toBe('');

    await app.close();
  });

  it('saves external API OIDC group mapping and reports safe capabilities', async () => {
    const app = await makeApp();
    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/external-api/config',
      headers: { cookie: 'mw=1' },
      payload: {
        enabled: true,
        mcpEnabled: true,
        anonymousSearchAllowed: false,
        maxTopK: 10,
        aclMode: 'groups_only',
        groupMappingMode: 'mapped_only',
        groupMappings: {
          'CN=WikiAI-IT-Readers': ['ai-it', 'ai-it'],
          'CN=WikiAI-Exec': ['ai-exec', 'ai-it'],
        },
        oidc: {
          issuer: 'https://issuer.example',
          audience: 'wikiai-api',
          jwksUrl: 'https://issuer.example/jwks.json',
          subjectClaim: 'sub',
          usernameClaim: 'preferred_username',
          groupsClaim: 'groups',
        },
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      status: 'saved',
      values: {
        aclMode: 'groups_only',
        groupMappingMode: 'mapped_only',
        groupMappings: {
          'CN=WikiAI-IT-Readers': ['ai-it'],
          'CN=WikiAI-Exec': ['ai-exec', 'ai-it'],
        },
      },
      capabilities: {
        groupMappingMode: 'mapped_only',
        groupMappingConfigured: true,
        groupMappingCount: 2,
        mappedGroupCount: 2,
      },
    });

    await app.close();
  });

  it('rejects enabling trigram search when the trigram index is not fully populated', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/config',
      headers: { cookie: 'mw=1' },
      payload: { trigramIndexEnabled: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('trigram_index_not_ready');
    await app.close();
  });

  it('reports lexical BM25 index status for RAG administration', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/internal/search-index/page',
      payload: {
        pageId: 404,
        title: 'CorpIT:Администрирование систем',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        lastModified: '2026-06-01T10:00:00Z',
        chunks: [
          {
            id: 4040001,
            text: 'Регламент администрирования систем и доступа операторов.',
            chunkIndex: 0,
            totalChunks: 1,
          },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/search-index/status',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      chunks: 1,
      ftsChunks: 1,
      trigramChunks: 1,
      trigramFtsChunks: 1,
      attachmentChunks: 0,
      attachmentPages: 0,
      attachmentColumnsReady: true,
      pages: 1,
      populated: true,
      backfillRecommended: false,
      trigramPopulated: true,
      trigramBackfillRecommended: false,
    });
    await app.close();
  });

  it('starts async trigram backfill and exposes job status', async () => {
    const app = await makeApp();
    await upsertSearchIndexPage({
      pageId: 405,
      title: 'CorpIT:Системы',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      chunks: [{
        id: 4050001,
        text: 'Регламент сопровождения систем.',
      }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/search-index/trigram/backfill',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().values).toMatchObject({
      status: 'running',
      totalChunks: 1,
    });

    await new Promise((resolve) => setImmediate(resolve));
    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/search-index/trigram/backfill/status',
      headers: { cookie: 'mw=1' },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json().values).toMatchObject({
      status: 'completed',
      totalChunks: 1,
      writtenChunks: 1,
    });
    expect(status.json().values.grams).toBeGreaterThan(0);
    await app.close();
  });

  it('cancels a running async trigram backfill job through the admin API', async () => {
    const app = await makeApp();
    await upsertSearchIndexPage({
      pageId: 406,
      title: 'CorpIT:Большой индекс',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      chunks: Array.from({ length: 1001 }, (_value, index) => ({
        id: 4060000 + index,
        text: `Регламент сопровождения систем ${index}.`,
      })),
    });

    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/search-index/trigram/backfill',
      headers: { cookie: 'mw=1' },
    });

    expect(started.statusCode).toBe(202);
    expect(started.json().values).toMatchObject({
      status: 'running',
      totalChunks: 1001,
    });

    const canceled = await app.inject({
      method: 'POST',
      url: '/api/admin/search-index/trigram/backfill/cancel',
      headers: { cookie: 'mw=1' },
    });

    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().values).toMatchObject({
      status: 'canceled',
      totalChunks: 1001,
    });

    await new Promise((resolve) => setImmediate(resolve));
    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/search-index/trigram/backfill/status',
      headers: { cookie: 'mw=1' },
    });

    expect(status.json().values.status).toBe('canceled');
    await app.close();
  });

  it('tests ColBERT reranker health with unsaved RAG form values', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/colbert/test',
      headers: { cookie: 'mw=1' },
      payload: {
        rerankMode: 'colbert_v2',
        colbertEnabled: true,
        colbertBaseUrl: 'http://colbert.internal:8080',
        colbertModel: 'colbert-v2-multilingual',
        colbertCandidateLimit: 25,
        colbertTimeoutMs: 2500,
        colbertMinScore: 0,
        colbertFailMode: 'fallback_current',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      status: 'ok',
      url: 'http://colbert.internal:8080/health',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://colbert.internal:8080/health',
      expect.objectContaining({ method: 'GET' })
    );
    await app.close();
  });

  it('rejects RAG hybrid config with no ranking weights', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/config',
      headers: { cookie: 'mw=1' },
      payload: { vectorWeight: 0, lexicalWeight: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid RAG config');
    await app.close();
  });

  it('rejects invalid RAG chunk boundaries', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/config',
      headers: { cookie: 'mw=1' },
      payload: { chunkSize: 256, chunkOverlap: 256 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid RAG config');
    await app.close();
  });

  it('rejects invalid source-aware chunking policy boundaries', async () => {
    const app = await makeApp();
    const separators = ['\n\n', '\n', ' '];
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/config',
      headers: { cookie: 'mw=1' },
      payload: {
        chunkingPolicy: {
          defaults: { chunkSize: 512, chunkOverlap: 50, chunkSeparators: separators },
          sources: {
            wiki_page: { chunkSize: 256, chunkOverlap: 256, chunkSeparators: separators },
          },
          namespaceOverrides: {},
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid RAG config');
    await app.close();
  });

  it('creates indexing profiles and starts profile-driven reindex', async () => {
    startSyncerReindex.mockResolvedValueOnce({
      status: {
        state: 'running',
        runId: 'run-lexical-1',
        startedAt: '2026-05-31T00:00:00.000Z',
        progress: {
          runId: 'run-lexical-1',
          startedAt: '2026-05-31T00:00:00.000Z',
          totalPages: 3,
          processed: 0,
          failed: 0,
          totalChunks: 0,
          targetWrites: {},
        },
      },
    });

    const app = await makeApp();
    const ontology = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
    });
    const ontologyProperties = ontology.json().values as Array<{
      id: string;
      name: string;
      label?: string;
      description?: string;
      dataType?: string;
      aiExtractable?: boolean;
      classificationThreshold?: number;
      sensitive?: boolean;
    }>;
    for (const property of ontologyProperties) {
      await app.inject({
        method: 'POST',
        url: '/api/admin/smw/ontology',
        headers: { cookie: 'mw=1' },
        payload: {
          id: property.id,
          name: property.name,
          label: property.label ?? property.name,
          description: property.description ?? '',
          dataType: property.dataType ?? 'text',
          aiExtractable: property.aiExtractable ?? true,
          classificationThreshold: property.classificationThreshold ?? 0.7,
          sensitive: property.sensitive ?? false,
          indexed: ['Департамент', 'Тип документа'].includes(property.name),
        },
      });
    }

    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'corp-it',
        name: 'ИТ документы',
        namespaces: [3030],
        namespaceAcl: { '3030': ['ai-it', 'ai-exec'] },
        smwProperties: ['Департамент', 'Тип документа'],
        titleFilters: { include: ['CorpIT:'], exclude: ['Черновик'] },
        categoryFilters: { include: ['ИТ'], exclude: ['Архив'] },
        documentPolicyId: 'default',
        runMode: 'manual',
        indexTargets: ['dense', 'bm25', 'opensearch', 'attachments', 'semanticFacts'],
        attachmentsEnabled: true,
        semanticFactsEnabled: true,
        chunkSize: 640,
        chunkOverlap: 80,
        chunkSeparators: ['\n\n', '. ', ' '],
        dryRunDefault: true,
        maxPagesDefault: 2,
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().values).toMatchObject({
      id: 'corp-it',
      name: 'ИТ документы',
      namespaces: [3030],
      namespaceAcl: { '3030': ['ai-it', 'ai-exec'] },
      titleFilters: { include: ['CorpIT:'], exclude: ['Черновик'] },
      categoryFilters: { include: ['ИТ'], exclude: ['Архив'] },
      documentPolicyId: 'default',
      runMode: 'manual',
      dryRunDefault: true,
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().values).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'corp-it' })])
    );

    const reindex = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { cookie: 'mw=1' },
      payload: { profileId: 'corp-it', maxPages: 1, dryRun: false },
    });

    expect(reindex.statusCode).toBe(202);
    expect(startSyncerReindex).toHaveBeenCalledWith({
      profileId: 'corp-it',
      indexTargets: ['dense', 'bm25', 'opensearch', 'attachments', 'semanticFacts'],
      source: undefined,
      colbertModel: undefined,
      colbertCollection: undefined,
      attachmentsEnabled: true,
      semanticFactsEnabled: true,
      smwProperties: ['Департамент', 'Тип документа'],
      namespaces: [3030],
      namespaceAcl: { '3030': ['ai-it', 'ai-exec'] },
      titleFilters: { include: ['CorpIT:'], exclude: ['Черновик'] },
      categoryFilters: { include: ['ИТ'], exclude: ['Архив'] },
      documentPolicyId: 'default',
      maxPages: 1,
      chunkSize: 640,
      chunkOverlap: 80,
      chunkSeparators: ['\n\n', '. ', ' '],
      chunkingPolicy: expect.objectContaining({
        sources: expect.objectContaining({
          wiki_page: expect.objectContaining({ chunkSize: 800, chunkOverlap: 120 }),
        }),
      }),
      dryRun: false,
      llmEnrichmentEnabled: undefined,
      llmEnrichmentModel: undefined,
      llmEnrichmentMaxChars: undefined,
    });
    await app.close();
  });

  it('syncs attachment targets when saving and running indexing profiles', async () => {
    startSyncerReindex.mockResolvedValueOnce({
      status: {
        state: 'running',
        runId: 'run-lexical-1',
        startedAt: '2026-05-31T00:00:00.000Z',
        progress: {
          runId: 'run-lexical-1',
          startedAt: '2026-05-31T00:00:00.000Z',
          totalPages: 3,
          processed: 0,
          failed: 0,
          totalChunks: 0,
          targetWrites: {},
        },
      },
    });

    const app = await makeApp();
    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'manual-attachments',
        name: 'Manual attachment profile',
        namespaces: [0],
        indexTargets: ['dense', 'bm25'],
        attachmentsEnabled: true,
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().values.indexTargets).toContain('attachments');

    const reindex = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { cookie: 'mw=1' },
      payload: { profileId: 'manual-attachments', attachmentsEnabled: true },
    });

    expect(reindex.statusCode).toBe(202);
    expect(startSyncerReindex).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'manual-attachments',
        attachmentsEnabled: true,
        indexTargets: expect.arrayContaining(['dense', 'bm25', 'attachments']),
      })
    );
    await app.close();
  });

  it('maps ColBERT index status from Syncer ColBERT counters', async () => {
    startSyncerReindex.mockResolvedValueOnce({
      status: {
        state: 'running',
        startedAt: '2026-06-08T08:00:00.000Z',
      },
    });

    const app = await makeApp();
    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/rag/colbert/indexes',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'candidate-colbert',
        model: 'candidate-model',
        collection: 'candidate_collection',
        source: 'qdrant_payload',
      },
    });

    expect(started.statusCode).toBe(202);
    const spec = started.json().values;
    getSyncerReindexStatus.mockResolvedValueOnce({
      state: 'completed',
      startedAt: spec.startedAt,
      summary: {
        processed: 10,
        totalChunks: 99,
        failed: 4,
        colbertPagesIndexed: 3,
        colbertChunksIndexed: 12,
        colbertFailures: 1,
      },
    });

    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/rag/colbert/indexes/candidate-colbert/status',
      headers: { cookie: 'mw=1' },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json().values).toMatchObject({
      id: 'candidate-colbert',
      status: 'complete',
      pagesProcessed: 3,
      chunksIndexed: 12,
      failures: 1,
    });
    await app.close();
  });

  it('proxies ColBERT source diagnostics from syncer', async () => {
    const app = await makeApp();

    const result = await app.inject({
      method: 'GET',
      url: '/api/admin/rag/colbert/source-diagnostics?namespaces=0',
      headers: { cookie: 'mw=1' },
    });

    expect(result.statusCode).toBe(200);
    expect(getSyncerReindexSourceDiagnostics).toHaveBeenCalledWith([0]);
    expect(result.json().values).toMatchObject({
      source: 'qdrant_payload',
      mediaWikiPages: 102,
      denseCollection: 'wiki_chunks',
      qdrantPayloadPages: 1,
      qdrantPayloadChunks: 1,
      densePagesBehindMediaWiki: true,
    });
    await app.close();
  });

  it('serves unified index status summary for admin reindex operations', async () => {
    const app = await makeApp();

    const result = await app.inject({
      method: 'GET',
      url: '/api/admin/index-status/summary?namespaces=0',
      headers: { cookie: 'mw=1' },
    });

    expect(result.statusCode).toBe(200);
    expect(getIndexStatusSummary).toHaveBeenCalledWith({
      namespaces: [0],
      sessionCookie: 'mw=1',
    });
    expect(result.json().values).toMatchObject({
      status: 'warning',
      source: { pages: 103 },
      indexes: {
        bm25: {
          status: 'warning',
          diff: {
            staleCount: 82,
            staleSamples: [{ pageId: 11, title: 'Old page' }],
          },
        },
        trigram: {
          status: 'warning',
          backfillRequired: true,
        },
      },
    });
    await app.close();
  });

  it('removes stale attachment target when attachment reindex is not requested', async () => {
    startSyncerReindex.mockResolvedValueOnce({
      status: {
        state: 'running',
        runId: 'run-lexical-1',
        startedAt: '2026-05-31T00:00:00.000Z',
        progress: {
          runId: 'run-lexical-1',
          startedAt: '2026-05-31T00:00:00.000Z',
          totalPages: 3,
          processed: 0,
          failed: 0,
          totalChunks: 0,
          targetWrites: {},
        },
      },
    });
    const now = '2026-06-06T00:00:00.000Z';
    await getAdminStore().setJson('indexing-profiles', 'default', [{
      id: 'stale-attachments',
      name: 'Stale attachment target',
      enabled: true,
      namespaces: [0],
      namespaceAcl: { '0': ['*'] },
      smwProperties: [],
      titleFilters: { include: [], exclude: [] },
      categoryFilters: { include: [], exclude: [] },
      documentPolicyId: 'default',
      runMode: 'manual',
      indexTargets: ['dense', 'bm25', 'attachments'],
      attachmentsEnabled: false,
      semanticFactsEnabled: true,
      ontologyVectorsEnabled: false,
      chunkSize: 512,
      chunkOverlap: 50,
      chunkSeparators: ['\n\n', '. ', ' '],
      dryRunDefault: false,
      createdAt: now,
      updatedAt: now,
    }]);

    const app = await makeApp();
    const reindex = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { cookie: 'mw=1' },
      payload: { profileId: 'stale-attachments', attachmentsEnabled: false },
    });

    expect(reindex.statusCode).toBe(202);
    expect(startSyncerReindex.mock.calls[0]?.[0].attachmentsEnabled).toBe(false);
    expect(startSyncerReindex.mock.calls[0]?.[0].indexTargets).not.toContain('attachments');
    await app.close();
  });

  it('does not apply a hidden default page limit to the default indexing profile', async () => {
    const app = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().values[0]).toMatchObject({
      id: 'default',
      runMode: 'manual',
    });
    expect(list.json().values[0].maxPagesDefault).toBeUndefined();
    await app.close();
  });

  it('clears an existing indexing profile page limit when maxPagesDefault is null', async () => {
    const app = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'limited',
        name: 'Limited',
        namespaces: [0],
        maxPagesDefault: 10,
      },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().values.maxPagesDefault).toBe(10);

    const update = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'limited',
        name: 'Limited',
        namespaces: [0],
        maxPagesDefault: null,
      },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().values.maxPagesDefault).toBeUndefined();
    await app.close();
  });

  it('saves indexing automation assignments and exposes them internally', async () => {
    config.syncerAdminToken = 'internal-token';
    const app = await makeApp();
    const saveProfile = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'change-profile',
        name: 'Change profile',
        namespaces: [0],
      },
    });
    expect(saveProfile.statusCode).toBe(200);

    const saveAutomation = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-automation',
      headers: { cookie: 'mw=1' },
      payload: {
        changeIndexingProfileId: 'change-profile',
        scheduledReindexProfileId: 'change-profile',
        scheduleEnabled: true,
        scheduleIntervalMinutes: 30,
      },
    });

    expect(saveAutomation.statusCode).toBe(200);
    expect(saveAutomation.json().values).toMatchObject({
      changeIndexingProfileId: 'change-profile',
      scheduledReindexProfileId: 'change-profile',
      scheduleEnabled: true,
      scheduleIntervalMinutes: 30,
    });

    const internal = await app.inject({
      method: 'GET',
      url: '/api/internal/indexing-automation',
      headers: { 'x-wikiai-admin-token': 'internal-token' },
    });
    expect(internal.statusCode).toBe(200);
    expect(internal.json().values).toMatchObject({
      changeIndexingProfileId: 'change-profile',
      scheduledReindexProfileId: 'change-profile',
      scheduleEnabled: true,
      scheduleIntervalMinutes: 30,
    });
    await app.close();
  });

  it('reports scheduled indexing profile scheduler status', async () => {
    const app = await makeApp();
    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'nightly-it',
        name: 'Nightly IT',
        namespaces: [3030],
        runMode: 'scheduled',
        scheduleIntervalMinutes: 60,
        chunkSize: 512,
        chunkOverlap: 50,
      },
    });

    expect(save.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/indexing-profile-scheduler/status',
      headers: { cookie: 'mw=1' },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json().scheduler.profiles[0]).toMatchObject({
      id: 'nightly-it',
      name: 'Nightly IT',
      runMode: 'scheduled',
      intervalMinutes: 60,
      running: false,
    });
    await app.close();
  });

  it('uses indexing automation profile assignment for scheduled reindexing', async () => {
    const app = await makeApp();
    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-profiles',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'auto-nightly',
        name: 'Automation nightly',
        namespaces: [0],
        runMode: 'manual',
      },
    });
    expect(save.statusCode).toBe(200);

    const automation = await app.inject({
      method: 'POST',
      url: '/api/admin/indexing-automation',
      headers: { cookie: 'mw=1' },
      payload: {
        scheduledReindexProfileId: 'auto-nightly',
        scheduleEnabled: true,
        scheduleIntervalMinutes: 45,
      },
    });
    expect(automation.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/indexing-profile-scheduler/status',
      headers: { cookie: 'mw=1' },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json().scheduler.profiles[0]).toMatchObject({
      id: 'auto-nightly',
      name: 'Automation nightly',
      runMode: 'manual',
      intervalMinutes: 45,
      source: 'automation',
      running: false,
    });
    await app.close();
  });

  it('saves webhook config and runs a safe health test', async () => {
    const app = await makeApp();
    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/webhook/config',
      headers: { cookie: 'mw=1' },
      payload: {
        syncerUrl: 'http://syncer.internal:3001',
        events: { edit: true, delete: false },
        timeoutMs: 2000,
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().values.events).toMatchObject({ edit: true, delete: false, move: true, protect: true });

    const test = await app.inject({
      method: 'POST',
      url: '/api/admin/webhook/test',
      headers: { cookie: 'mw=1' },
    });

    expect(test.statusCode).toBe(200);
    expect(test.json().values.lastStatus).toMatchObject({
      status: 'ok',
      url: 'http://syncer.internal:3001/health',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://syncer.internal:3001/health',
      expect.objectContaining({ method: 'GET' })
    );
    await app.close();
  });

  it('saves chat retention config and exposes Redis TTL metadata', async () => {
    const app = await makeApp();
    const defaults = await app.inject({
      method: 'GET',
      url: '/api/admin/chat-retention/config',
      headers: { cookie: 'mw=1' },
    });

    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().values).toMatchObject({
      retentionMode: 'archive',
      activeDays: 7,
    });

    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/chat-retention/config',
      headers: { cookie: 'mw=1' },
      payload: {
        retentionMode: 'archive',
        activeDays: 14,
        recentDays: 7,
        archiveDays: 120,
        maxPinnedChats: 10,
        maxActiveChats: 100,
        maxTotalChats: 500,
        onLimitExceeded: 'archive_oldest',
        exportOptions: {
          formats: ['json', 'csv'],
          includeMetadata: true,
          includeSources: true,
          includeMessages: false,
        },
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().values).toMatchObject({
      retentionMode: 'archive',
      activeDays: 14,
      recentDays: 7,
      archiveDays: 120,
      onLimitExceeded: 'archive_oldest',
    });
    expect(save.json().metadata.redisTtlSeconds).toBe(120 * 24 * 60 * 60);

    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/chat-retention/config',
      headers: { cookie: 'mw=1' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().metadata.redisTtlSeconds).toBe(120 * 24 * 60 * 60);
    expect(read.json().values.exportOptions.formats).toEqual(['json', 'csv']);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { cookie: 'mw=1' },
    });
    expect(audit.json().values[0]).toMatchObject({
      actor: 'TestAdmin',
      action: 'chat-retention-config.update',
      entityType: 'chat-retention-config',
    });
    await app.close();
  });

  it('lists, archives and exports SQL chat sessions', async () => {
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'admin-chat',
      userId: 42,
      username: 'TestAdmin',
      role: 'user',
      content: 'Административный чат',
    }, {
      retentionMode: 'auto_delete',
      activeDays: 30,
      recentDays: 7,
      archiveDays: 365,
      maxPinnedChats: 20,
      maxActiveChats: 200,
      maxTotalChats: 1000,
      onLimitExceeded: 'delete_oldest',
      exportOptions: {
        formats: ['json'],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    });

    const app = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/chat-sessions?limit=10',
      headers: { cookie: 'mw=1' },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().metadata.registry.active).toBe(1);
    expect(list.json().values[0]).toMatchObject({
      conversationId: 'admin-chat',
      title: 'Административный чат',
      username: 'TestAdmin',
      status: 'active',
    });

    const sessionId = list.json().values[0].id;
    const messages = await app.inject({
      method: 'GET',
      url: `/api/admin/chat-sessions/${sessionId}/messages`,
      headers: { cookie: 'mw=1' },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().values[0]).toMatchObject({ content: 'Административный чат' });

    const exported = await app.inject({
      method: 'POST',
      url: `/api/admin/chat-sessions/${sessionId}/export`,
      headers: { cookie: 'mw=1' },
      payload: { format: 'json' },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().values.content).toContain('Административный чат');

    const archived = await app.inject({
      method: 'POST',
      url: `/api/admin/chat-sessions/${sessionId}/archive`,
      headers: { cookie: 'mw=1' },
      payload: { reason: 'test' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().values.status).toBe('archived');

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { cookie: 'mw=1' },
    });
    expect(audit.json().values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'chat-session.archive', entityType: 'chat-sessions' }),
        expect.objectContaining({ action: 'chat-session.export', entityType: 'chat-sessions' }),
      ])
    );

    await app.close();
  });

  it('creates trust model entities rules and previews score without LLM', async () => {
    const app = await makeApp();
    const model = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'corp-default',
        name: 'Corporate default',
        active: true,
        baseScore: 0.6,
        minTrustScoreForContext: 0.5,
        includeDrafts: false,
        stalenessPenaltyPerYear: 0.1,
        requireVerifiedForDirectAnswer: true,
        requireSources: true,
      },
    });

    expect(model.statusCode).toBe(200);
    expect(model.json().values).toMatchObject({
      id: 'corp-default',
      active: true,
      baseScore: 0.6,
      stalenessPenaltyPerYear: 0.1,
    });

    const entity = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/entities',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'approved-doc',
        entityType: 'smw_property',
        name: 'Approved document status',
        value: 'Статус документа=Утвержден',
        weight: 0.1,
        enabled: true,
      },
    });

    expect(entity.statusCode).toBe(200);
    expect(entity.json().values).toMatchObject({
      id: 'approved-doc',
      modelId: 'corp-default',
      entityType: 'smw_property',
      weight: 0.1,
    });

    const rule = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc/rules',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'verified-boost',
        name: 'Boost verified pages',
        condition: {
          field: 'property',
          operator: 'equals',
          propertyName: 'Статус документа',
          value: 'Утвержден',
        },
        modifier: 0.2,
        flags: ['verified', 'official'],
        displayOrder: 10,
      },
    });

    expect(rule.statusCode).toBe(200);
    expect(rule.json().values).toMatchObject({
      id: 'verified-boost',
      entityId: 'approved-doc',
      modifier: 0.2,
      flags: ['verified', 'official'],
    });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/preview',
      headers: { cookie: 'mw=1' },
      payload: {
        title: 'CorpIT:Инструкция VPN',
        namespace: 3030,
        categories: ['ИТ'],
        tags: ['verified'],
        authorGroups: ['ai-it'],
        templates: ['ApprovedDocument'],
        properties: {
          'Статус документа': 'Утвержден',
        },
      },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().values).toMatchObject({
      modelId: 'corp-default',
      score: 0.9,
      entityScoreDelta: 0.1,
      ruleScoreDelta: 0.2,
      stalenessPenalty: 0,
      flags: ['official', 'verified'],
      decisions: {
        includeInContext: true,
        allowDirectAnswer: true,
        requireSources: true,
      },
    });
    expect(preview.json().values.appliedEntities[0]).toMatchObject({ id: 'approved-doc' });
    expect(preview.json().values.appliedRules[0]).toMatchObject({ id: 'verified-boost' });

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { cookie: 'mw=1' },
    });
    expect(audit.json().values[0]).toMatchObject({
      action: 'trust-rule.create',
      entityType: 'trust-models',
    });
    await app.close();
  });

  it('manages top-level trust rules without selecting a trust entity', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'corp-default',
        name: 'Corporate default',
        active: true,
        baseScore: 0.6,
        minTrustScoreForContext: 0.5,
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/rules',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'namespace-boost',
        name: 'Boost corporate namespace',
        condition: {
          field: 'namespace',
          operator: 'equals',
          value: '3030',
        },
        modifier: 0.15,
        flags: ['official'],
        displayOrder: 5,
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().values).toMatchObject({
      id: 'namespace-boost',
      modifier: 0.15,
      flags: ['official'],
    });
    expect(created.json().values).not.toHaveProperty('entityId');

    const rules = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-models/corp-default/rules',
      headers: { cookie: 'mw=1' },
    });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().values).toHaveLength(1);
    expect(rules.json().values[0]).toMatchObject({ id: 'namespace-boost' });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/preview',
      headers: { cookie: 'mw=1' },
      payload: {
        title: 'CorpIT:Инструкция VPN',
        namespace: 3030,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().values).toMatchObject({
      score: 0.75,
      ruleScoreDelta: 0.15,
      flags: ['official'],
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/admin/trust-models/corp-default/rules/namespace-boost',
      headers: { cookie: 'mw=1' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().values).toEqual({ deletedRuleId: 'namespace-boost' });

    const rulesAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-models/corp-default/rules',
      headers: { cookie: 'mw=1' },
    });
    expect(rulesAfterDelete.json().values).toEqual([]);

    await app.close();
  });

  it('recalculates trust scores into Qdrant payload', async () => {
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 101,
          payload: {
            page_id: 101,
            title: 'CorpIT:Инструкция VPN',
            text: 'Approved content',
            namespace: 3030,
            allowed_groups: ['ai-it'],
            semantic_facts: {
              'Статус документа': ['Утвержден'],
            },
          },
        },
      ],
      next_page_offset: null,
    });
    qdrantSetPayload.mockResolvedValueOnce({ status: 'completed', operation_id: 1 });

    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'corp-default',
        name: 'Corporate default',
        active: true,
        baseScore: 0.6,
        minTrustScoreForContext: 0.5,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/entities',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'approved-doc',
        entityType: 'smw_property',
        name: 'Approved document status',
        value: 'Статус документа=Утвержден',
        weight: 0.2,
      },
    });

    const recalc = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-scores/recalculate',
      headers: { cookie: 'mw=1' },
      payload: {
        modelId: 'corp-default',
        dryRun: false,
        maxScan: 10,
        batchSize: 5,
      },
    });

    expect(recalc.statusCode).toBe(200);
    expect(recalc.json().values).toMatchObject({
      collection: 'test_chunks',
      modelId: 'corp-default',
      dryRun: false,
      scannedPoints: 1,
      eligiblePoints: 1,
      updatedPoints: 1,
      failedPoints: 0,
    });
    expect(qdrantSetPayload).toHaveBeenCalledWith(
      'test_chunks',
      expect.objectContaining({
        points: [101],
        wait: true,
        payload: expect.objectContaining({
          trust_score: 0.8,
          trust_flags: [],
          applied_entities: ['approved-doc'],
          trust_model_id: 'corp-default',
          trust_include_in_context: true,
        }),
      })
    );
    await app.close();
  });

  it('deletes trust rules and cascades rules when deleting trust entities', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'corp-default',
        name: 'Corporate default',
        active: true,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/entities',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'approved-doc',
        entityType: 'smw_property',
        name: 'Approved document status',
        value: 'Статус документа=Утвержден',
        weight: 0.1,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc/rules',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'verified-boost',
        name: 'Boost verified pages',
        condition: {
          field: 'property',
          operator: 'equals',
          propertyName: 'Статус документа',
          value: 'Утвержден',
        },
        modifier: 0.2,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc/rules',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'manual-review',
        name: 'Manual review',
        condition: {
          field: 'status',
          operator: 'contains',
          value: 'review',
        },
        modifier: -0.1,
      },
    });

    const deletedRule = await app.inject({
      method: 'DELETE',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc/rules/verified-boost',
      headers: { cookie: 'mw=1' },
    });
    expect(deletedRule.statusCode).toBe(200);
    expect(deletedRule.json().values).toEqual({ deletedRuleId: 'verified-boost' });

    const rulesAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc/rules',
      headers: { cookie: 'mw=1' },
    });
    expect(rulesAfterDelete.json().values).toHaveLength(1);
    expect(rulesAfterDelete.json().values[0]).toMatchObject({ id: 'manual-review' });

    const deletedEntity = await app.inject({
      method: 'DELETE',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc',
      headers: { cookie: 'mw=1' },
    });
    expect(deletedEntity.statusCode).toBe(200);
    expect(deletedEntity.json().values).toEqual({
      deletedEntityId: 'approved-doc',
      deletedRuleCount: 1,
    });

    const entitiesAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-models/corp-default/entities',
      headers: { cookie: 'mw=1' },
    });
    expect(entitiesAfterDelete.json().values).toEqual([]);

    const missingRule = await app.inject({
      method: 'DELETE',
      url: '/api/admin/trust-models/corp-default/entities/approved-doc/rules/manual-review',
      headers: { cookie: 'mw=1' },
    });
    expect(missingRule.statusCode).toBe(404);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { cookie: 'mw=1' },
    });
    expect(audit.json().values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'trust-rule.delete', entityType: 'trust-models' }),
        expect.objectContaining({ action: 'trust-entity.delete', entityType: 'trust-models' }),
      ])
    );
    await app.close();
  });

  it('supports trust recalculation dry run without writing Qdrant payload', async () => {
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 201,
          payload: {
            page_id: 201,
            title: 'CorpIT:Черновик VPN',
            text: 'Draft content',
            namespace: 3030,
            allowed_groups: ['ai-it'],
            semantic_facts: {
              'Статус документа': ['Черновик'],
            },
          },
        },
      ],
      next_page_offset: null,
    });

    const app = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'corp-default',
        name: 'Corporate default',
        active: true,
        baseScore: 0.6,
        minTrustScoreForContext: 0.5,
        includeDrafts: false,
      },
    });

    const recalc = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-scores/recalculate',
      headers: { cookie: 'mw=1' },
      payload: {
        modelId: 'corp-default',
        dryRun: true,
        maxScan: 10,
      },
    });

    expect(recalc.statusCode).toBe(200);
    expect(recalc.json().values).toMatchObject({
      modelId: 'corp-default',
      dryRun: true,
      scannedPoints: 1,
      eligiblePoints: 1,
      updatedPoints: 0,
    });
    expect(recalc.json().values.sample[0]).toMatchObject({
      pointId: 201,
      includeInContext: false,
    });
    expect(qdrantSetPayload).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows Syncer to recalculate trust for one webhook page without MediaWiki session', async () => {
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 303001,
          payload: {
            page_id: 303,
            title: 'CorpIT:Webhook VPN',
            text: 'Approved webhook content',
            namespace: 3030,
            allowed_groups: ['ai-it'],
            semantic_facts: {
              'Статус документа': ['Утвержден'],
            },
          },
        },
      ],
      next_page_offset: null,
    });
    qdrantSetPayload.mockResolvedValueOnce({ status: 'completed', operation_id: 1 });

    const app = await makeApp();
    const recalc = await app.inject({
      method: 'POST',
      url: '/api/internal/trust/recalculate-page',
      payload: { pageId: 303 },
    });

    expect(recalc.statusCode).toBe(200);
    expect(recalc.json().values).toMatchObject({
      collection: 'test_chunks',
      dryRun: false,
      pageId: 303,
      scannedPoints: 1,
      updatedPoints: 1,
    });
    expect(qdrantScroll).toHaveBeenCalledWith(
      'test_chunks',
      expect.objectContaining({
        filter: { must: [{ key: 'page_id', match: { value: 303 } }] },
      })
    );
    await app.close();
  });

  it('allows Syncer to read internal search index status without MediaWiki session', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/internal/search-index/status',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      attachmentColumnsReady: true,
      attachmentChunks: 0,
      attachmentPages: 0,
    });
    await app.close();
  });

  it('allows Syncer to update the lexical search index without MediaWiki session', async () => {
    const app = await makeApp();
    const update = await app.inject({
      method: 'POST',
      url: '/api/internal/search-index/page',
      payload: {
        pageId: 404,
        title: 'CorpIT:Администрирование систем',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        lastModified: '2026-06-01T10:00:00Z',
        chunks: [
          {
            id: 4040001,
            text: 'Регламент администрирования систем и доступа операторов.',
            chunkIndex: 0,
            totalChunks: 1,
          },
        ],
      },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().values).toMatchObject({
      status: 'ok',
      pageId: 404,
      chunks: 1,
    });

    await expect(searchLexicalChunks('администрирование систем', 5)).resolves.toEqual([
      expect.objectContaining({
        id: 4040001,
        pageId: 404,
        title: 'CorpIT:Администрирование систем',
        allowedGroups: ['ai-it'],
      }),
    ]);
    await app.close();
  });

  it('saves scheduled trust recalculation config without running OpenAI', async () => {
    const app = await makeApp();
    const save = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-recalculation/config',
      headers: { cookie: 'mw=1' },
      payload: {
        enabled: true,
        intervalMinutes: 60,
        maxScan: 2000,
        batchSize: 100,
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().values).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      maxScan: 2000,
      batchSize: 100,
    });
    expect(save.json().scheduler).toMatchObject({
      enabled: true,
      running: false,
    });
    expect(qdrantScroll).not.toHaveBeenCalled();

    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-recalculation/config',
      headers: { cookie: 'mw=1' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().values.enabled).toBe(true);
    await app.close();
  });

  it('reports semantic facts status from Qdrant payloads', async () => {
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 1,
          payload: {
            page_id: 10,
            title: 'CorpIT:FAQ VPN',
            namespace: 3030,
            allowed_groups: ['ai-it', 'ai-exec'],
            semantic_facts: {
              'Департамент': ['ИТ департамент'],
              'Тип документа': ['FAQ'],
            },
          },
        },
        {
          id: 2,
          payload: {
            page_id: 10,
            title: 'CorpIT:FAQ VPN',
            namespace: 3030,
            allowed_groups: ['ai-it', 'ai-exec'],
            semantic_facts: {
              'Департамент': ['ИТ департамент'],
              'Тип документа': ['FAQ'],
            },
          },
        },
        {
          id: 3,
          payload: {
            page_id: 11,
            title: 'CorpCommon:Приказ',
            namespace: 3000,
            allowed_groups: ['*'],
            semantic_facts: {
              'Тип документа': ['Приказ'],
            },
          },
        },
        {
          id: 4,
          payload: {
            page_id: 12,
            title: 'Plain',
            namespace: 0,
            allowed_groups: ['*'],
          },
        },
      ],
      next_page_offset: null,
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/semantic/status',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      scannedPoints: 4,
      semanticPoints: 3,
      semanticPages: 2,
      namespaces: { '3000': 1, '3030': 2 },
    });
    expect(res.json().values.properties['Тип документа']).toMatchObject({ points: 3, pages: 2 });
    await app.close();
  });

  it('searches semantic facts without calling LLM', async () => {
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 1,
          payload: {
            page_id: 20,
            title: 'CorpIT:Инструкция VPN',
            namespace: 3030,
            allowed_groups: ['ai-it', 'ai-exec'],
            semantic_facts: {
              'Департамент': ['ИТ департамент'],
              'Тип документа': ['Инструкция'],
            },
          },
        },
        {
          id: 2,
          payload: {
            page_id: 21,
            title: 'CorpHR:FAQ отпусков',
            namespace: 3010,
            allowed_groups: ['ai-hr', 'ai-exec'],
            semantic_facts: {
              'Департамент': ['Департамент персонала'],
            },
          },
        },
      ],
      next_page_offset: null,
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/semantic/search?property=%D0%94%D0%B5%D0%BF%D0%B0%D1%80%D1%82%D0%B0%D0%BC%D0%B5%D0%BD%D1%82&value=%D0%98%D0%A2',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      property: 'Департамент',
      value: 'ИТ',
      matchedPoints: 1,
      returnedPages: 1,
    });
    expect(res.json().values.results[0]).toMatchObject({
      pageId: 20,
      title: 'CorpIT:Инструкция VPN',
      matchedValues: ['ИТ департамент'],
    });
    expect(userCanRead).toHaveBeenCalledWith('mw=1', 'CorpIT:Инструкция VPN');
    await app.close();
  });

  it('checks MediaWiki readability for semantic facts even when payload groups are wildcard', async () => {
    userCanRead.mockResolvedValueOnce(false);
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 1,
          payload: {
            page_id: 30,
            title: 'CorpCommon:Закрытое исключение',
            namespace: 3000,
            allowed_groups: ['*'],
            semantic_facts: {
              Type: ['Policy'],
            },
          },
        },
      ],
      next_page_offset: null,
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/semantic/search?property=Type&value=Policy',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().values).toMatchObject({
      matchedPoints: 1,
      returnedPages: 0,
    });
    expect(userCanRead).toHaveBeenCalledWith('mw=1', 'CorpCommon:Закрытое исключение');
    await app.close();
  });

  it('manages SMW ontology vectors with local embeddings and no OpenAI', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        embedding: fetchMock.mock.calls.length === 1 ? [1, 0] : [0.95, 0.05],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await makeApp();
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'department',
        name: 'Департамент',
        label: 'Департамент',
        description: 'Организационная принадлежность документа',
        aiPromptHint: 'Используется для маршрутизации поиска по подразделениям.',
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'department-owner',
        name: 'Владелец процесса',
        label: 'Владелец процесса',
        description: 'Ответственное подразделение или роль',
        indexed: false,
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().values.indexed).toBe(true);
    expect(second.json().values.indexed).toBe(false);

    qdrantScroll.mockResolvedValue({
      points: [
        {
          id: 1,
          payload: {
            page_id: 1001,
            title: 'CorpCommon:VPN',
            namespace: 0,
            semantic_facts: {
              Департамент: ['ИТ', 'Финансы'],
              'Владелец процесса': ['Service Desk'],
            },
          },
        },
      ],
      next_page_offset: null,
    });

    const generated = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology/department/generate-vector',
      headers: { cookie: 'mw=1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology/department-owner/generate-vector',
      headers: { cookie: 'mw=1' },
    });

    expect(generated.statusCode).toBe(200);
    expect(generated.json().metadata.openAiUsed).toBe(false);
    expect(generated.json().values.vector).toMatchObject({
      status: 'ready',
      model: 'nomic-embed-text',
      dimension: 2,
    });
    expect(generated.json().values.vector.sourceText).toContain('Known values sample: ИТ, Финансы');
    expect(generated.json().values.vector.embedding).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({ method: 'POST' })
    );

    const indexedProperties = await app.inject({
      method: 'GET',
      url: '/api/internal/smw/indexed-properties',
    });
    expect(indexedProperties.statusCode).toBe(200);
    expect(indexedProperties.json().values).toContain('Департамент');
    expect(indexedProperties.json().values).not.toContain('Владелец процесса');

    const similarities = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/ontology/department/similarities?threshold=0.5',
      headers: { cookie: 'mw=1' },
    });

    expect(similarities.statusCode).toBe(200);
    expect(similarities.json().values.results[0]).toMatchObject({
      id: 'department-owner',
      name: 'Владелец процесса',
    });

    const clusters = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology/clusterize',
      headers: { cookie: 'mw=1' },
      payload: { threshold: 0.5 },
    });

    expect(clusters.statusCode).toBe(200);
    expect(clusters.json().values.clusters[0].propertyIds).toEqual(
      expect.arrayContaining(['department', 'department-owner'])
    );

    const classification = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology/classify-fragment',
      headers: { cookie: 'mw=1' },
      payload: {
        text: 'Документ описывает маршрутизацию заявок между ИТ и владельцем процесса.',
        threshold: 0.5,
      },
    });

    expect(classification.statusCode).toBe(200);
    expect(classification.json().metadata.openAiUsed).toBe(false);
    expect(classification.json().values).toMatchObject({
      model: 'nomic-embed-text',
      dimension: 2,
      diagnostics: {
        vectorizedProperties: 2,
        eligibleProperties: 2,
      },
    });
    expect(classification.json().values.results[0].vector.embedding).toBeUndefined();
    expect(classification.json().values.matches.map((match: { id: string }) => match.id)).toEqual(
      expect.arrayContaining(['department', 'department-owner'])
    );

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/admin/smw/ontology/department-owner',
      headers: { cookie: 'mw=1' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().values).toMatchObject({ id: 'department-owner', name: 'Владелец процесса' });

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
    });
    expect(afterDelete.json().values.map((property: { id: string }) => property.id)).not.toContain('department-owner');

    const deleteMissing = await app.inject({
      method: 'DELETE',
      url: '/api/admin/smw/ontology/missing-property',
      headers: { cookie: 'mw=1' },
    });
    expect(deleteMissing.statusCode).toBe(404);
    await app.close();
  });

  it('clears sensitive flag without deleting the SMW ontology property', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'sensitive-process-owner',
        name: 'Владелец процесса',
        description: 'Ответственное подразделение или роль',
        indexed: false,
        aiExtractable: true,
        sensitive: true,
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().values).toMatchObject({
      id: 'sensitive-process-owner',
      name: 'Владелец процесса',
      indexed: false,
      aiExtractable: true,
      sensitive: true,
    });

    const cleared = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
      payload: {
        id: 'sensitive-process-owner',
        name: 'Владелец процесса',
        sensitive: false,
      },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().values).toMatchObject({
      id: 'sensitive-process-owner',
      name: 'Владелец процесса',
      indexed: false,
      aiExtractable: true,
      sensitive: false,
    });

    const afterClear = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/ontology',
      headers: { cookie: 'mw=1' },
    });
    expect(afterClear.statusCode).toBe(200);
    expect(afterClear.json().values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sensitive-process-owner',
          name: 'Владелец процесса',
          sensitive: false,
        }),
      ])
    );
    await app.close();
  });

  it('starts syncer reindex with safe defaults', async () => {
    startSyncerReindex.mockResolvedValueOnce({
      status: {
        state: 'running',
        runId: 'run-lexical-1',
        startedAt: '2026-05-31T00:00:00.000Z',
        progress: {
          runId: 'run-lexical-1',
          startedAt: '2026-05-31T00:00:00.000Z',
          totalPages: 3,
          processed: 0,
          failed: 0,
          totalChunks: 0,
          targetWrites: {},
        },
      },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { cookie: 'mw=1' },
      payload: { maxPages: 3, namespaces: [3000], attachmentsEnabled: true },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().status.runId).toBe('run-lexical-1');
    expect(res.json().status.progress.targetWrites).toEqual({});
    expect(startSyncerReindex).toHaveBeenCalledWith(expect.objectContaining({
      attachmentsEnabled: true,
      semanticFactsEnabled: undefined,
      maxPages: 3,
      namespaces: [3000],
      chunkingPolicy: expect.objectContaining({
        sources: expect.objectContaining({
          wiki_page: expect.objectContaining({ chunkSize: 800 }),
        }),
      }),
    }));
    expect(res.json().status.state).toBe('running');
    await app.close();
  });

  it('starts syncer reindex with explicit LLM enrichment settings', async () => {
    startSyncerReindex.mockResolvedValueOnce({
      status: {
        state: 'running',
        startedAt: '2026-05-31T00:00:00.000Z',
      },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { cookie: 'mw=1' },
      payload: {
        maxPages: 2,
        dryRun: false,
        llmEnrichmentEnabled: true,
        llmEnrichmentModel: 'gpt-4.1-mini',
        llmEnrichmentMaxChars: 1500,
      },
    });

    expect(res.statusCode).toBe(202);
    expect(startSyncerReindex).toHaveBeenCalledWith(expect.objectContaining({
      attachmentsEnabled: false,
      semanticFactsEnabled: undefined,
      maxPages: 2,
      namespaces: undefined,
      dryRun: false,
      llmEnrichmentEnabled: true,
      llmEnrichmentModel: 'gpt-4.1-mini',
      llmEnrichmentMaxChars: 1500,
      chunkingPolicy: expect.objectContaining({
        sources: expect.objectContaining({
          attachment_text: expect.objectContaining({ chunkSize: 1200 }),
        }),
      }),
    }));
    await app.close();
  });

  it('returns current syncer reindex status when a reindex job is already running', async () => {
    startSyncerReindex.mockRejectedValueOnce(Object.assign(
      new Error('Reindex job is already running'),
      {
        statusCode: 409,
        responseBody: {
          status: {
            state: 'running',
            startedAt: '2026-05-31T00:00:00.000Z',
            progress: { totalPages: 10, processed: 8, failed: 0, totalChunks: 8 },
          },
        },
      }
    ));

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers: { cookie: 'mw=1' },
      payload: { maxPages: 10 },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().status.state).toBe('running');
    expect(res.json().status.progress.processed).toBe(8);
    expect(res.json().message).toBe('Reindex job is already running');
    await app.close();
  });

  it('reads syncer reindex status', async () => {
    getSyncerReindexStatus.mockResolvedValueOnce({
      status: {
        state: 'completed',
        runId: 'run-lexical-2',
        summary: {
          runId: 'run-lexical-2',
          totalPages: 34,
          processed: 34,
          failed: 0,
          targetWrites: { bm25: 34, opensearch: 34 },
        },
      },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/reindex/status',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status.state).toBe('completed');
    expect(res.json().status.summary.targetWrites).toEqual({ bm25: 34, opensearch: 34 });
    await app.close();
  });

  it('recalculates trust after completed non-dry-run reindex status', async () => {
    getSyncerReindexStatus.mockResolvedValueOnce({
      status: {
        state: 'completed',
        startedAt: '2026-06-01T04:00:00.000Z',
        finishedAt: '2026-06-01T04:01:00.000Z',
        summary: {
          dryRun: false,
          totalPages: 1,
          processed: 1,
          failed: 0,
          totalChunks: 1,
          startedAt: '2026-06-01T04:00:00.000Z',
          finishedAt: '2026-06-01T04:01:00.000Z',
        },
      },
    });
    qdrantScroll.mockResolvedValueOnce({
      points: [
        {
          id: 120001,
          payload: {
            page_id: 12,
            title: 'CorpIT:Инструкция VPN',
            text: 'approved',
            namespace: 3030,
            allowed_groups: ['ai-it'],
            semantic_facts: { 'Статус документа': ['Утвержден'] },
          },
        },
      ],
      next_page_offset: null,
    });
    qdrantSetPayload.mockResolvedValueOnce({ status: 'completed', operation_id: 1 });

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/reindex/status',
      headers: { cookie: 'mw=1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trustRecalculation).toMatchObject({
      status: 'completed',
      jobKey: '2026-06-01T04:00:00.000Z:2026-06-01T04:01:00.000Z',
    });
    expect(qdrantSetPayload).toHaveBeenCalledWith(
      'test_chunks',
      expect.objectContaining({
        points: [120001],
        wait: true,
      })
    );
    await app.close();
  });

  it('rejects invalid admin config payloads with typed 400 responses', async () => {
    const app = await makeApp();
    const headers = { cookie: 'mw=1' };
    const cases: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown; error: string }> = [
      { method: 'POST', url: '/api/admin/external-api/config', payload: { maxTopK: 0 }, error: 'Invalid external API config' },
      { method: 'POST', url: '/api/admin/llm/config', payload: { timeoutMs: 1 }, error: 'Invalid LLM config' },
      { method: 'POST', url: '/api/admin/llm/config', payload: { searchHistoryLimit: 0 }, error: 'Invalid LLM config' },
      { method: 'POST', url: '/api/admin/embedding/config', payload: { provider: 'bad-provider' }, error: 'Invalid embedding config' },
      { method: 'POST', url: '/api/admin/service-config', payload: { opensearch: { enabled: true, baseUrl: 'not-a-url' } }, error: 'Invalid service config' },
      { method: 'POST', url: '/api/admin/service-config', payload: { opensearch: { enabled: true, baseUrl: 'ftp://opensearch:9200' } }, error: 'Invalid service config' },
      { method: 'POST', url: '/api/admin/conflict-detection/config', payload: { trustGapThreshold: 2 }, error: 'Invalid conflict detection config' },
      { method: 'POST', url: '/api/admin/indexing-profiles', payload: { id: 'bad profile id' }, error: 'Invalid indexing profile' },
      { method: 'POST', url: '/api/admin/webhook/config', payload: { syncerUrl: 'not-a-url' }, error: 'Invalid webhook config' },
      { method: 'POST', url: '/api/admin/chat-retention/config', payload: { activeDays: 0 }, error: 'Invalid chat retention config' },
      { method: 'POST', url: '/api/admin/document-processing', payload: { mimeTypes: { 'application/pdf': { mode: 'vision' } } }, error: 'Invalid document processing config' },
      { method: 'GET', url: '/api/admin/semantic/search', error: 'Query parameter "property" is required' },
      { method: 'POST', url: '/api/admin/smw/autofill/config', payload: { minConfidence: 2 }, error: 'Invalid semantic autofill config' },
      { method: 'GET', url: '/api/admin/smw/autofill/status?state=bad', error: 'Semantic autofill status failed' },
      { method: 'POST', url: '/api/admin/smw/autofill/reset-ownership', payload: {}, error: 'Semantic autofill ownership reset failed' },
      { method: 'POST', url: '/api/admin/trust-models', payload: { id: 'bad model id' }, error: 'Invalid trust model' },
      { method: 'POST', url: '/api/admin/trust-recalculation/config', payload: { intervalMinutes: 1 }, error: 'Invalid trust recalculation config' },
      { method: 'POST', url: '/api/admin/trust-scores/recalculate', payload: { dryRun: true }, error: 'Trust recalculation failed' },
    ];

    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        headers,
        payload: item.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe(item.error);
    }

    await app.close();
  });

  it('reports missing trust resources as 404 responses', async () => {
    const app = await makeApp();
    const headers = { cookie: 'mw=1' };

    const missingRules = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-models/missing/rules',
      headers,
    });
    const missingEntityRules = await app.inject({
      method: 'GET',
      url: '/api/admin/trust-models/missing/entities/entity/rules',
      headers,
    });
    const invalidEntity = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/missing/entities',
      headers,
      payload: { id: 'entity', entityType: 'namespace', name: 'Namespace', value: '3030' },
    });
    const invalidRule = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/missing/rules',
      headers,
      payload: {
        id: 'rule',
        name: 'Rule',
        condition: { field: 'namespace', operator: 'equals', value: '3030' },
      },
    });
    const missingPreview = await app.inject({
      method: 'POST',
      url: '/api/admin/trust-models/missing/preview',
      headers,
      payload: { title: 'Missing', namespace: 0 },
    });

    expect(missingRules.statusCode).toBe(404);
    expect(missingEntityRules.statusCode).toBe(404);
    expect(invalidEntity.statusCode).toBe(404);
    expect(invalidRule.statusCode).toBe(404);
    expect(missingPreview.statusCode).toBe(404);
    await app.close();
  });

  it('guards internal endpoints with admin tokens and validates internal payloads', async () => {
    config.syncerAdminToken = 'internal-token';
    const app = await makeApp();
    const invalidHeaders = { 'x-wikiai-admin-token': 'wrong' };
    const validHeaders = { 'x-wikiai-admin-token': 'internal-token' };

    const guarded = [
      await app.inject({ method: 'GET', url: '/api/internal/embedding/config', headers: invalidHeaders }),
      await app.inject({ method: 'GET', url: '/api/internal/indexing-profiles', headers: invalidHeaders }),
      await app.inject({ method: 'GET', url: '/api/internal/indexing-automation', headers: invalidHeaders }),
      await app.inject({ method: 'GET', url: '/api/internal/rag/chunking-policy', headers: invalidHeaders }),
      await app.inject({ method: 'POST', url: '/api/internal/embedding/vector', headers: invalidHeaders, payload: { text: 'x' } }),
      await app.inject({ method: 'POST', url: '/api/internal/reindex/llm-enrich', headers: invalidHeaders, payload: { title: 'T', text: 'x' } }),
      await app.inject({ method: 'POST', url: '/api/internal/trust/recalculate-page', headers: invalidHeaders, payload: { pageId: 1 } }),
      await app.inject({ method: 'GET', url: '/api/internal/smw/indexed-properties', headers: invalidHeaders }),
      await app.inject({ method: 'POST', url: '/api/internal/smw/autofill/evaluate', headers: invalidHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/smw/autofill/applied', headers: invalidHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/search-index/page', headers: invalidHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/search-index/delete-page', headers: invalidHeaders, payload: { pageId: 1 } }),
    ];
    for (const response of guarded) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('Invalid internal admin token');
    }

    const embeddingConfig = await app.inject({
      method: 'GET',
      url: '/api/internal/embedding/config',
      headers: validHeaders,
    });
    expect(embeddingConfig.statusCode).toBe(200);
    expect(embeddingConfig.json().metadata.secretsRedacted).toBe(true);

    const indexingProfiles = await app.inject({
      method: 'GET',
      url: '/api/internal/indexing-profiles',
      headers: validHeaders,
    });
    expect(indexingProfiles.statusCode).toBe(200);
    expect(indexingProfiles.json().values[0]).toMatchObject({ id: 'default' });

    const indexingAutomation = await app.inject({
      method: 'GET',
      url: '/api/internal/indexing-automation',
      headers: validHeaders,
    });
    expect(indexingAutomation.statusCode).toBe(200);
    expect(indexingAutomation.json().values).toMatchObject({
      scheduleEnabled: false,
      scheduleIntervalMinutes: 1440,
    });

    const chunkingPolicy = await app.inject({
      method: 'GET',
      url: '/api/internal/rag/chunking-policy',
      headers: validHeaders,
    });
    expect(chunkingPolicy.statusCode).toBe(200);
    expect(chunkingPolicy.json().values).toMatchObject({
      sources: expect.objectContaining({
        wiki_page: expect.objectContaining({ chunkSize: 800 }),
      }),
    });
    expect(chunkingPolicy.json().metadata.secretsRedacted).toBe(true);

    const invalidPayloads = [
      await app.inject({ method: 'POST', url: '/api/internal/embedding/vector', headers: validHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/reindex/llm-enrich', headers: validHeaders, payload: { title: '', text: '' } }),
      await app.inject({ method: 'POST', url: '/api/internal/trust/recalculate-page', headers: validHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/smw/autofill/evaluate', headers: validHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/smw/autofill/applied', headers: validHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/search-index/page', headers: validHeaders, payload: {} }),
      await app.inject({ method: 'POST', url: '/api/internal/search-index/delete-page', headers: validHeaders, payload: {} }),
    ];
    expect(invalidPayloads.map((response) => response.statusCode)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    await app.close();
  });

  it('serves semantic autofill admin routes and missing chat session fallbacks', async () => {
    const app = await makeApp();
    const headers = { cookie: 'mw=1' };

    const configRead = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/autofill/config',
      headers,
    });
    expect(configRead.statusCode).toBe(200);
    expect(configRead.json().values).toMatchObject({
      enabled: true,
      mode: 'apply_empty',
      writeTarget: 'managed_block',
      managedTemplateName: 'WikiAI Semantic',
    });

    const saved = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/autofill/config',
      headers,
      payload: {
        enabled: true,
        mode: 'suggest_only',
        writeTarget: 'managed_block',
        minConfidence: 0.75,
        templates: ['Корпоративный документ'],
        namespaces: [3030],
        managedTemplateName: 'WikiAI Semantic',
        managedBlockProfile: 'demo',
        skipIfUserFactExists: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().values).toMatchObject({
      enabled: true,
      writeTarget: 'managed_block',
      minConfidence: 0.75,
      namespaces: [3030],
      managedBlockProfile: 'demo',
    });

    const applied = await app.inject({
      method: 'POST',
      url: '/api/internal/smw/autofill/applied',
      payload: {
        pageId: 90,
        title: 'CorpIT:Service Desk',
        revId: 901,
        fields: [{ property: 'Департамент', value: 'ИТ', confidence: 0.9 }],
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().values.updated).toBe(1);

    const status = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/autofill/status?state=auto&property=%D0%94%D0%B5%D0%BF%D0%B0%D1%80%D1%82%D0%B0%D0%BC%D0%B5%D0%BD%D1%82&title=Service&limit=5',
      headers,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().values.records[0]).toMatchObject({
      pageId: 90,
      property: 'Департамент',
      lastAiValue: 'ИТ',
    });

    const test = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/autofill/test',
      headers,
      payload: {
        pageId: 91,
        title: 'CorpIT:Service Desk',
        namespace: 3030,
        content: '{{Корпоративный документ\n|Департамент=\n}}\nBody',
      },
    });
    expect(test.statusCode).toBe(200);
    expect(test.json().values).toMatchObject({
      enabled: true,
      writeTarget: 'managed_block',
      diagnostics: { llmCalled: true },
    });

    const reset = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/autofill/reset-ownership',
      headers,
      payload: { pageId: 90, property: 'Департамент' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().values.updated).toBe(1);

    const missingArchive = await app.inject({
      method: 'POST',
      url: '/api/admin/chat-sessions/missing/archive',
      headers,
      payload: {},
    });
    const missingExport = await app.inject({
      method: 'POST',
      url: '/api/admin/chat-sessions/missing/export',
      headers,
      payload: { format: 'xml' },
    });
    expect(missingArchive.statusCode).toBe(404);
    expect(missingExport.statusCode).toBe(404);
    await app.close();
  });

  it('reports ontology and reindex failure branches without leaking upstream errors', async () => {
    const app = await makeApp();
    const headers = { cookie: 'mw=1' };

    const invalidOntology = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology',
      headers,
      payload: { name: '' },
    });
    const deleteMissingOntology = await app.inject({
      method: 'DELETE',
      url: '/api/admin/smw/ontology/missing',
      headers,
    });
    const generateMissingVector = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology/missing/generate-vector',
      headers,
    });
    const missingSimilarities = await app.inject({
      method: 'GET',
      url: '/api/admin/smw/ontology/missing/similarities?threshold=bad&limit=bad',
      headers,
    });
    const invalidClassification = await app.inject({
      method: 'POST',
      url: '/api/admin/smw/ontology/classify-fragment',
      headers,
      payload: {},
    });

    expect(invalidOntology.statusCode).toBe(400);
    expect(invalidOntology.json().error).toBe('Invalid ontology property');
    expect(deleteMissingOntology.statusCode).toBe(404);
    expect(deleteMissingOntology.json().error).toBe('Ontology property delete failed');
    expect(generateMissingVector.statusCode).toBe(400);
    expect(generateMissingVector.json().error).toBe('Ontology vector generation failed');
    expect(missingSimilarities.statusCode).toBe(400);
    expect(missingSimilarities.json().error).toBe('Ontology similarities failed');
    expect(invalidClassification.statusCode).toBe(400);
    expect(invalidClassification.json().error).toBe('Ontology fragment classification failed');

    const profileError = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers,
      payload: { profileId: 'missing' },
    });
    expect(profileError.statusCode).toBe(400);
    expect(profileError.json()).toMatchObject({
      error: 'Unable to start syncer reindex',
      message: 'Indexing profile not found: missing',
    });

    startSyncerReindex.mockRejectedValueOnce(Object.assign(new Error('Syncer rejected request'), {
      statusCode: 409,
      responseBody: {},
    }));
    const conflictWithoutStatus = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers,
      payload: { maxPages: 1 },
    });
    expect(conflictWithoutStatus.statusCode).toBe(409);

    startSyncerReindex.mockRejectedValueOnce(new Error('syncer offline'));
    const upstreamFailure = await app.inject({
      method: 'POST',
      url: '/api/admin/reindex',
      headers,
      payload: { maxPages: 1 },
    });
    expect(upstreamFailure.statusCode).toBe(502);

    getSyncerReindexStatus.mockRejectedValueOnce(new Error('status unavailable'));
    const statusFailure = await app.inject({
      method: 'GET',
      url: '/api/admin/reindex/status',
      headers,
    });
    expect(statusFailure.statusCode).toBe(502);
    expect(statusFailure.json().error).toBe('Unable to read syncer reindex status');

    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log?limit=bad',
      headers,
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().values).toEqual(expect.any(Array));
    await app.close();
  });
});
