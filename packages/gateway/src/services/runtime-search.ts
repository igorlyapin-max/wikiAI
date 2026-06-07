import { getRuntimeConfig } from './config.js';
import {
  getEffectiveContextMaxChars,
  getEffectiveContextTopK,
  getEffectiveRetrievalTopK,
  getRagAdminConfig,
} from './admin-platform-config.js';
import type { PrincipalAclMode } from './acl.js';
import { type WikiPageUrlOptions } from './mediawiki-url.js';
import { AuthenticatedPrincipal, DocumentChunk } from '../types/index.js';
import {
  resolveRuntimeRetrievalProfile,
  type RetrievalProfileSurface,
  type ResolvedRetrievalProfile,
} from './retrieval-profiles.js';
import type { RagAdminConfig } from './admin-platform-config.js';
import { toSearchPlainText } from './text-normalization.js';
import {
  type KnowledgeSourceFailurePolicy,
} from './knowledge-sources.js';
import { executeKnowledgeSourceFanout } from './knowledge-source-runtime.js';

export interface RuntimeSearchInput {
  query: string;
  topK?: number;
  principal: AuthenticatedPrincipal;
  wikiUrlOptions?: WikiPageUrlOptions;
  maxTopK?: number;
  aclMode?: PrincipalAclMode;
  retrievalProfileId?: string;
  retrievalProfileSurface?: RetrievalProfileSurface;
  knowledgeSourceProfileId?: string;
  sourceIds?: string[];
  sourceFailurePolicy?: KnowledgeSourceFailurePolicy;
}

export interface RuntimeSearchResponse {
  query: string;
  user: string;
  groups: string[];
  authMode: AuthenticatedPrincipal['authMode'];
  searchMode: RagAdminConfig['searchMode'];
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
  chunk: DocumentChunk,
  showRawScores: boolean,
  _wikiUrlOptions: WikiPageUrlOptions = {}
): Record<string, unknown> {
  const result = {
    ...chunk,
    text: toSearchPlainText(chunk.text),
    pageUrl: chunk.pageUrl ?? chunk.sourceUrl,
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
  const aclMode = input.aclMode ?? 'mediawiki_check';
  const failurePolicy = input.sourceFailurePolicy ?? 'partial_with_warning';
  const sourceSearch = await executeKnowledgeSourceFanout({
    sourceIds: input.sourceIds,
    query,
    topK,
    fallbackTopK,
    effectiveTopK,
    ragConfig,
    profileConfig: profileSelection?.effectiveConfig,
    principal: input.principal,
    aclMode,
    failurePolicy,
    wikiUrlOptions: input.wikiUrlOptions ?? {},
  });
  const results = sourceSearch.mergedChunks.map((chunk) => formatSearchResult(
    chunk,
    sourceSearch.showRawScores,
    input.wikiUrlOptions ?? {}
  ));

  return {
    query,
    user: input.principal.username,
    groups: input.principal.groups,
    authMode: input.principal.authMode,
    searchMode: sourceSearch.searchMode,
    showRawScores: sourceSearch.showRawScores,
    diagnostics: {
      ...sourceSearch.diagnostics,
      ...profileDiagnostics(profileSelection),
      knowledgeSourceProfileId: input.knowledgeSourceProfileId ?? null,
      knowledgeSourceIds: sourceSearch.sourceIds,
      knowledgeSourceFailurePolicy: failurePolicy,
      knowledgeSourceWarnings: sourceSearch.sourceWarnings,
      sourceFanout: sourceSearch.sourceFanout,
      aclMode,
      authMode: input.principal.authMode,
      query,
      retrievalQuery: query,
      requestedTopK: input.topK ?? null,
      retrievalTopK: fallbackTopK,
      effectiveTopK,
      contextTopK,
      contextMaxChars,
      searchMode: sourceSearch.searchMode,
      rawChunks: sourceSearch.rawChunks.length,
      readableChunks: sourceSearch.readableChunks.length,
      trustedChunks: sourceSearch.trustedChunks.length,
      finalResults: results.length,
    },
    results,
  };
}
