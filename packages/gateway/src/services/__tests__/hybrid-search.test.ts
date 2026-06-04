import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { setRagAdminConfig } from '../admin-platform-config.js';
import { searchRagChunks } from '../hybrid-search.js';
import { buildFtsQuery, upsertSearchIndexPage } from '../search-index.js';
import { SearchChunk } from '../../types/index.js';

const searchChunkCandidates = vi.hoisted(() => vi.fn());
const searchOpenSearchChunksWithDiagnostics = vi.hoisted(() => vi.fn());

vi.mock('../qdrant.js', () => ({
  normalizeTopK: (topK: number | undefined, fallback = 5) => {
    const value = topK ?? fallback;
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), 1), 20);
  },
  normalizeCandidateLimit: (limit: number | undefined, fallback = 50) => {
    const value = limit ?? fallback;
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), 1), 200);
  },
  searchChunkCandidates,
}));

vi.mock('../opensearch.js', () => ({
  searchOpenSearchChunksWithDiagnostics,
}));

describe('hybrid search ranking', () => {
  const chunks: SearchChunk[] = [
    {
      id: 760000,
      pageId: 76,
      title: 'Древний Египет',
      text: 'Публичная статья о древней религиозной системе.',
      namespace: 0,
      allowedGroups: ['*'],
      score: 0.80,
    },
    {
      id: 4040001,
      pageId: 404,
      title: 'CorpIT:Администрирование систем',
      text: 'Регламент администрирования систем и доступа операторов.',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.79,
    },
  ];

  beforeEach(() => {
    resetAdminStoreForTests();
    searchChunkCandidates.mockReset();
    searchChunkCandidates.mockResolvedValue(chunks);
    searchOpenSearchChunksWithDiagnostics.mockReset();
    searchOpenSearchChunksWithDiagnostics.mockResolvedValue({
      chunks: [],
      diagnostics: {
        enabled: false,
        ready: false,
        indexName: 'wikiai_chunks',
        analyzer: 'russian',
        rawHits: 0,
        candidates: 0,
        analyzedTerms: [],
        removedTerms: [],
        latencyMs: 0,
        highlightsAvailable: false,
      },
    });
  });

  it('uses BM25 matches as a gate when lexical candidates exist', async () => {
    await setRagAdminConfig({
      searchMode: 'hybrid',
      vectorWeight: 0.65,
      lexicalWeight: 0.35,
      vectorCandidateLimit: 20,
      lexicalCandidateLimit: 20,
      lexicalMinMatchedTerms: 2,
      showRawScores: false,
    });
    await upsertSearchIndexPage({
      pageId: 76,
      title: 'Древний Египет',
      namespace: 0,
      allowedGroups: ['*'],
      lastModified: '2026-06-01T09:00:00Z',
      chunks: [
        {
          id: 760000,
          text: 'Публичная статья о древней религиозной системе.',
          chunkIndex: 0,
          totalChunks: 1,
        },
      ],
    });
    await upsertSearchIndexPage({
      pageId: 404,
      title: 'CorpIT:Администрирование систем',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      lastModified: '2026-06-01T10:00:00Z',
      chunks: [
        {
          id: 4040001,
          text: 'Регламент администрирования информационных систем и доступа операторов.',
          chunkIndex: 0,
          totalChunks: 1,
        },
      ],
    });

    const result = await searchRagChunks({
      query: 'админинистрирование информационных систем',
      vector: [0.1, 0.2, 0.3],
      topK: 2,
    });

    expect(result.mode).toBe('hybrid');
    expect(result.diagnostics).toMatchObject({
      searchMode: 'hybrid',
      lexicalGateMode: 'when_bm25_available',
      vectorCandidates: 2,
      bm25Candidates: 1,
      bm25RawCandidates: 2,
      lexicalMinMatchedTerms: 2,
      lexicalRequiredMatchedTerms: 2,
      lexicalGateApplied: true,
      vectorOnlyFallbackUsed: false,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      id: 4040001,
      title: 'CorpIT:Администрирование систем',
    });
    expect(searchChunkCandidates).toHaveBeenCalledWith([0.1, 0.2, 0.3], 20);
  });

  it('uses vector-only fallback threshold when BM25 has no candidates', async () => {
    searchChunkCandidates.mockResolvedValueOnce([
      {
        id: 760000,
        pageId: 76,
        title: 'Древний Египет',
        text: 'Историческая обзорная статья.',
        namespace: 0,
        allowedGroups: ['*'],
        score: 0.77,
      },
      {
        id: 4040001,
        pageId: 404,
        title: 'CorpIT:Администрирование систем',
        text: 'Регламент администрирования систем и доступа операторов.',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.79,
      },
    ]);
    await setRagAdminConfig({
      searchMode: 'hybrid',
      vectorOnlyFallbackEnabled: true,
      vectorOnlyFallbackMinScore: 0.78,
      lexicalCandidateLimit: 20,
      showRawScores: false,
    });

    const result = await searchRagChunks({
      query: 'нетсовпадений',
      vector: [0.1, 0.2, 0.3],
      topK: 2,
    });

    expect(result.diagnostics).toMatchObject({
      bm25Candidates: 0,
      bm25RawCandidates: 0,
      lexicalMinMatchedTerms: 2,
      lexicalRequiredMatchedTerms: 1,
      lexicalGateApplied: false,
      vectorOnlyFallbackUsed: true,
      vectorOnlyFallbackMinScore: 0.78,
    });
    expect(result.chunks).toEqual([
      expect.objectContaining({
        id: 4040001,
        title: 'CorpIT:Администрирование систем',
      }),
    ]);
  });

  it('uses OpenSearch as the lexical provider when selected by profile config', async () => {
    searchOpenSearchChunksWithDiagnostics.mockResolvedValueOnce({
      chunks: [{
        id: 760000,
        pageId: 76,
        title: 'Древний Египет',
        text: 'Одна из древнейших цивилизаций мира.',
        namespace: 0,
        allowedGroups: ['*'],
        score: 0,
        lexicalRank: 1,
        lexicalMatchedTerms: ['цивилизации'],
        lexicalMatchedTermCount: 1,
      }],
      diagnostics: {
        enabled: true,
        ready: true,
        indexName: 'wikiai_chunks',
        analyzer: 'russian',
        rawHits: 1,
        candidates: 1,
        analyzedTerms: ['цивилизации'],
        removedTerms: [],
        latencyMs: 12,
        highlightsAvailable: true,
      },
    });
    await setRagAdminConfig({
      searchMode: 'hybrid',
      lexicalBackend: 'opensearch',
      lexicalCandidateLimit: 20,
      lexicalMinMatchedTerms: 1,
      showRawScores: false,
    });

    const result = await searchRagChunks({
      query: 'как там цивилизации',
      vector: [0.1, 0.2, 0.3],
      topK: 5,
    });

    expect(searchOpenSearchChunksWithDiagnostics).toHaveBeenCalledWith(
      'как там цивилизации',
      20,
      expect.objectContaining({ lexicalBackend: 'opensearch' })
    );
    expect(result.diagnostics).toMatchObject({
      lexicalBackend: 'opensearch',
      bm25Candidates: 0,
      opensearchCandidates: 1,
      opensearchRawHits: 1,
      opensearchAnalyzedTerms: ['цивилизации'],
      opensearchHighlightsAvailable: true,
    });
    expect(result.chunks.map((chunk) => chunk.title)).toEqual(['Древний Египет']);
  });

  it('matches Russian inflections for ancient civilization queries', async () => {
    await setRagAdminConfig({
      searchMode: 'hybrid',
      lexicalMinMatchedTerms: 2,
      lexicalCandidateLimit: 20,
      showRawScores: false,
    });
    await upsertSearchIndexPage({
      pageId: 76,
      title: 'Древний Египет',
      namespace: 0,
      allowedGroups: ['*'],
      lastModified: '2026-06-01T09:00:00Z',
      chunks: [
        {
          id: 760000,
          text: 'Древний Египет — одна из древнейших цивилизаций мира.',
          chunkIndex: 0,
          totalChunks: 1,
        },
      ],
    });
    await upsertSearchIndexPage({
      pageId: 61,
      title: 'Древняя Греция',
      namespace: 0,
      allowedGroups: ['*'],
      lastModified: '2026-06-01T09:00:00Z',
      chunks: [
        {
          id: 610000,
          text: 'Древняя Греция — колыбель западной цивилизации.',
          chunkIndex: 0,
          totalChunks: 1,
        },
      ],
    });

    const result = await searchRagChunks({
      query: 'древние цивилизации',
      vector: [0.1, 0.2, 0.3],
      topK: 5,
    });

    expect(result.diagnostics).toMatchObject({
      bm25Candidates: 2,
      bm25RawCandidates: 2,
      lexicalRequiredMatchedTerms: 2,
      lexicalGateApplied: true,
      vectorOnlyFallbackUsed: false,
    });
    expect(result.chunks.map((chunk) => chunk.title)).toEqual(
      expect.arrayContaining(['Древний Египет', 'Древняя Греция'])
    );
  });

  it('matches cuisine inflections and keeps unrelated admin pages out when lexical candidates exist', async () => {
    searchChunkCandidates.mockResolvedValueOnce([
      {
        id: 1001,
        pageId: 101,
        title: 'Молекулярная гастрономия',
        text: 'Молекулярная кухня применяет научные методы приготовления.',
        namespace: 0,
        allowedGroups: ['*'],
        score: 0.73,
      },
      {
        id: 9001,
        pageId: 901,
        title: 'WikiAIAdmin:Администрирование/Обзор и состояние сервисов',
        text: 'Состояние сервисов и настройки администрирования.',
        namespace: 3040,
        allowedGroups: ['sysop', 'aiadmin'],
        score: 0.95,
      },
    ]);
    await setRagAdminConfig({
      searchMode: 'hybrid',
      vectorCandidateLimit: 20,
      lexicalCandidateLimit: 20,
      lexicalMinMatchedTerms: 1,
      showRawScores: false,
    });
    await upsertSearchIndexPage({
      pageId: 101,
      title: 'Молекулярная гастрономия',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{
        id: 1001,
        text: 'Молекулярная кухня применяет научные методы приготовления.',
        chunkIndex: 0,
        totalChunks: 1,
      }],
    });
    await upsertSearchIndexPage({
      pageId: 901,
      title: 'WikiAIAdmin:Администрирование/Обзор и состояние сервисов',
      namespace: 3040,
      allowedGroups: ['sysop', 'aiadmin'],
      chunks: [{
        id: 9001,
        text: 'Состояние сервисов и настройки администрирования.',
        chunkIndex: 0,
        totalChunks: 1,
      }],
    });

    const result = await searchRagChunks({
      query: 'еще раз про кухню',
      vector: [0.1, 0.2, 0.3],
      topK: 5,
    });

    expect(buildFtsQuery('кухню')).toBe('кухн*');
    expect(result.diagnostics).toMatchObject({
      bm25Candidates: 1,
      lexicalGateApplied: true,
      vectorOnlyFallbackUsed: false,
    });
    expect(result.chunks.map((chunk) => chunk.title)).toEqual(['Молекулярная гастрономия']);
  });

  it('does not use vector-only fallback when BM25 has only broad one-term matches', async () => {
    await upsertSearchIndexPage({
      pageId: 76,
      title: 'Древний Египет',
      namespace: 0,
      allowedGroups: ['*'],
      lastModified: '2026-06-01T09:00:00Z',
      chunks: [
        {
          id: 760000,
          text: 'Публичная статья о древней религиозной системе.',
          chunkIndex: 0,
          totalChunks: 1,
        },
      ],
    });
    await setRagAdminConfig({
      searchMode: 'hybrid',
      lexicalMinMatchedTerms: 2,
      vectorOnlyFallbackEnabled: true,
      vectorOnlyFallbackMinScore: 0.78,
      showRawScores: false,
    });

    const result = await searchRagChunks({
      query: 'админинистрирование информационных систем',
      vector: [0.1, 0.2, 0.3],
      topK: 2,
    });

    expect(result.diagnostics).toMatchObject({
      bm25Candidates: 0,
      bm25RawCandidates: 1,
      lexicalRequiredMatchedTerms: 2,
      vectorOnlyFallbackUsed: false,
    });
    expect(result.chunks).toEqual([]);
  });

  it('uses trigram lexical fallback before vector-only fallback', async () => {
    searchChunkCandidates.mockResolvedValueOnce([
      {
        id: 4040001,
        pageId: 404,
        title: 'CorpIT:Администрирование систем',
        text: 'Регламент администрирования систем и доступа операторов.',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.79,
      },
    ]);
    await upsertSearchIndexPage({
      pageId: 404,
      title: 'CorpIT:Администрирование систем',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      chunks: [{
        id: 4040001,
        text: 'Регламент администрирования информационных систем и доступа операторов.',
      }],
    });
    await setRagAdminConfig({
      searchMode: 'hybrid',
      lexicalMinMatchedTerms: 3,
      trigramIndexEnabled: true,
      trigramCandidateLimit: 20,
      vectorOnlyFallbackEnabled: true,
      vectorOnlyFallbackMinScore: 0.78,
      showRawScores: false,
    });

    const result = await searchRagChunks({
      query: 'адмиристрирвание инфармацыонных систеи',
      vector: [0.1, 0.2, 0.3],
      topK: 2,
    });

    expect(result.diagnostics).toMatchObject({
      bm25Candidates: 0,
      trigramCandidates: 1,
      trigramFallbackUsed: true,
      vectorOnlyFallbackUsed: false,
    });
    expect(result.chunks).toEqual([
      expect.objectContaining({
        id: 4040001,
        title: 'CorpIT:Администрирование систем',
      }),
    ]);
  });
});
