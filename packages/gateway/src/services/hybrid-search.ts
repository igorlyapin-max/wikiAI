import { getRagAdminConfig, RagAdminConfig } from './admin-platform-config.js';
import { normalizeCandidateLimit, normalizeTopK, searchChunkCandidates } from './qdrant.js';
import { LexicalSearchChunk, searchLexicalChunksWithDiagnostics } from './search-index.js';
import { SearchChunk } from '../types/index.js';

export interface RagSearchInput {
  query: string;
  vector: number[];
  topK?: number;
  fallbackTopK?: number;
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
  lexicalGateMode: RagAdminConfig['lexicalGateMode'];
  vectorCandidates: number;
  bm25Candidates: number;
  bm25RawCandidates: number;
  lexicalMinMatchedTerms: number;
  lexicalRequiredMatchedTerms: number;
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
  bm25Candidates: number,
  bm25RawCandidates: number,
  lexicalRequiredMatchedTerms: number,
  flags: Pick<RagSearchDiagnostics, 'lexicalGateApplied' | 'vectorOnlyFallbackUsed'>
): RagSearchDiagnostics {
  return {
    searchMode: config.searchMode,
    rerankMode: config.rerankMode,
    lexicalGateMode: config.lexicalGateMode,
    vectorCandidates: vectorChunks.length,
    bm25Candidates,
    bm25RawCandidates,
    lexicalMinMatchedTerms: config.lexicalMinMatchedTerms,
    lexicalRequiredMatchedTerms,
    lexicalGateApplied: flags.lexicalGateApplied,
    vectorOnlyFallbackUsed: flags.vectorOnlyFallbackUsed,
    vectorOnlyFallbackMinScore: config.vectorOnlyFallbackMinScore,
    colbertApplied: false,
    colbertCandidates: 0,
    colbertFallbackUsed: false,
  };
}

export async function searchRagChunks(input: RagSearchInput): Promise<RagSearchResult> {
  const config = await getRagAdminConfig();
  const limit = normalizeTopK(input.topK, input.fallbackTopK ?? config.topK);
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
      diagnostics: buildDiagnostics(config, vectorChunks, 0, 0, 0, {
        lexicalGateApplied: false,
        vectorOnlyFallbackUsed: false,
      }),
    };
  }

  const lexicalSearch = await searchLexicalChunksWithDiagnostics(
    input.query,
    config.lexicalCandidateLimit,
    config.lexicalMinMatchedTerms
  );
  const lexicalChunks = lexicalSearch.chunks;
  if (lexicalChunks.length === 0) {
    const fallbackMinScore = Math.max(config.minSearchScore, config.vectorOnlyFallbackMinScore);
    const shouldUseVectorOnlyFallback = config.vectorOnlyFallbackEnabled && lexicalSearch.rawCandidates === 0;
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
        0,
        lexicalSearch.rawCandidates,
        lexicalSearch.requiredMatchedTerms,
        {
          lexicalGateApplied: false,
          vectorOnlyFallbackUsed: shouldUseVectorOnlyFallback,
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
      lexicalChunks.length,
      lexicalSearch.rawCandidates,
      lexicalSearch.requiredMatchedTerms,
      {
        lexicalGateApplied,
        vectorOnlyFallbackUsed: false,
      }
    ),
  };
}
