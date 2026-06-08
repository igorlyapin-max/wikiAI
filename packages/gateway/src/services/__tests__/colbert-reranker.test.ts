import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteColbertIndexPage,
  rerankChunksWithColbert,
  searchColbertIndex,
  syncColbertIndexPage,
  testColbertReranker,
} from '../colbert-reranker.js';
import { RagAdminConfig } from '../admin-platform-config.js';
import { SearchChunk } from '../../types/index.js';

const baseConfig: RagAdminConfig = {
  chunkSize: 512,
  chunkOverlap: 50,
  chunkSeparators: ['\n\n'],
  chunkingPolicy: {
    defaults: { chunkSize: 512, chunkOverlap: 50, chunkSeparators: ['\n\n'] },
    sources: {
      wiki_page: { chunkSize: 800, chunkOverlap: 120, chunkSeparators: ['\n\n'] },
      attachment_text: { chunkSize: 1200, chunkOverlap: 180, chunkSeparators: ['\n\n'] },
      attachment_metadata: { chunkSize: 512, chunkOverlap: 0, chunkSeparators: ['\n\n'] },
      cmdb_dynamic_snapshot: { chunkSize: 900, chunkOverlap: 120, chunkSeparators: ['\n\n'] },
    },
    namespaceOverrides: {},
  },
  minChunkLength: 40,
  maxChunksPerPage: 500,
  retrievalTopK: 4,
  contextTopK: 4,
  contextMaxChars: 12000,
  chatRetrievalQueryMode: 'current_message',
  topK: 4,
  maxContextChunks: 4,
  maxContextChars: 12000,
  minSearchScore: 0,
  searchMode: 'hybrid',
  rerankMode: 'none',
  vectorWeight: 0.65,
  lexicalWeight: 0.35,
  lexicalBackend: 'sqlite_fts',
  vectorCandidateLimit: 50,
  lexicalCandidateLimit: 50,
  lexicalMinMatchedTerms: 2,
  lexicalGateMode: 'when_bm25_available',
  lexicalNormalizationMode: 'simple_stem',
  lexicalSynonymsEnabled: false,
  lexicalSynonyms: [],
  lexicalTransliterationEnabled: false,
  lexicalEditDistanceEnabled: false,
  trigramIndexEnabled: false,
  trigramCandidateLimit: 50,
  trigramMinQueryLength: 4,
  vectorOnlyFallbackEnabled: true,
  vectorOnlyFallbackMinScore: 0.78,
  minFinalScore: 0,
  showRawScores: false,
  colbertEnabled: false,
  colbertBaseUrl: '',
  colbertModel: 'antoinelouis/colbert-xm',
  colbertCollection: 'wiki_colbert_chunks',
  colbertCandidateLimit: 50,
  colbertTimeoutMs: 5000,
  colbertMinScore: 0,
  colbertTailDropEnabled: false,
  colbertTailMaxGap: 0.2,
  colbertTailMinScore: 0.7,
  colbertTailMinKeep: 1,
  colbertFailMode: 'fallback_current',
  semanticFactsInContext: true,
  includeAttachments: false,
  includeSemanticHeader: true,
};

const chunks: SearchChunk[] = [
  {
    id: 1,
    pageId: 11,
    title: 'CorpIT:Администрирование систем',
    text: 'Регламент администрирования информационных систем.',
    namespace: 3030,
    allowedGroups: ['ai-it'],
    score: 0.8,
  },
  {
    id: 2,
    pageId: 12,
    title: 'Древний Египет',
    text: 'Историческая статья о древней цивилизации.',
    namespace: 0,
    allowedGroups: ['*'],
    score: 0.79,
  },
];

const tailChunks: SearchChunk[] = [
  ...chunks,
  {
    id: 3,
    pageId: 13,
    title: 'Тестовая страница ИИ',
    text: 'Общая тестовая страница без прямого отношения к запросу.',
    namespace: 0,
    allowedGroups: ['*'],
    score: 0.78,
  },
];

function enabledConfig(overrides: Partial<RagAdminConfig> = {}): RagAdminConfig {
  return {
    ...baseConfig,
    rerankMode: 'colbert_v2',
    colbertEnabled: true,
    colbertBaseUrl: 'http://colbert.internal:8080',
    colbertModel: 'colbert-v2-multilingual',
    ...overrides,
  };
}

describe('ColBERT reranker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns current ordering when rerank is disabled', async () => {
    const result = await rerankChunksWithColbert({
      query: 'администрирование систем',
      chunks,
      topK: 1,
      config: baseConfig,
    });

    expect(result.chunks).toEqual([chunks[0]]);
    expect(result.diagnostics).toMatchObject({
      rerankMode: 'none',
      colbertApplied: false,
      colbertFallbackUsed: false,
    });
  });

  it('applies ColBERT ordering and score when service responds', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 2, score: 0.91 },
          { id: 1, score: 0.83 },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await rerankChunksWithColbert({
      query: 'древние цивилизации',
      chunks,
      topK: 2,
      config: enabledConfig(),
    });

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([2, 1]);
    expect(result.chunks[0].scores).toMatchObject({
      colbert: 0.91,
      final: 0.91,
    });
    expect(result.diagnostics).toMatchObject({
      rerankMode: 'colbert_v2',
      colbertApplied: true,
      colbertCandidates: 2,
      colbertScores: [
        { id: 2, score: 0.91 },
        { id: 1, score: 0.83 },
      ],
      tailSourcesBelowThreshold: 0,
      colbertFallbackUsed: false,
    });
  });

  it('filters weak ColBERT tail below the configured minimum score', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 2, score: 0.91 },
          { id: 1, score: 0.54 },
        ],
      }),
    })));

    const result = await rerankChunksWithColbert({
      query: 'молекуляр',
      chunks,
      topK: 2,
      config: enabledConfig({ colbertMinScore: 0.58 }),
    });

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([2]);
    expect(result.diagnostics).toMatchObject({
      rerankMode: 'colbert_v2',
      colbertApplied: true,
      colbertCandidates: 2,
      colbertScores: [
        { id: 2, score: 0.91 },
        { id: 1, score: 0.54 },
      ],
      tailSourcesBelowThreshold: 1,
      colbertFallbackUsed: false,
    });
  });

  it('drops weak post-rerank ColBERT tail by score gap and tail minimum', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 2, score: 0.91 },
          { id: 1, score: 0.69 },
          { id: 3, score: 0.58 },
        ],
      }),
    })));

    const result = await rerankChunksWithColbert({
      query: 'технологии 5g',
      chunks: tailChunks,
      topK: 3,
      config: enabledConfig({
        colbertMinScore: 0.58,
        colbertTailDropEnabled: true,
        colbertTailMaxGap: 0.2,
        colbertTailMinScore: 0.6,
        colbertTailMinKeep: 1,
      }),
    });

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([2]);
    expect(result.diagnostics).toMatchObject({
      colbertTailDropEnabled: true,
      colbertTailDropped: 2,
      colbertTailDropReasons: {
        belowTailMinScore: 1,
        scoreGap: 1,
      },
      colbertTailBestScore: 0.91,
      colbertTailMinAcceptedScore: 0.91,
      colbertTailThresholds: {
        minScore: 0.6,
        maxGap: 0.2,
        minKeep: 1,
      },
    });
  });

  it('keeps the configured minimum number of ColBERT tail results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 2, score: 0.91 },
          { id: 1, score: 0.7 },
          { id: 3, score: 0.69 },
        ],
      }),
    })));

    const result = await rerankChunksWithColbert({
      query: 'технологии 5g',
      chunks: tailChunks,
      topK: 3,
      config: enabledConfig({
        colbertTailDropEnabled: true,
        colbertTailMaxGap: 0.01,
        colbertTailMinScore: 0.9,
        colbertTailMinKeep: 2,
      }),
    });

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([2, 1]);
    expect(result.diagnostics).toMatchObject({
      colbertTailDropped: 1,
      colbertTailThresholds: {
        minScore: 0.9,
        maxGap: 0.01,
        minKeep: 2,
      },
    });
  });

  it('preserves ColBERT tail results when tail drop is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 2, score: 0.91 },
          { id: 1, score: 0.69 },
          { id: 3, score: 0.58 },
        ],
      }),
    })));

    const result = await rerankChunksWithColbert({
      query: 'технологии 5g',
      chunks: tailChunks,
      topK: 3,
      config: enabledConfig({
        colbertMinScore: 0.58,
        colbertTailDropEnabled: false,
        colbertTailMaxGap: 0.2,
        colbertTailMinScore: 0.6,
      }),
    });

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([2, 1, 3]);
    expect(result.diagnostics).toMatchObject({
      colbertTailDropEnabled: false,
      colbertTailDropped: 0,
    });
  });

  it('falls back to current ordering when service fails and fallback is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({}),
    })));

    const result = await rerankChunksWithColbert({
      query: 'администрирование систем',
      chunks,
      topK: 1,
      config: enabledConfig(),
    });

    expect(result.chunks).toEqual([chunks[0]]);
    expect(result.diagnostics).toMatchObject({
      colbertApplied: false,
      colbertFallbackUsed: true,
      colbertError: 'ColBERT rerank error: 502 Bad Gateway',
    });
  });

  it('throws when service fails and fail_search is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({}),
    })));

    await expect(rerankChunksWithColbert({
      query: 'администрирование систем',
      chunks,
      topK: 1,
      config: enabledConfig({ colbertFailMode: 'fail_search' }),
    })).rejects.toThrow('ColBERT rerank error: 502 Bad Gateway');
  });

  it('searches the full ColBERT index and maps payload fields to chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [{
          id: 110001,
          score: 0.94,
          pageId: 11,
          title: 'CorpIT:Администрирование систем',
          text: 'Регламент администрирования информационных систем.',
          namespace: 3030,
          allowedGroups: ['ai-it'],
          chunkIndex: 1,
          totalChunks: 3,
          lastModified: '2026-06-01T10:00:00Z',
        }],
      }),
    })));

    const result = await searchColbertIndex({
      query: 'администрирование систем',
      topK: 1,
      fallbackTopK: 4,
      config: enabledConfig({
        searchMode: 'colbert_full',
        colbertCollection: 'wiki_colbert_chunks',
      }),
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      id: 110001,
      pageId: 11,
      title: 'CorpIT:Администрирование систем',
      allowedGroups: ['ai-it'],
      scores: { colbert: 0.94, final: 0.94 },
    });
    expect(result.diagnostics).toMatchObject({
      searchMode: 'colbert_full',
      colbertIndexApplied: true,
      colbertCandidates: 1,
    });
  });

  it('syncs and deletes ColBERT index pages through the service', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const config = enabledConfig({
      searchMode: 'colbert_full',
      colbertCollection: 'wiki_colbert_chunks',
    });

    await expect(syncColbertIndexPage({
      pageId: 11,
      title: 'CorpIT:Администрирование систем',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      lastModified: '2026-06-01T10:00:00Z',
      chunks: [{
        id: 110000,
        text: 'Регламент администрирования информационных систем.',
        chunkIndex: 0,
        totalChunks: 1,
      }],
    }, config)).resolves.toMatchObject({
      status: 'ok',
      url: 'http://colbert.internal:8080/index/page',
      chunks: 1,
    });
    await expect(deleteColbertIndexPage(11, config)).resolves.toMatchObject({
      status: 'ok',
      url: 'http://colbert.internal:8080/index/delete-page',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses candidate model and collection overrides for index writes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await syncColbertIndexPage({
      pageId: 11,
      title: 'Candidate',
      namespace: 0,
      allowedGroups: ['*'],
      colbertModel: 'candidate-model',
      colbertCollection: 'candidate_collection',
      chunks: [{
        id: 110000,
        text: 'Candidate chunk',
        chunkIndex: 0,
        totalChunks: 1,
        mimeType: 'text/plain',
        processingMode: 'text',
      }],
    }, enabledConfig({
      colbertModel: 'active-model',
      colbertCollection: 'active_collection',
    }));

    const firstCall = fetchMock.mock.calls.at(0) as unknown as [string, { body?: unknown }];
    expect(JSON.parse(String(firstCall[1].body))).toMatchObject({
      model: 'candidate-model',
      collection: 'candidate_collection',
      chunks: [
        expect.objectContaining({
          mimeType: 'text/plain',
          processingMode: 'text',
        }),
      ],
    });
  });

  it('reads ColBERT health collection counters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        status: 'ok',
        model: 'antoinelouis/colbert-xm',
        collection: 'wiki_colbert_chunks',
        collectionStatus: {
          exists: true,
          points: 105,
          vectors: 105,
        },
      }),
    })));

    await expect(testColbertReranker(enabledConfig())).resolves.toMatchObject({
      status: 'ok',
      url: 'http://colbert.internal:8080/health',
      collection: 'wiki_colbert_chunks',
      collectionStatus: {
        exists: true,
        points: 105,
        vectors: 105,
      },
    });
  });
});
