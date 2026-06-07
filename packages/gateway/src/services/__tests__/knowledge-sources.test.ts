import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentChunk, SearchChunk } from '../../types/index.js';
import {
  canonicalizeChunk,
  DEFAULT_KNOWLEDGE_SOURCE_ID,
  getKnowledgeSource,
  getKnowledgeSources,
  registerKnowledgeSourceForTests,
  resetKnowledgeSourcesForTests,
  type KnowledgeSource,
} from '../knowledge-sources.js';
import type { RagSearchDiagnostics, RagSearchResult } from '../hybrid-search.js';

function diagnostics(): RagSearchDiagnostics {
  return {
    searchMode: 'hybrid',
    rerankMode: 'none',
    lexicalBackend: 'sqlite_fts',
    lexicalGateMode: 'off',
    vectorCandidates: 0,
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
    trigramIndexEnabled: false,
    trigramCandidates: 0,
    trigramRawCandidates: 0,
    trigramRequiredMatchedTerms: 0,
    trigramQueryTerms: [],
    trigramLatencyMs: 0,
    trigramFallbackUsed: false,
    lexicalGateApplied: false,
    vectorOnlyFallbackUsed: false,
    vectorOnlyFallbackMinScore: 0,
    colbertApplied: false,
    colbertCandidates: 0,
    colbertFallbackUsed: false,
  };
}

describe('knowledge source registry', () => {
  afterEach(() => {
    resetKnowledgeSourcesForTests();
  });

  it('canonicalizes MediaWiki chunks through the default source connector', () => {
    const chunk: SearchChunk = {
      id: 42000,
      pageId: 42,
      title: 'CorpIT:VPN',
      text: 'VPN access instructions',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.82,
    };

    const result = canonicalizeChunk(chunk, DEFAULT_KNOWLEDGE_SOURCE_ID, {
      baseUrl: 'http://wiki.example.local',
    });

    expect(result).toMatchObject({
      sourceId: 'mediawiki',
      documentId: 'mediawiki:page:42',
      displayTitle: 'CorpIT:VPN',
      spaceKey: 'mw-namespace-3030',
      sourceUrl: 'http://wiki.example.local/index.php/CorpIT:VPN',
      pageUrl: 'http://wiki.example.local/index.php/CorpIT:VPN',
    });
  });

  it('allows non-MediaWiki connectors to provide their own document model', async () => {
    const fakeSource: KnowledgeSource = {
      id: 'runbook',
      type: 'runbook',
      displayName: 'Runbook',
      readiness: 'ready',
      aclMode: 'groups_only',
      async search(): Promise<RagSearchResult> {
        return {
          chunks: [],
          limit: 3,
          aclCandidateLimit: 3,
          showRawScores: false,
          mode: 'hybrid',
          diagnostics: diagnostics(),
        };
      },
      async filterReadableChunks(input) {
        return input.chunks.slice(0, input.limit);
      },
      canonicalizeChunk(chunk: SearchChunk): DocumentChunk {
        return {
          ...chunk,
          sourceId: 'runbook',
          documentId: `runbook:${chunk.pageId}`,
          displayTitle: chunk.displayTitle ?? `Runbook ${chunk.pageId}`,
          sourceUrl: chunk.sourceUrl ?? `runbook://${chunk.pageId}`,
          pageUrl: chunk.pageUrl ?? `runbook://${chunk.pageId}`,
          spaceKey: chunk.spaceKey ?? 'runbook-default',
        };
      },
    };

    const cleanup = registerKnowledgeSourceForTests(fakeSource);

    expect(getKnowledgeSource('runbook')).toBe(fakeSource);
    expect(getKnowledgeSources()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'runbook',
        type: 'runbook',
        displayName: 'Runbook',
        aclMode: 'groups_only',
      }),
    ]));
    expect(canonicalizeChunk({
      id: 7000,
      pageId: 7,
      title: 'Restart service',
      text: 'Restart steps',
      namespace: 0,
      allowedGroups: ['ops'],
      score: 0.7,
    }, 'runbook')).toMatchObject({
      sourceId: 'runbook',
      documentId: 'runbook:7',
      displayTitle: 'Runbook 7',
      sourceUrl: 'runbook://7',
      spaceKey: 'runbook-default',
    });

    cleanup();
    expect(getKnowledgeSource('runbook')).toBeUndefined();
  });
});
