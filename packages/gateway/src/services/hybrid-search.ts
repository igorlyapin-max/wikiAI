import { getEffectiveRetrievalTopK, getRagAdminConfig, RagAdminConfig } from './admin-platform-config.js';
import { normalizeCandidateLimit, normalizeTopK, searchChunkCandidates } from './qdrant.js';
import {
  getSearchIndexStatus,
  LexicalSearchChunk,
  searchLexicalChunksWithDiagnostics,
  searchTrigramChunksWithDiagnostics,
  TrigramSearchResult,
} from './search-index.js';
import { searchOpenSearchChunksWithDiagnostics } from './opensearch.js';
import { SearchChunk } from '../types/index.js';

export interface RagSearchInput {
  query: string;
  vector: number[];
  topK?: number;
  fallbackTopK?: number;
  config?: RagAdminConfig;
}

export interface RagSearchResult {
  chunks: SearchChunk[];
  limit: number;
  aclCandidateLimit: number;
  showRawScores: boolean;
  mode: RagAdminConfig['searchMode'];
  diagnostics: RagSearchDiagnostics;
}

export interface RagSearchDiagnostics {
  searchMode: RagAdminConfig['searchMode'];
  rerankMode: RagAdminConfig['rerankMode'];
  lexicalBackend: RagAdminConfig['lexicalBackend'];
  lexicalGateMode: RagAdminConfig['lexicalGateMode'];
  vectorCandidates: number;
  bm25Candidates: number;
  bm25RawCandidates: number;
  bm25QueryTerms: string[];
  bm25ExpandedTerms: string[];
  bm25SynonymTerms: string[];
  bm25TransliterationTerms: string[];
  bm25EditDistanceTerms: string[];
  opensearchEnabled: boolean;
  opensearchReady: boolean;
  opensearchIndexName: string;
  opensearchAnalyzer: string;
  opensearchCandidates: number;
  opensearchRawHits: number;
  opensearchAnalyzedTerms: string[];
  opensearchRemovedTerms: string[];
  opensearchLatencyMs: number;
  opensearchHighlightsAvailable: boolean;
  opensearchError?: string;
  lexicalMinMatchedTerms: number;
  lexicalRequiredMatchedTerms: number;
  trigramIndexEnabled: boolean;
  trigramCandidates: number;
  trigramRawCandidates: number;
  trigramRequiredMatchedTerms: number;
  trigramQueryTerms: string[];
  trigramLatencyMs: number;
  trigramFallbackUsed: boolean;
  trigramSkippedReason?: 'disabled' | 'bm25_available' | 'incomplete_index';
  lexicalGateApplied: boolean;
  vectorOnlyFallbackUsed: boolean;
  vectorOnlyFallbackMinScore: number;
  colbertApplied: boolean;
  colbertCandidates: number;
  colbertLatencyMs?: number;
  colbertFallbackUsed: boolean;
  colbertError?: string;
}

interface CombinedCandidate {
  chunk: SearchChunk;
  vectorScore?: number;
  lexicalRank?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function normalizeLowerBetter(values: Array<number | undefined>): number[] {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (finite.length === 0) return values.map(() => 0);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max === min) {
    return values.map((value) => (value === undefined ? 0 : 1));
  }
  return values.map((value) => (value === undefined ? 0 : clamp01((max - value) / (max - min))));
}

function mergeCandidates(
  vectorChunks: SearchChunk[],
  lexicalChunks: LexicalSearchChunk[]
): CombinedCandidate[] {
  const byId = new Map<number, CombinedCandidate>();

  for (const chunk of vectorChunks) {
    byId.set(chunk.id, {
      chunk,
      vectorScore: chunk.score,
    });
  }

  for (const lexicalChunk of lexicalChunks) {
    const existing = byId.get(lexicalChunk.id);
    if (existing) {
      existing.lexicalRank = lexicalChunk.lexicalRank;
      continue;
    }

    byId.set(lexicalChunk.id, {
      chunk: lexicalChunk,
      lexicalRank: lexicalChunk.lexicalRank,
    });
  }

  return Array.from(byId.values());
}

function mergeLexicalGatedCandidates(
  vectorChunks: SearchChunk[],
  lexicalChunks: LexicalSearchChunk[]
): CombinedCandidate[] {
  const vectorById = new Map(vectorChunks.map((chunk) => [chunk.id, chunk]));

  return lexicalChunks.map((lexicalChunk) => {
    const vectorChunk = vectorById.get(lexicalChunk.id);
    return {
      chunk: vectorChunk ?? lexicalChunk,
      vectorScore: vectorChunk?.score,
      lexicalRank: lexicalChunk.lexicalRank,
    };
  });
}

function applyFinalScore(
  candidates: CombinedCandidate[],
  config: RagAdminConfig
): SearchChunk[] {
  const vectorNormalized = candidates.map((candidate) => (
    candidate.vectorScore === undefined ? 0 : clamp01(candidate.vectorScore)
  ));
  const lexicalNormalized = normalizeLowerBetter(candidates.map((candidate) => candidate.lexicalRank));
  const totalWeight = config.vectorWeight + config.lexicalWeight;
  const vectorWeight = totalWeight > 0 ? config.vectorWeight / totalWeight : 0;
  const lexicalWeight = totalWeight > 0 ? config.lexicalWeight / totalWeight : 0;

  return candidates
    .map((candidate, index) => {
      const vector = vectorNormalized[index] ?? 0;
      const lexical = lexicalNormalized[index] ?? 0;
      const finalScore = clamp01((vector * vectorWeight) + (lexical * lexicalWeight));
      return {
        ...candidate.chunk,
        score: finalScore,
        scores: {
          vector: candidate.vectorScore,
          lexical,
          final: finalScore,
        },
      };
    })
    .filter((chunk) => chunk.score >= config.minFinalScore)
    .sort((a, b) => b.score - a.score);
}

function applyVectorOnlyScore(
  chunks: SearchChunk[],
  config: RagAdminConfig,
  minVectorScore = config.minSearchScore
): SearchChunk[] {
  return chunks
    .filter((chunk) => chunk.score >= minVectorScore)
    .map((chunk) => ({
      ...chunk,
      score: clamp01(chunk.score),
      scores: {
        vector: chunk.score,
        final: clamp01(chunk.score),
      },
    }))
    .filter((chunk) => chunk.score >= config.minFinalScore)
    .sort((a, b) => b.score - a.score);
}

function getAclCandidateLimit(limit: number, chunksLength: number): number {
  return Math.max(limit * 5, Math.min(chunksLength, 100));
}

function getEffectiveCandidateLimit(config: RagAdminConfig, limit: number): number {
  if ((config.rerankMode === 'colbert_v2' || config.searchMode === 'hybrid_colbert') && config.colbertEnabled) {
    return Math.max(limit, config.colbertCandidateLimit);
  }
  return limit;
}

function buildDiagnostics(
  config: RagAdminConfig,
  vectorChunks: SearchChunk[],
  stats: Pick<RagSearchDiagnostics,
    | 'bm25Candidates'
    | 'bm25RawCandidates'
    | 'bm25QueryTerms'
    | 'bm25ExpandedTerms'
    | 'bm25SynonymTerms'
    | 'bm25TransliterationTerms'
    | 'bm25EditDistanceTerms'
    | 'lexicalRequiredMatchedTerms'
    | 'trigramCandidates'
    | 'trigramRawCandidates'
    | 'trigramRequiredMatchedTerms'
    | 'trigramQueryTerms'
    | 'trigramLatencyMs'
    | 'trigramFallbackUsed'
    | 'trigramSkippedReason'
    | 'lexicalGateApplied'
    | 'vectorOnlyFallbackUsed'>
    & Partial<Pick<RagSearchDiagnostics,
      | 'opensearchEnabled'
      | 'opensearchReady'
      | 'opensearchIndexName'
      | 'opensearchAnalyzer'
      | 'opensearchCandidates'
      | 'opensearchRawHits'
      | 'opensearchAnalyzedTerms'
      | 'opensearchRemovedTerms'
      | 'opensearchLatencyMs'
      | 'opensearchHighlightsAvailable'
      | 'opensearchError'>>
): RagSearchDiagnostics {
  return {
    searchMode: config.searchMode,
    rerankMode: config.rerankMode,
    lexicalBackend: config.lexicalBackend,
    lexicalGateMode: config.lexicalGateMode,
    vectorCandidates: vectorChunks.length,
    bm25Candidates: stats.bm25Candidates,
    bm25RawCandidates: stats.bm25RawCandidates,
    bm25QueryTerms: stats.bm25QueryTerms,
    bm25ExpandedTerms: stats.bm25ExpandedTerms,
    bm25SynonymTerms: stats.bm25SynonymTerms,
    bm25TransliterationTerms: stats.bm25TransliterationTerms,
    bm25EditDistanceTerms: stats.bm25EditDistanceTerms,
    opensearchEnabled: stats.opensearchEnabled ?? false,
    opensearchReady: stats.opensearchReady ?? false,
    opensearchIndexName: stats.opensearchIndexName ?? '',
    opensearchAnalyzer: stats.opensearchAnalyzer ?? '',
    opensearchCandidates: stats.opensearchCandidates ?? 0,
    opensearchRawHits: stats.opensearchRawHits ?? 0,
    opensearchAnalyzedTerms: stats.opensearchAnalyzedTerms ?? [],
    opensearchRemovedTerms: stats.opensearchRemovedTerms ?? [],
    opensearchLatencyMs: stats.opensearchLatencyMs ?? 0,
    opensearchHighlightsAvailable: stats.opensearchHighlightsAvailable ?? false,
    opensearchError: stats.opensearchError,
    lexicalMinMatchedTerms: config.lexicalMinMatchedTerms,
    lexicalRequiredMatchedTerms: stats.lexicalRequiredMatchedTerms,
    trigramIndexEnabled: config.trigramIndexEnabled,
    trigramCandidates: stats.trigramCandidates,
    trigramRawCandidates: stats.trigramRawCandidates,
    trigramRequiredMatchedTerms: stats.trigramRequiredMatchedTerms,
    trigramQueryTerms: stats.trigramQueryTerms,
    trigramLatencyMs: stats.trigramLatencyMs,
    trigramFallbackUsed: stats.trigramFallbackUsed,
    trigramSkippedReason: stats.trigramSkippedReason,
    lexicalGateApplied: stats.lexicalGateApplied,
    vectorOnlyFallbackUsed: stats.vectorOnlyFallbackUsed,
    vectorOnlyFallbackMinScore: config.vectorOnlyFallbackMinScore,
    colbertApplied: false,
    colbertCandidates: 0,
    colbertFallbackUsed: false,
  };
}

export async function searchRagChunks(input: RagSearchInput): Promise<RagSearchResult> {
  const config = input.config ?? await getRagAdminConfig();
  const limit = normalizeTopK(input.topK, input.fallbackTopK ?? getEffectiveRetrievalTopK(config, config.topK));
  const aclLimit = getEffectiveCandidateLimit(config, limit);
  const vectorCandidateLimit = normalizeCandidateLimit(config.vectorCandidateLimit, 50);
  const vectorChunks = await searchChunkCandidates(input.vector, vectorCandidateLimit);

  if (config.searchMode === 'vector_only') {
    const chunks = applyVectorOnlyScore(vectorChunks, config);
    return {
      chunks,
      limit,
      aclCandidateLimit: getAclCandidateLimit(aclLimit, chunks.length),
      showRawScores: config.showRawScores,
      mode: config.searchMode,
      diagnostics: buildDiagnostics(config, vectorChunks, {
        bm25Candidates: 0,
        bm25RawCandidates: 0,
        bm25QueryTerms: [],
        bm25ExpandedTerms: [],
        bm25SynonymTerms: [],
        bm25TransliterationTerms: [],
        bm25EditDistanceTerms: [],
        lexicalRequiredMatchedTerms: 0,
        trigramCandidates: 0,
        trigramRawCandidates: 0,
        trigramRequiredMatchedTerms: 0,
        trigramQueryTerms: [],
        trigramLatencyMs: 0,
        trigramFallbackUsed: false,
        trigramSkippedReason: 'disabled',
        lexicalGateApplied: false,
        vectorOnlyFallbackUsed: false,
      }),
    };
  }

  const emptyTrigramSearch: TrigramSearchResult = {
    chunks: [],
    rawCandidates: 0,
    requiredMatchedTerms: 0,
    queryTerms: [],
    ftsQuery: '',
    latencyMs: 0,
  };
  let lexicalSearch = {
    chunks: [] as LexicalSearchChunk[],
    rawCandidates: 0,
    requiredMatchedTerms: 0,
    queryTerms: [] as string[],
    expandedTerms: [] as string[],
    synonymTerms: [] as string[],
    transliterationTerms: [] as string[],
    editDistanceTerms: [] as string[],
    ftsQuery: '',
  };
  let trigramSearch = emptyTrigramSearch;
  let trigramSkippedReason: RagSearchDiagnostics['trigramSkippedReason'] = 'disabled';
  let trigramFallbackUsed = false;
  let opensearchStats: Partial<RagSearchDiagnostics> = {};

  if (config.lexicalBackend === 'opensearch') {
    const opensearchSearch = await searchOpenSearchChunksWithDiagnostics(
      input.query,
      config.lexicalCandidateLimit,
      config
    );
    lexicalSearch = {
      chunks: opensearchSearch.chunks,
      rawCandidates: opensearchSearch.diagnostics.rawHits,
      requiredMatchedTerms: 1,
      queryTerms: opensearchSearch.diagnostics.analyzedTerms,
      expandedTerms: opensearchSearch.diagnostics.analyzedTerms,
      synonymTerms: [],
      transliterationTerms: [],
      editDistanceTerms: [],
      ftsQuery: '',
    };
    opensearchStats = {
      opensearchEnabled: opensearchSearch.diagnostics.enabled,
      opensearchReady: opensearchSearch.diagnostics.ready,
      opensearchIndexName: opensearchSearch.diagnostics.indexName,
      opensearchAnalyzer: opensearchSearch.diagnostics.analyzer,
      opensearchCandidates: opensearchSearch.diagnostics.candidates,
      opensearchRawHits: opensearchSearch.diagnostics.rawHits,
      opensearchAnalyzedTerms: opensearchSearch.diagnostics.analyzedTerms,
      opensearchRemovedTerms: opensearchSearch.diagnostics.removedTerms,
      opensearchLatencyMs: opensearchSearch.diagnostics.latencyMs,
      opensearchHighlightsAvailable: opensearchSearch.diagnostics.highlightsAvailable,
      opensearchError: opensearchSearch.diagnostics.error,
    };
  } else {
    lexicalSearch = await searchLexicalChunksWithDiagnostics(
      input.query,
      config.lexicalCandidateLimit,
      config.lexicalMinMatchedTerms,
      {
        normalizationMode: config.lexicalNormalizationMode,
        synonymsEnabled: config.lexicalSynonymsEnabled,
        synonyms: config.lexicalSynonyms,
        transliterationEnabled: config.lexicalTransliterationEnabled,
        editDistanceEnabled: config.lexicalEditDistanceEnabled,
      }
    );
    const shouldConsiderTrigram = lexicalSearch.chunks.length === 0 && config.trigramIndexEnabled;
    const trigramStatus = shouldConsiderTrigram ? await getSearchIndexStatus() : undefined;
    const trigramReady = trigramStatus?.trigramPopulated ?? false;
    trigramSkippedReason = lexicalSearch.chunks.length > 0
      ? 'bm25_available'
      : config.trigramIndexEnabled
        ? trigramReady ? undefined : 'incomplete_index'
        : 'disabled';
    trigramSearch = shouldConsiderTrigram && trigramReady
      ? await searchTrigramChunksWithDiagnostics(
        input.query,
        config.trigramCandidateLimit,
        config.trigramMinQueryLength
      )
      : emptyTrigramSearch;
    trigramFallbackUsed = lexicalSearch.chunks.length === 0 && trigramSearch.chunks.length > 0;
  }

  const lexicalChunks = trigramFallbackUsed ? trigramSearch.chunks : lexicalSearch.chunks;
  const sqliteLexicalStats = config.lexicalBackend === 'sqlite_fts';
  if (lexicalChunks.length === 0) {
    const fallbackMinScore = Math.max(config.minSearchScore, config.vectorOnlyFallbackMinScore);
    const shouldUseVectorOnlyFallback = config.vectorOnlyFallbackEnabled
      && lexicalSearch.rawCandidates === 0
      && trigramSearch.rawCandidates === 0;
    const chunks = shouldUseVectorOnlyFallback
      ? applyVectorOnlyScore(vectorChunks, config, fallbackMinScore)
      : [];
    return {
      chunks,
      limit,
      aclCandidateLimit: getAclCandidateLimit(aclLimit, chunks.length),
      showRawScores: config.showRawScores,
      mode: config.searchMode,
      diagnostics: buildDiagnostics(
        config,
        vectorChunks,
        {
          bm25Candidates: 0,
          bm25RawCandidates: sqliteLexicalStats ? lexicalSearch.rawCandidates : 0,
          bm25QueryTerms: sqliteLexicalStats ? lexicalSearch.queryTerms : [],
          bm25ExpandedTerms: sqliteLexicalStats ? lexicalSearch.expandedTerms : [],
          bm25SynonymTerms: sqliteLexicalStats ? lexicalSearch.synonymTerms : [],
          bm25TransliterationTerms: sqliteLexicalStats ? lexicalSearch.transliterationTerms : [],
          bm25EditDistanceTerms: sqliteLexicalStats ? lexicalSearch.editDistanceTerms : [],
          lexicalRequiredMatchedTerms: sqliteLexicalStats ? lexicalSearch.requiredMatchedTerms : 1,
          trigramCandidates: 0,
          trigramRawCandidates: trigramSearch.rawCandidates,
          trigramRequiredMatchedTerms: trigramSearch.requiredMatchedTerms,
          trigramQueryTerms: trigramSearch.queryTerms,
          trigramLatencyMs: trigramSearch.latencyMs,
          trigramFallbackUsed: false,
          trigramSkippedReason,
          lexicalGateApplied: false,
          vectorOnlyFallbackUsed: shouldUseVectorOnlyFallback,
          ...opensearchStats,
        }
      ),
    };
  }

  const vectorFiltered = vectorChunks.filter((chunk) => chunk.score >= config.minSearchScore);
  const lexicalGateApplied = config.lexicalGateMode === 'when_bm25_available';
  const candidates = lexicalGateApplied
    ? mergeLexicalGatedCandidates(vectorFiltered, lexicalChunks)
    : mergeCandidates(vectorFiltered, lexicalChunks);
  const chunks = applyFinalScore(candidates, config);
  return {
    chunks,
    limit,
    aclCandidateLimit: getAclCandidateLimit(aclLimit, chunks.length),
    showRawScores: config.showRawScores,
    mode: config.searchMode,
    diagnostics: buildDiagnostics(
      config,
      vectorChunks,
      {
        bm25Candidates: sqliteLexicalStats ? lexicalSearch.chunks.length : 0,
        bm25RawCandidates: sqliteLexicalStats ? lexicalSearch.rawCandidates : 0,
        bm25QueryTerms: sqliteLexicalStats ? lexicalSearch.queryTerms : [],
        bm25ExpandedTerms: sqliteLexicalStats ? lexicalSearch.expandedTerms : [],
        bm25SynonymTerms: sqliteLexicalStats ? lexicalSearch.synonymTerms : [],
        bm25TransliterationTerms: sqliteLexicalStats ? lexicalSearch.transliterationTerms : [],
        bm25EditDistanceTerms: sqliteLexicalStats ? lexicalSearch.editDistanceTerms : [],
        lexicalRequiredMatchedTerms: sqliteLexicalStats ? lexicalSearch.requiredMatchedTerms : 1,
        trigramCandidates: trigramSearch.chunks.length,
        trigramRawCandidates: trigramSearch.rawCandidates,
        trigramRequiredMatchedTerms: trigramSearch.requiredMatchedTerms,
        trigramQueryTerms: trigramSearch.queryTerms,
        trigramLatencyMs: trigramSearch.latencyMs,
        trigramFallbackUsed,
        trigramSkippedReason,
        lexicalGateApplied,
        vectorOnlyFallbackUsed: false,
        ...opensearchStats,
      }
    ),
  };
}
