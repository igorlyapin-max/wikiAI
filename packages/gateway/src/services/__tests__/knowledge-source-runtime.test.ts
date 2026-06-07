import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import type { AuthenticatedPrincipal, DocumentChunk, SearchChunk } from '../../types/index.js';
import { getRagAdminConfig, type RagAdminConfig } from '../admin-platform-config.js';
import { executeKnowledgeSourceFanout } from '../knowledge-source-runtime.js';
import {
  registerKnowledgeSourceForTests,
  resetKnowledgeSourcesForTests,
  type KnowledgeSource,
} from '../knowledge-sources.js';
import type { RagSearchDiagnostics, RagSearchResult } from '../hybrid-search.js';

vi.mock('../trust-runtime.js', () => ({
  applyTrustPolicyToChunks: vi.fn(async (chunks: DocumentChunk[], limit: number) => chunks.slice(0, limit)),
}));

vi.mock('../colbert-reranker.js', () => ({
  getColbertCandidateLimit: vi.fn((_config: unknown, fallbackLimit: number) => fallbackLimit),
  isColbertFullSearchEnabled: vi.fn(() => false),
  rerankChunksWithColbert: vi.fn(async (input: { chunks: DocumentChunk[]; topK: number; config: { rerankMode: string } }) => ({
    chunks: input.chunks.slice(0, input.topK),
    diagnostics: {
      rerankMode: input.config.rerankMode,
      colbertApplied: false,
      colbertCandidates: 0,
      colbertFallbackUsed: false,
    },
  })),
  searchColbertIndex: vi.fn(),
}));

const principal: AuthenticatedPrincipal = {
  authMode: 'oidc',
  username: 'alice',
  userId: 100,
  groups: ['ops'],
};

function chunk(id: number, sourceName: string, score: number, allowedGroups = ['ops']): SearchChunk {
  return {
    id,
    pageId: id,
    title: `${sourceName} ${id}`,
    text: `${sourceName} text ${id}`,
    namespace: 0,
    allowedGroups,
    score,
    scores: { final: score },
  };
}

function diagnostics(config: RagAdminConfig, vectorCandidates: number): RagSearchDiagnostics {
  return {
    searchMode: config.searchMode,
    rerankMode: config.rerankMode,
    lexicalBackend: config.lexicalBackend,
    lexicalGateMode: config.lexicalGateMode,
    vectorCandidates,
    bm25Candidates: 0,
    bm25RawCandidates: 0,
    bm25QueryTerms: [],
    bm25ExpandedTerms: [],
    bm25SynonymTerms: [],
    bm25TransliterationTerms: [],
    bm25EditDistanceTerms: [],
    opensearchEnabled: false,
    opensearchReady: false,
    opensearchIndexName: 'wikiai_chunks',
    opensearchAnalyzer: 'russian',
    opensearchCandidates: 0,
    opensearchRawHits: 0,
    opensearchAnalyzedTerms: [],
    opensearchRemovedTerms: [],
    opensearchLatencyMs: 0,
    opensearchHighlightsAvailable: false,
    lexicalMinMatchedTerms: 0,
    lexicalRequiredMatchedTerms: 0,
    trigramIndexEnabled: config.trigramIndexEnabled,
    trigramCandidates: 0,
    trigramRawCandidates: 0,
    trigramRequiredMatchedTerms: 0,
    trigramQueryTerms: [],
    trigramLatencyMs: 0,
    trigramFallbackUsed: false,
    lexicalGateApplied: false,
    vectorOnlyFallbackUsed: false,
    vectorOnlyFallbackMinScore: config.vectorOnlyFallbackMinScore,
    colbertApplied: false,
    colbertCandidates: 0,
    colbertFallbackUsed: false,
  };
}

function makeSource(id: string, chunks: SearchChunk[]): KnowledgeSource {
  return {
    id,
    type: id,
    displayName: id,
    readiness: 'ready',
    aclMode: 'groups_only',
    async search(input): Promise<RagSearchResult> {
      const limit = input.topK ?? input.fallbackTopK;
      return {
        chunks,
        limit,
        aclCandidateLimit: chunks.length,
        showRawScores: false,
        mode: input.ragConfig.searchMode,
        diagnostics: diagnostics(input.ragConfig, chunks.length),
      };
    },
    async filterReadableChunks(input) {
      return input.chunks
        .filter((item) => item.allowedGroups.includes('*') || item.allowedGroups.some((group) => input.principal.groups.includes(group)))
        .slice(0, input.limit);
    },
    canonicalizeChunk(item): DocumentChunk {
      return {
        ...item,
        sourceId: id,
        documentId: item.documentId ?? `${id}:doc:${item.pageId}`,
        displayTitle: item.displayTitle ?? `${id}: ${item.title}`,
        sourceUrl: item.sourceUrl ?? `source://${id}/${item.pageId}`,
        pageUrl: item.pageUrl ?? `source://${id}/${item.pageId}`,
        spaceKey: item.spaceKey ?? `${id}-space`,
      };
    },
  };
}

describe('knowledge source fanout runtime', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
    resetKnowledgeSourcesForTests();
  });

  it('executes multiple non-MediaWiki sources and merges canonical document chunks', async () => {
    registerKnowledgeSourceForTests(makeSource('runbooks', [
      chunk(1, 'Runbook', 0.72),
      chunk(2, 'Runbook', 0.61, ['finance']),
    ]));
    registerKnowledgeSourceForTests(makeSource('tickets', [
      chunk(3, 'Ticket', 0.93),
    ]));
    const ragConfig = await getRagAdminConfig();

    const result = await executeKnowledgeSourceFanout({
      sourceIds: ['runbooks', 'tickets'],
      query: 'restart vpn',
      topK: 5,
      fallbackTopK: 5,
      effectiveTopK: 5,
      ragConfig,
      principal,
      aclMode: 'groups_only',
      failurePolicy: 'partial_with_warning',
    });

    expect(result.sourceIds).toEqual(['runbooks', 'tickets']);
    expect(result.sourceWarnings).toEqual([]);
    expect(result.sourceFanout).toEqual([
      expect.objectContaining({
        sourceId: 'runbooks',
        status: 'ok',
        rawChunks: 2,
        readableChunks: 1,
        trustedChunks: 1,
        finalChunks: 1,
      }),
      expect.objectContaining({
        sourceId: 'tickets',
        status: 'ok',
        rawChunks: 1,
        readableChunks: 1,
        trustedChunks: 1,
        finalChunks: 1,
      }),
    ]);
    expect(result.mergedChunks.map((item) => item.documentId)).toEqual([
      'tickets:doc:3',
      'runbooks:doc:1',
    ]);
    expect(result.mergedChunks).toEqual([
      expect.objectContaining({
        sourceId: 'tickets',
        displayTitle: 'tickets: Ticket 3',
        sourceUrl: 'source://tickets/3',
        spaceKey: 'tickets-space',
      }),
      expect.objectContaining({
        sourceId: 'runbooks',
        displayTitle: 'runbooks: Runbook 1',
        sourceUrl: 'source://runbooks/1',
        spaceKey: 'runbooks-space',
      }),
    ]);
  });

  it('returns sanitized warnings for unsupported or failing optional sources', async () => {
    registerKnowledgeSourceForTests({
      ...makeSource('broken', []),
      async search() {
        throw new Error('database password leaked in original error');
      },
    });
    const ragConfig = await getRagAdminConfig();

    const result = await executeKnowledgeSourceFanout({
      sourceIds: ['broken', 'missing-source'],
      query: 'anything',
      fallbackTopK: 3,
      effectiveTopK: 3,
      ragConfig,
      principal,
      aclMode: 'groups_only',
      failurePolicy: 'partial_with_warning',
    });

    expect(result.mergedChunks).toEqual([]);
    expect(result.sourceWarnings).toEqual([
      {
        sourceId: 'broken',
        code: 'source_failed',
        message: 'Knowledge source failed: broken',
      },
      {
        sourceId: 'missing-source',
        code: 'unsupported_source',
        message: 'Knowledge source is not supported in this build: missing-source',
      },
    ]);
    expect(JSON.stringify(result.sourceWarnings)).not.toContain('password');
  });
});
