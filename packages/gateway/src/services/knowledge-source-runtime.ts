import {
  type RagAdminConfig,
} from './admin-platform-config.js';
import {
  getColbertCandidateLimit,
  isColbertFullSearchEnabled,
  rerankChunksWithColbert,
} from './colbert-reranker.js';
import { RuntimeHttpError } from './runtime-errors.js';
import { applyTrustPolicyToChunks } from './trust-runtime.js';
import type { AuthenticatedPrincipal, DocumentChunk, SearchChunk } from '../types/index.js';
import type { PrincipalAclMode } from './acl.js';
import {
  getKnowledgeSource,
  selectKnowledgeSourceIds,
  type KnowledgeSourceFanoutTrace,
  type KnowledgeSourceFailurePolicy,
  type KnowledgeSourceSearchResult,
  type KnowledgeSourceWarning,
} from './knowledge-sources.js';
import type { WikiPageUrlOptions } from './mediawiki-url.js';

export interface KnowledgeSourcePipelineResult {
  sourceId: string;
  status: 'ok' | 'warning' | 'error';
  elapsedMs: number;
  search?: KnowledgeSourceSearchResult;
  diagnostics: Record<string, unknown>;
  rawChunks: DocumentChunk[];
  readableChunks: DocumentChunk[];
  trustedChunks: DocumentChunk[];
  finalChunks: DocumentChunk[];
  warning?: KnowledgeSourceWarning;
}

export interface KnowledgeSourceFanoutInput {
  sourceIds?: string[];
  query: string;
  topK?: number;
  fallbackTopK: number;
  effectiveTopK: number;
  ragConfig: RagAdminConfig;
  profileConfig?: RagAdminConfig;
  principal: AuthenticatedPrincipal;
  aclMode: PrincipalAclMode;
  failurePolicy: KnowledgeSourceFailurePolicy;
  wikiUrlOptions?: WikiPageUrlOptions;
}

export interface KnowledgeSourceFanoutResult {
  sourceIds: string[];
  sourceResults: KnowledgeSourcePipelineResult[];
  sourceFanout: KnowledgeSourceFanoutTrace[];
  sourceWarnings: KnowledgeSourceWarning[];
  firstSearch?: KnowledgeSourceSearchResult;
  diagnostics: Record<string, unknown>;
  mergedChunks: DocumentChunk[];
  rawChunks: DocumentChunk[];
  readableChunks: DocumentChunk[];
  trustedChunks: DocumentChunk[];
  searchMode: KnowledgeSourceSearchResult['mode'] | RagAdminConfig['searchMode'];
  showRawScores: boolean;
}

function rankScore(chunk: SearchChunk): number {
  return chunk.scores?.final ?? chunk.score ?? 0;
}

function mergeSourceChunks(chunks: DocumentChunk[], limit: number): DocumentChunk[] {
  return [...chunks]
    .sort((left, right) => rankScore(right) - rankScore(left))
    .slice(0, limit);
}

function sourceTrace(result: KnowledgeSourcePipelineResult): KnowledgeSourceFanoutTrace {
  return {
    sourceId: result.sourceId,
    status: result.status,
    elapsedMs: result.elapsedMs,
    rawChunks: result.rawChunks.length,
    readableChunks: result.readableChunks.length,
    trustedChunks: result.trustedChunks.length,
    finalChunks: result.finalChunks.length,
    ...(result.warning ? { warning: result.warning.message } : {}),
  };
}

async function runSourcePipeline(input: KnowledgeSourceFanoutInput & {
  sourceId: string;
}): Promise<KnowledgeSourcePipelineResult> {
  const startedAt = Date.now();
  const source = getKnowledgeSource(input.sourceId);
  if (!source) {
    return {
      sourceId: input.sourceId,
      status: 'warning',
      elapsedMs: Date.now() - startedAt,
      diagnostics: {},
      rawChunks: [],
      readableChunks: [],
      trustedChunks: [],
      finalChunks: [],
      warning: {
        sourceId: input.sourceId,
        code: 'unsupported_source',
        message: `Knowledge source is not supported in this build: ${input.sourceId}`,
      },
    };
  }

  try {
    const search = await source.search({
      query: input.query,
      topK: input.topK,
      fallbackTopK: input.fallbackTopK,
      ragConfig: input.ragConfig,
      profileConfig: input.profileConfig,
    });
    const rawChunks = search.chunks.map((chunk) => source.canonicalizeChunk(chunk, input.wikiUrlOptions));
    const readableSearchChunks = await source.filterReadableChunks({
      chunks: search.chunks,
      principal: input.principal,
      limit: search.aclCandidateLimit,
      aclMode: input.aclMode,
    });
    const readableChunks = readableSearchChunks.map((chunk) =>
      source.canonicalizeChunk(chunk, input.wikiUrlOptions)
    );
    const trustedSearchChunks = await applyTrustPolicyToChunks(
      readableChunks,
      getColbertCandidateLimit(input.ragConfig, search.limit)
    );
    const trustedChunks = trustedSearchChunks.map((chunk) =>
      source.canonicalizeChunk(chunk, input.wikiUrlOptions)
    );
    const reranked = await rerankChunksWithColbert({
      query: input.query,
      chunks: trustedChunks,
      topK: search.limit,
      config: input.ragConfig,
    });
    const finalChunks = reranked.chunks.map((chunk) =>
      source.canonicalizeChunk(chunk, input.wikiUrlOptions)
    );
    const diagnostics = isColbertFullSearchEnabled(input.ragConfig)
      ? search.diagnostics
      : {
        ...search.diagnostics,
        ...reranked.diagnostics,
      };

    return {
      sourceId: input.sourceId,
      status: 'ok',
      elapsedMs: Date.now() - startedAt,
      search,
      diagnostics: { ...diagnostics },
      rawChunks,
      readableChunks,
      trustedChunks,
      finalChunks,
    };
  } catch (err) {
    if (err instanceof RuntimeHttpError) throw err;
    if (input.failurePolicy === 'fail_request') throw err;
    return {
      sourceId: input.sourceId,
      status: 'error',
      elapsedMs: Date.now() - startedAt,
      diagnostics: {},
      rawChunks: [],
      readableChunks: [],
      trustedChunks: [],
      finalChunks: [],
      warning: {
        sourceId: input.sourceId,
        code: 'source_failed',
        message: `Knowledge source failed: ${input.sourceId}`,
      },
    };
  }
}

export async function executeKnowledgeSourceFanout(
  input: KnowledgeSourceFanoutInput
): Promise<KnowledgeSourceFanoutResult> {
  const sourceIds = selectKnowledgeSourceIds(input.sourceIds);
  const sourceResults = await Promise.all(sourceIds.map((sourceId) => runSourcePipeline({
    ...input,
    sourceId,
  })));
  const successfulSources = sourceResults.filter((result) => result.search);
  const firstSearch = successfulSources[0]?.search;
  const mergedChunks = mergeSourceChunks(
    sourceResults.flatMap((result) => result.finalChunks),
    firstSearch?.limit ?? input.effectiveTopK
  );
  const rawChunks = sourceResults.flatMap((result) => result.rawChunks);
  const readableChunks = sourceResults.flatMap((result) => result.readableChunks);
  const trustedChunks = sourceResults.flatMap((result) => result.trustedChunks);
  const sourceWarnings = sourceResults
    .map((result) => result.warning)
    .filter((warning): warning is KnowledgeSourceWarning => Boolean(warning));

  return {
    sourceIds,
    sourceResults,
    sourceFanout: sourceResults.map(sourceTrace),
    sourceWarnings,
    firstSearch,
    diagnostics: successfulSources.length === 1 ? successfulSources[0].diagnostics : {},
    mergedChunks,
    rawChunks,
    readableChunks,
    trustedChunks,
    searchMode: firstSearch?.mode ?? input.ragConfig.searchMode,
    showRawScores: firstSearch?.showRawScores ?? false,
  };
}
