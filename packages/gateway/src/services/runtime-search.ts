import { getEmbedding } from './embedding.js';
import { getRuntimeConfig } from './config.js';
import {
  getEffectiveContextMaxChars,
  getEffectiveContextTopK,
  getEffectiveRetrievalTopK,
  getRagAdminConfig,
} from './admin-platform-config.js';
import {
  filterReadableChunks,
  filterReadableChunksForPrincipal,
  type PrincipalAclMode,
} from './acl.js';
import { applyTrustPolicyToChunks } from './trust-runtime.js';
import { buildWikiPageUrl, type WikiPageUrlOptions } from './mediawiki-url.js';
import { RagSearchResult, searchRagChunks } from './hybrid-search.js';
import {
  getColbertCandidateLimit,
  isColbertFullSearchEnabled,
  rerankChunksWithColbert,
  searchColbertIndex,
} from './colbert-reranker.js';
import { RuntimeHttpError } from './runtime-errors.js';
import { AuthenticatedPrincipal, SearchChunk } from '../types/index.js';
import {
  resolveRuntimeRetrievalProfile,
  type RetrievalProfileSurface,
  type ResolvedRetrievalProfile,
} from './retrieval-profiles.js';
import type { RagAdminConfig } from './admin-platform-config.js';
import { toSearchPlainText } from './text-normalization.js';

export interface RuntimeSearchInput {
  query: string;
  topK?: number;
  principal: AuthenticatedPrincipal;
  wikiUrlOptions?: WikiPageUrlOptions;
  maxTopK?: number;
  aclMode?: PrincipalAclMode;
  retrievalProfileId?: string;
  retrievalProfileSurface?: RetrievalProfileSurface;
}

export interface RuntimeSearchResponse {
  query: string;
  user: string;
  groups: string[];
  authMode: AuthenticatedPrincipal['authMode'];
  searchMode: RagSearchResult['mode'];
  showRawScores: boolean;
  diagnostics: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
}

function clampTopK(topK: number | undefined, maxTopK: number | undefined): number | undefined {
  if (topK === undefined) return undefined;
  const normalized = Math.max(1, Math.trunc(topK));
  return maxTopK === undefined ? normalized : Math.min(normalized, maxTopK);
}

export function formatSearchResult(
  chunk: SearchChunk,
  showRawScores: boolean,
  wikiUrlOptions: WikiPageUrlOptions = {}
): Record<string, unknown> {
  const result = {
    ...chunk,
    text: toSearchPlainText(chunk.text),
    pageUrl: chunk.pageUrl ?? buildWikiPageUrl(chunk.title, wikiUrlOptions),
  };
  if (showRawScores) return result;

  const publicResult: Record<string, unknown> = { ...result };
  delete publicResult.score;
  delete publicResult.scores;
  delete publicResult.lexicalRank;
  delete publicResult.lexicalMatchedTerms;
  delete publicResult.lexicalMatchedTermCount;
  return publicResult;
}

async function runCurrentSearch(
  query: string,
  topK: number | undefined,
  fallbackTopK: number,
  config?: RagAdminConfig
): Promise<RagSearchResult> {
  const embedding = await getEmbedding(query);
  return searchRagChunks({
    query,
    vector: embedding,
    topK,
    fallbackTopK,
    ...(config ? { config } : {}),
  });
}

async function runSearchWithColbertFallback(input: {
  query: string;
  topK?: number;
  fallbackTopK: number;
  config?: RagAdminConfig;
}): Promise<RagSearchResult | Awaited<ReturnType<typeof searchColbertIndex>>> {
  const ragConfig = input.config ?? await getRagAdminConfig();
  if (!isColbertFullSearchEnabled(ragConfig)) {
    return runCurrentSearch(input.query, input.topK, input.fallbackTopK, input.config);
  }

  try {
    return await searchColbertIndex({
      query: input.query,
      topK: input.topK,
      fallbackTopK: input.fallbackTopK,
      config: ragConfig,
    });
  } catch (err) {
    if (ragConfig.colbertFailMode === 'fail_search') {
      throw new RuntimeHttpError(502, {
        error: 'ColBERT search failed',
        message: err instanceof Error ? err.message : 'Unknown ColBERT search error',
      });
    }
    const fallback = await runCurrentSearch(input.query, input.topK, input.fallbackTopK, input.config);
    return {
      ...fallback,
      diagnostics: {
        ...fallback.diagnostics,
        colbertIndexApplied: false,
        colbertFallbackUsed: true,
        colbertError: err instanceof Error ? err.message : 'Unknown ColBERT search error',
      },
    };
  }
}

async function filterRuntimeReadableChunks(input: {
  chunks: SearchChunk[];
  principal: AuthenticatedPrincipal;
  limit: number;
  aclMode: PrincipalAclMode;
}): Promise<SearchChunk[]> {
  if (input.aclMode === 'mediawiki_check' && input.principal.authMode !== 'oidc') {
    return filterReadableChunks(input.chunks, input.principal.sessionCookie ?? '', input.limit);
  }
  return filterReadableChunksForPrincipal(input.chunks, input.principal, input.limit, input.aclMode);
}

function profileDiagnostics(selection: ResolvedRetrievalProfile | undefined): Record<string, unknown> {
  if (!selection) return { retrievalProfileId: null };
  return {
    retrievalProfileId: selection.profile.id,
    retrievalProfileReadiness: selection.readiness.status,
    retrievalProfileReasons: selection.readiness.reasons,
    retrievalProfileRequiredIndexTargets: selection.readiness.requiredIndexTargets ?? [],
    retrievalProfileMissingIndexTargets: selection.readiness.missingIndexTargets ?? [],
    effectiveSearchMode: selection.effectiveConfig.searchMode,
    effectiveLexicalBackend: selection.effectiveConfig.lexicalBackend,
  };
}

export async function executeRuntimeSearch(input: RuntimeSearchInput): Promise<RuntimeSearchResponse> {
  const query = input.query.trim();
  const runtime = await getRuntimeConfig();
  const profileSelection = await resolveRuntimeRetrievalProfile(
    input.retrievalProfileId,
    input.retrievalProfileSurface ?? 'api'
  );
  const ragConfig = profileSelection?.effectiveConfig ?? await getRagAdminConfig();
  const topKLimit = profileSelection
    ? Math.min(input.maxTopK ?? profileSelection.profile.maxTopK, profileSelection.profile.maxTopK)
    : input.maxTopK;
  const topK = clampTopK(input.topK, topKLimit);
  const fallbackTopK = getEffectiveRetrievalTopK(ragConfig, runtime.topK);
  const effectiveTopK = topK ?? fallbackTopK;
  const contextTopK = getEffectiveContextTopK(ragConfig, effectiveTopK);
  const contextMaxChars = getEffectiveContextMaxChars(ragConfig);
  const search = await runSearchWithColbertFallback({
    query,
    topK,
    fallbackTopK,
    config: profileSelection?.effectiveConfig,
  });
  const aclMode = input.aclMode ?? 'mediawiki_check';
  const readableChunks = await filterRuntimeReadableChunks({
    chunks: search.chunks,
    principal: input.principal,
    limit: search.aclCandidateLimit,
    aclMode,
  });
  const trustedChunks = await applyTrustPolicyToChunks(
    readableChunks,
    getColbertCandidateLimit(ragConfig, search.limit)
  );
  const reranked = await rerankChunksWithColbert({
    query,
    chunks: trustedChunks,
    topK: search.limit,
    config: ragConfig,
  });
  const results = reranked.chunks.map((chunk) => formatSearchResult(
    chunk,
    search.showRawScores,
    input.wikiUrlOptions ?? {}
  ));
  const diagnostics = isColbertFullSearchEnabled(ragConfig)
    ? search.diagnostics
    : {
      ...search.diagnostics,
      ...reranked.diagnostics,
    };

  return {
    query,
    user: input.principal.username,
    groups: input.principal.groups,
    authMode: input.principal.authMode,
    searchMode: search.mode,
    showRawScores: search.showRawScores,
    diagnostics: {
      ...diagnostics,
      ...profileDiagnostics(profileSelection),
      aclMode,
      authMode: input.principal.authMode,
      query,
      retrievalQuery: query,
      requestedTopK: input.topK ?? null,
      retrievalTopK: fallbackTopK,
      effectiveTopK,
      contextTopK,
      contextMaxChars,
      searchMode: search.mode,
      rawChunks: search.chunks.length,
      readableChunks: readableChunks.length,
      trustedChunks: trustedChunks.length,
      finalResults: results.length,
    },
    results,
  };
}
