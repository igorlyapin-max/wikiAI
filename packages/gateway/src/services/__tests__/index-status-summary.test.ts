import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWikiPages = vi.hoisted(() => vi.fn());
const getOpenSearchPageSet = vi.hoisted(() => vi.fn());
const getOpenSearchStatus = vi.hoisted(() => vi.fn());
const getSearchIndexPageSet = vi.hoisted(() => vi.fn());
const getSearchIndexStatus = vi.hoisted(() => vi.fn());
const getSyncerReindexSourceDiagnostics = vi.hoisted(() => vi.fn());
const getSyncerReindexStatus = vi.hoisted(() => vi.fn());
const testColbertReranker = vi.hoisted(() => vi.fn());

vi.mock('../mediawiki.js', () => ({
  fetchWikiPages,
}));

vi.mock('../opensearch.js', () => ({
  getOpenSearchPageSet,
  getOpenSearchStatus,
}));

vi.mock('../search-index.js', () => ({
  getSearchIndexPageSet,
  getSearchIndexStatus,
}));

vi.mock('../syncer-admin.js', () => ({
  getSyncerReindexSourceDiagnostics,
  getSyncerReindexStatus,
}));

vi.mock('../colbert-reranker.js', () => ({
  testColbertReranker,
}));

describe('index status summary', () => {
  beforeEach(() => {
    fetchWikiPages.mockReset();
    fetchWikiPages.mockResolvedValue([
      { pageId: 101, title: 'Page 1', namespace: 0 },
      { pageId: 102, title: 'Page 2', namespace: 0 },
    ]);
    getSyncerReindexSourceDiagnostics.mockReset();
    getSyncerReindexSourceDiagnostics.mockResolvedValue({
      values: {
        source: 'qdrant_payload',
        mediaWikiNamespaces: [0],
        mediaWikiPages: 2,
        denseCollection: 'wiki_chunks',
        qdrantPayloadPoints: 2,
        qdrantPayloadPages: 2,
        qdrantPayloadGroups: 1,
        qdrantPayloadChunks: 2,
        densePagesBehindMediaWiki: false,
      },
    });
    getSearchIndexStatus.mockReset();
    getSearchIndexStatus.mockResolvedValue({
      chunks: 2,
      ftsChunks: 2,
      trigramChunks: 2,
      trigramFtsChunks: 2,
      attachmentChunks: 0,
      attachmentPages: 0,
      attachmentFilenames: [],
      attachmentColumnsReady: true,
      pages: 2,
      populated: true,
      backfillRecommended: false,
      trigramPopulated: true,
      trigramBackfillRecommended: false,
    });
    getSearchIndexPageSet.mockReset();
    getSearchIndexPageSet.mockResolvedValue({
      pages: [
        { pageId: 101, title: 'Page 1', chunks: 1, attachmentChunks: 0 },
        { pageId: 102, title: 'Page 2', chunks: 1, attachmentChunks: 0 },
      ],
      limit: 500,
      truncated: false,
    });
    getOpenSearchStatus.mockReset();
    getOpenSearchStatus.mockResolvedValue({
      status: 'ok',
      ready: true,
      enabled: true,
      url: 'http://opensearch:9200',
      indexName: 'wikiai_chunks',
      authConfigured: false,
      analyzer: 'standard',
      candidateLimit: 50,
      timeoutMs: 5000,
      tlsRejectUnauthorized: true,
      documentCount: 2,
    });
    getOpenSearchPageSet.mockReset();
    getOpenSearchPageSet.mockResolvedValue({
      status: 'ok',
      ready: true,
      enabled: true,
      indexName: 'wikiai_chunks',
      pages: [
        { pageId: 101, title: 'Page 1', docs: 1 },
        { pageId: 102, title: 'Page 2', docs: 1 },
      ],
      totalPages: 2,
      limit: 500,
      truncated: false,
    });
    getSyncerReindexStatus.mockReset();
    testColbertReranker.mockReset();
  });

  it('does not mark ColBERT empty after a lexical-only rebuild when the live collection has points', async () => {
    getSyncerReindexStatus.mockResolvedValue({
      status: {
        state: 'completed',
        summary: {
          indexTargets: ['bm25', 'opensearch'],
          processed: 2,
          totalPages: 2,
          totalChunks: 2,
          colbertPagesIndexed: 0,
          colbertChunksIndexed: 0,
        },
      },
    });
    testColbertReranker.mockResolvedValue({
      status: 'ok',
      url: 'http://colbert:8080/health',
      latencyMs: 3,
      collection: 'wiki_colbert_chunks',
      collectionStatus: { exists: true, points: 105, vectors: 105 },
    });

    const { getIndexStatusSummary } = await import('../index-status-summary.js');
    const summary = await getIndexStatusSummary();

    expect(getSearchIndexPageSet).toHaveBeenCalledWith(500, { namespaces: [0] });
    expect(getOpenSearchPageSet).toHaveBeenCalledWith(500, { namespaces: [0] });
    expect(summary.indexes.colbert).toMatchObject({
      status: 'ok',
      collection: 'wiki_colbert_chunks',
      chunks: 105,
      points: 105,
      source: 'live_health',
      lastReindexIncludedColbert: false,
    });
    expect(summary.recommendations).not.toContain('Run dense + ColBERT reindex for MediaWiki source.');
  });

  it('passes the requested namespace scope to BM25 and OpenSearch page diagnostics', async () => {
    getSyncerReindexSourceDiagnostics.mockResolvedValueOnce({
      values: {
        source: 'qdrant_payload',
        mediaWikiNamespaces: [0, 3030],
        mediaWikiPages: 2,
        denseCollection: 'wiki_chunks',
        qdrantPayloadPoints: 2,
        qdrantPayloadPages: 2,
        qdrantPayloadGroups: 1,
        qdrantPayloadChunks: 2,
        densePagesBehindMediaWiki: false,
      },
    });
    fetchWikiPages.mockResolvedValueOnce([
      { pageId: 101, title: 'Page 1', namespace: 0 },
      { pageId: 201, title: 'CorpIT:VPN', namespace: 3030 },
    ]);
    getSearchIndexPageSet.mockResolvedValueOnce({
      pages: [
        { pageId: 101, title: 'Page 1', chunks: 1, attachmentChunks: 0 },
        { pageId: 201, title: 'CorpIT:VPN', chunks: 1, attachmentChunks: 0 },
      ],
      limit: 500,
      truncated: false,
    });
    getOpenSearchPageSet.mockResolvedValueOnce({
      status: 'ok',
      ready: true,
      enabled: true,
      indexName: 'wikiai_chunks',
      pages: [
        { pageId: 101, title: 'Page 1', docs: 1 },
        { pageId: 201, title: 'CorpIT:VPN', docs: 1 },
      ],
      totalPages: 2,
      limit: 500,
      truncated: false,
    });
    getSyncerReindexStatus.mockResolvedValue({
      status: { state: 'completed', summary: { indexTargets: ['bm25', 'opensearch'] } },
    });
    testColbertReranker.mockResolvedValue({
      status: 'ok',
      url: 'http://colbert:8080/health',
      latencyMs: 3,
      collectionStatus: { exists: true, points: 1, vectors: 1 },
    });

    const { getIndexStatusSummary } = await import('../index-status-summary.js');
    const summary = await getIndexStatusSummary({ namespaces: [3030, 0] });

    expect(summary.source.namespaces).toEqual([0, 3030]);
    expect(getSearchIndexPageSet).toHaveBeenLastCalledWith(500, { namespaces: [0, 3030] });
    expect(getOpenSearchPageSet).toHaveBeenLastCalledWith(500, { namespaces: [0, 3030] });
    expect(summary.indexes.bm25.status).toBe('ok');
    expect(summary.indexes.opensearch.status).toBe('ok');
    expect(summary.recommendations).not.toContain('Run BM25/OpenSearch rebuild or full all-index reindex.');
  });

  it('warns when a ColBERT-target rebuild indexes zero chunks', async () => {
    getSyncerReindexStatus.mockResolvedValue({
      status: {
        state: 'completed',
        summary: {
          indexTargets: ['dense', 'colbert'],
          processed: 2,
          totalPages: 2,
          totalChunks: 2,
          colbertPagesIndexed: 0,
          colbertChunksIndexed: 0,
        },
      },
    });
    testColbertReranker.mockResolvedValue({
      status: 'ok',
      url: 'http://colbert:8080/health',
      latencyMs: 3,
      collection: 'wiki_colbert_chunks',
      collectionStatus: { exists: true, points: 0, vectors: 0 },
    });

    const { getIndexStatusSummary } = await import('../index-status-summary.js');
    const summary = await getIndexStatusSummary();

    expect(summary.indexes.colbert).toMatchObject({
      status: 'warning',
      points: 0,
      lastReindexIncludedColbert: true,
    });
    expect(summary.recommendations).toContain('Run dense + ColBERT reindex for MediaWiki source.');
  });

  it('keeps the summary available when ColBERT health is unavailable', async () => {
    getSyncerReindexStatus.mockResolvedValue({
      status: {
        state: 'completed',
        summary: {
          indexTargets: ['bm25', 'opensearch'],
          processed: 2,
          totalPages: 2,
          totalChunks: 2,
        },
      },
    });
    testColbertReranker.mockResolvedValue({
      status: 'error',
      url: 'http://colbert:8080/health',
      latencyMs: 3,
      error: 'HTTP 503',
    });

    const { getIndexStatusSummary } = await import('../index-status-summary.js');
    const summary = await getIndexStatusSummary();

    expect(summary.indexes.colbert).toMatchObject({
      status: 'warning',
      lastReindexIncludedColbert: false,
      error: 'HTTP 503',
    });
    expect(summary.indexes.bm25.status).toBe('ok');
  });
});
