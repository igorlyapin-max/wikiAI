import { z } from 'zod';
import { getAdminStore } from '../db/admin-store.js';
import type {
  AuthenticatedPrincipal,
  DocumentChunk,
  KnowledgeSourceAclMode,
  KnowledgeSourceSummary,
  KnowledgeSourceType,
  SearchChunk,
} from '../types/index.js';
import {
  filterReadableChunks,
  filterReadableChunksForPrincipal,
  type PrincipalAclMode,
} from './acl.js';
import { buildWikiPageUrl, type WikiPageUrlOptions } from './mediawiki-url.js';
import {
  DEFAULT_MEDIAWIKI_RETRIEVAL_PROFILE_ID,
  getMediaWikiProfileConfig,
  setMediaWikiProfileConfig,
} from './mediawiki-profile-config.js';
import {
  getRagAdminConfig,
  type RagAdminConfig,
  type RetrievalProfileWithReadiness,
} from './admin-platform-config.js';
import {
  applyRetrievalProfileToRagConfig,
  getRetrievalProfilesWithReadiness,
} from './retrieval-profiles.js';
import { getEmbedding } from './embedding.js';
import { searchRagChunks, type RagSearchResult } from './hybrid-search.js';
import {
  isColbertFullSearchEnabled,
  searchColbertIndex,
  type ColbertIndexSearchResult,
} from './colbert-reranker.js';
import { RuntimeHttpError } from './runtime-errors.js';

const CONFIG_AREA = 'knowledge-source-profile-config';
const CONFIG_KEY = 'default';

export const DEFAULT_KNOWLEDGE_SOURCE_ID = 'mediawiki';
export const DEFAULT_KNOWLEDGE_SOURCE_PROFILE_ID = 'default';

export type KnowledgeSourceFailurePolicy = 'partial_with_warning' | 'fail_request';
export type KnowledgeSourceMergePolicy = 'normalize_rerank';

export interface KnowledgeSourceProfileConfig {
  id: string;
  sourceIds: string[];
  retrievalProfileId: string;
  failurePolicy: KnowledgeSourceFailurePolicy;
  mergePolicy: KnowledgeSourceMergePolicy;
}

export interface KnowledgeSourceProfileConfigStatus {
  values: KnowledgeSourceProfileConfig;
  sources: KnowledgeSourceSummary[];
  selectedProfile?: RetrievalProfileWithReadiness;
  effectiveConfig?: RagAdminConfig;
  retrievalProfiles: RetrievalProfileWithReadiness[];
}

export interface KnowledgeSourceWarning {
  sourceId: string;
  code: 'unsupported_source' | 'source_failed' | 'source_not_selected';
  message: string;
}

export interface KnowledgeSourceFanoutTrace {
  sourceId: string;
  status: 'ok' | 'warning' | 'error';
  elapsedMs: number;
  rawChunks: number;
  readableChunks: number;
  trustedChunks: number;
  finalChunks: number;
  warning?: string;
}

export interface KnowledgeSourceSearchResult {
  chunks: SearchChunk[];
  limit: number;
  aclCandidateLimit: number;
  showRawScores: boolean;
  mode: RagAdminConfig['searchMode'];
  diagnostics: RagSearchResult['diagnostics'] | ColbertIndexSearchResult['diagnostics'] | Record<string, unknown>;
}

export interface KnowledgeSourceSearchInput {
  query: string;
  topK?: number;
  fallbackTopK: number;
  ragConfig: RagAdminConfig;
  profileConfig?: RagAdminConfig;
}

export interface KnowledgeSourceFilterReadableInput {
  chunks: SearchChunk[];
  principal: AuthenticatedPrincipal;
  limit: number;
  aclMode: PrincipalAclMode;
}

export interface KnowledgeSource {
  id: string;
  type: KnowledgeSourceType;
  displayName: string;
  readiness: KnowledgeSourceSummary['readiness'];
  aclMode: KnowledgeSourceAclMode;
  semanticProviderId?: string;
  search(input: KnowledgeSourceSearchInput): Promise<KnowledgeSourceSearchResult>;
  filterReadableChunks(input: KnowledgeSourceFilterReadableInput): Promise<SearchChunk[]>;
  canonicalizeChunk(chunk: SearchChunk, wikiUrlOptions?: WikiPageUrlOptions): DocumentChunk;
}

const configSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/)
    .default(DEFAULT_KNOWLEDGE_SOURCE_PROFILE_ID),
  sourceIds: z.array(z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/))
    .min(1)
    .default([DEFAULT_KNOWLEDGE_SOURCE_ID]),
  retrievalProfileId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/)
    .default(DEFAULT_MEDIAWIKI_RETRIEVAL_PROFILE_ID),
  failurePolicy: z.enum(['partial_with_warning', 'fail_request']).default('partial_with_warning'),
  mergePolicy: z.enum(['normalize_rerank']).default('normalize_rerank'),
}).strict();

export const DEFAULT_KNOWLEDGE_SOURCE_PROFILE_CONFIG: KnowledgeSourceProfileConfig = {
  id: DEFAULT_KNOWLEDGE_SOURCE_PROFILE_ID,
  sourceIds: [DEFAULT_KNOWLEDGE_SOURCE_ID],
  retrievalProfileId: DEFAULT_MEDIAWIKI_RETRIEVAL_PROFILE_ID,
  failurePolicy: 'partial_with_warning',
  mergePolicy: 'normalize_rerank',
};

async function runCurrentMediaWikiSearch(
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

async function runMediaWikiSearchWithColbertFallback(
  input: KnowledgeSourceSearchInput
): Promise<KnowledgeSourceSearchResult> {
  const ragConfig = input.profileConfig ?? input.ragConfig;
  if (!isColbertFullSearchEnabled(ragConfig)) {
    return runCurrentMediaWikiSearch(input.query, input.topK, input.fallbackTopK, input.profileConfig);
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
    const fallback = await runCurrentMediaWikiSearch(input.query, input.topK, input.fallbackTopK, input.profileConfig);
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

async function filterMediaWikiReadableChunks(input: KnowledgeSourceFilterReadableInput): Promise<SearchChunk[]> {
  if (input.aclMode === 'mediawiki_check' && input.principal.authMode !== 'oidc') {
    return filterReadableChunks(input.chunks, input.principal.sessionCookie ?? '', input.limit);
  }
  return filterReadableChunksForPrincipal(input.chunks, input.principal, input.limit, input.aclMode);
}

function toMediaWikiDocumentId(sourceId: string, chunk: Pick<SearchChunk, 'pageId'>): string {
  return `${sourceId}:page:${chunk.pageId}`;
}

function toMediaWikiSpaceKey(chunk: Pick<SearchChunk, 'namespace'>): string {
  return `mw-namespace-${chunk.namespace}`;
}

function canonicalizeMediaWikiChunk(
  chunk: SearchChunk,
  wikiUrlOptions: WikiPageUrlOptions = {}
): DocumentChunk {
  const sourceUrl = chunk.sourceUrl ?? chunk.pageUrl ?? buildWikiPageUrl(chunk.title, wikiUrlOptions);
  return {
    ...chunk,
    sourceId: DEFAULT_KNOWLEDGE_SOURCE_ID,
    documentId: chunk.documentId ?? toMediaWikiDocumentId(DEFAULT_KNOWLEDGE_SOURCE_ID, chunk),
    displayTitle: chunk.displayTitle ?? chunk.title,
    sourceUrl,
    pageUrl: chunk.pageUrl ?? sourceUrl,
    spaceKey: chunk.spaceKey ?? toMediaWikiSpaceKey(chunk),
  };
}

const mediaWikiKnowledgeSource: KnowledgeSource = {
  id: DEFAULT_KNOWLEDGE_SOURCE_ID,
  type: 'mediawiki',
  displayName: 'MediaWiki',
  readiness: 'ready',
  aclMode: 'source_acl_callback',
  semanticProviderId: 'smw',
  search: runMediaWikiSearchWithColbertFallback,
  filterReadableChunks: filterMediaWikiReadableChunks,
  canonicalizeChunk: canonicalizeMediaWikiChunk,
};

const knowledgeSourceRegistry = new Map<string, KnowledgeSource>([
  [mediaWikiKnowledgeSource.id, mediaWikiKnowledgeSource],
]);

function uniqueSourceIds(sourceIds: string[]): string[] {
  return Array.from(new Set(sourceIds));
}

function validateSupportedSourceIds(sourceIds: string[]): void {
  const unsupported = sourceIds.filter((sourceId) => !knowledgeSourceRegistry.has(sourceId));
  if (unsupported.length > 0) {
    throw new Error(`Knowledge source not supported in this build: ${unsupported.join(', ')}`);
  }
}

export function getKnowledgeSource(sourceId: string): KnowledgeSource | undefined {
  return knowledgeSourceRegistry.get(sourceId);
}

export function selectKnowledgeSourceIds(sourceIds: string[] | undefined): string[] {
  const selected = sourceIds && sourceIds.length > 0 ? sourceIds : [DEFAULT_KNOWLEDGE_SOURCE_ID];
  return uniqueSourceIds(selected);
}

export function registerKnowledgeSourceForTests(source: KnowledgeSource): () => void {
  const previous = knowledgeSourceRegistry.get(source.id);
  knowledgeSourceRegistry.set(source.id, source);
  return () => {
    if (previous) {
      knowledgeSourceRegistry.set(source.id, previous);
    } else {
      knowledgeSourceRegistry.delete(source.id);
    }
  };
}

export function resetKnowledgeSourcesForTests(): void {
  knowledgeSourceRegistry.clear();
  knowledgeSourceRegistry.set(mediaWikiKnowledgeSource.id, mediaWikiKnowledgeSource);
}

function parseStoredConfig(stored: Partial<KnowledgeSourceProfileConfig> | null | undefined): KnowledgeSourceProfileConfig {
  return configSchema.parse({
    ...DEFAULT_KNOWLEDGE_SOURCE_PROFILE_CONFIG,
    ...(stored ?? {}),
    sourceIds: uniqueSourceIds(stored?.sourceIds ?? DEFAULT_KNOWLEDGE_SOURCE_PROFILE_CONFIG.sourceIds),
  });
}

export async function getKnowledgeSourceProfileConfig(): Promise<KnowledgeSourceProfileConfig> {
  const stored = await getAdminStore().getJson<Partial<KnowledgeSourceProfileConfig>>(CONFIG_AREA, CONFIG_KEY);
  if (stored) return parseStoredConfig(stored);

  const mediaWikiProfile = await getMediaWikiProfileConfig();
  return parseStoredConfig({
    retrievalProfileId: mediaWikiProfile.defaultRetrievalProfileId,
  });
}

export async function setKnowledgeSourceProfileConfig(
  input: unknown,
  actor?: string
): Promise<KnowledgeSourceProfileConfig> {
  const parsed = parseStoredConfig(configSchema.parse(input));
  validateSupportedSourceIds(parsed.sourceIds);

  const profiles = await getRetrievalProfilesWithReadiness();
  if (!profiles.some((profile) => profile.id === parsed.retrievalProfileId)) {
    throw new Error(`Retrieval profile not found: ${parsed.retrievalProfileId}`);
  }

  await getAdminStore().setJson(CONFIG_AREA, CONFIG_KEY, parsed, {
    actor,
    action: 'knowledge-source-profile.config.update',
    entityType: 'knowledge-source-profile',
  });

  await setMediaWikiProfileConfig({
    defaultRetrievalProfileId: parsed.retrievalProfileId,
  }, actor);

  return parsed;
}

export function getKnowledgeSources(): KnowledgeSourceSummary[] {
  return Array.from(knowledgeSourceRegistry.values()).map((source) => ({
    id: source.id,
    type: source.type,
    displayName: source.displayName,
    readiness: source.readiness,
    aclMode: source.aclMode,
    semanticProviderId: source.semanticProviderId,
  }));
}

export async function getKnowledgeSourceProfileConfigStatus(): Promise<KnowledgeSourceProfileConfigStatus> {
  const [values, profiles, baseConfig] = await Promise.all([
    getKnowledgeSourceProfileConfig(),
    getRetrievalProfilesWithReadiness(),
    getRagAdminConfig(),
  ]);
  const selectedProfile = profiles.find((profile) => profile.id === values.retrievalProfileId);
  return {
    values,
    sources: getKnowledgeSources(),
    selectedProfile,
    effectiveConfig: selectedProfile ? applyRetrievalProfileToRagConfig(baseConfig, selectedProfile) : undefined,
    retrievalProfiles: profiles,
  };
}

export function canonicalizeChunk(
  chunk: SearchChunk,
  sourceId = DEFAULT_KNOWLEDGE_SOURCE_ID,
  wikiUrlOptions: WikiPageUrlOptions = {}
): DocumentChunk {
  const source = getKnowledgeSource(sourceId) ?? mediaWikiKnowledgeSource;
  return source.canonicalizeChunk(chunk, wikiUrlOptions);
}

export function canonicalizeChunks(
  chunks: SearchChunk[],
  sourceId = DEFAULT_KNOWLEDGE_SOURCE_ID,
  wikiUrlOptions: WikiPageUrlOptions = {}
): DocumentChunk[] {
  return chunks.map((chunk) => canonicalizeChunk(chunk, sourceId, wikiUrlOptions));
}
