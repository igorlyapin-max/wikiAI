import {
  getRagAdminConfig,
  getRetrievalProfiles,
  type HttpTestResult,
  type RagAdminConfig,
  type RetrievalProfile,
  type RetrievalProfileReadiness,
  type RetrievalProfileWithReadiness,
} from './admin-platform-config.js';
import { testColbertReranker } from './colbert-reranker.js';
import { getOpenSearchStatus, type OpenSearchStatus } from './opensearch.js';
import { getSearchIndexStatus } from './search-index.js';
import { RuntimeHttpError } from './runtime-errors.js';
import { logOperationalEvent } from './logging.js';
import {
  getChatManagementConfig,
  getChatProfiles,
  legacyChatProfileIdForRetrievalProfile,
  type ChatProfileSummary,
} from './chat-profiles.js';

export type RetrievalProfileSurface = 'api' | 'mcp' | 'mediawiki';

export interface RetrievalProfileCapability {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  apiEnabled: boolean;
  mcpEnabled: boolean;
  anonymousAllowed: boolean;
  maxTopK: number;
  tags: string[];
  chatProfileId?: string;
  chatProfile?: ChatProfileSummary;
  lexicalBackend: RagAdminConfig['lexicalBackend'];
  searchMode: RagAdminConfig['searchMode'];
  rerankMode: RagAdminConfig['rerankMode'];
  chatRetrievalQueryMode: RagAdminConfig['chatRetrievalQueryMode'];
  readiness: RetrievalProfileReadiness;
}

export interface ResolvedRetrievalProfile {
  profile: RetrievalProfile;
  readiness: RetrievalProfileReadiness;
  effectiveConfig: RagAdminConfig;
}

function profileRequiresColbert(config: RagAdminConfig): boolean {
  return config.colbertEnabled
    || config.searchMode === 'colbert_full'
    || config.searchMode === 'hybrid_colbert'
    || config.rerankMode === 'colbert_v2';
}

function profileRequiresLexicalProvider(config: RagAdminConfig): boolean {
  return config.searchMode === 'hybrid' || config.searchMode === 'hybrid_colbert';
}

export function applyRetrievalProfileToRagConfig(
  base: RagAdminConfig,
  profile: RetrievalProfile
): RagAdminConfig {
  return {
    ...base,
    ...profile.config,
    colbertBaseUrl: base.colbertBaseUrl,
    colbertModel: base.colbertModel,
    colbertCollection: base.colbertCollection,
  };
}

function profileAllowedForSurface(profile: RetrievalProfile, surface: RetrievalProfileSurface): boolean {
  if (surface === 'mediawiki') return true;
  return surface === 'mcp' ? profile.mcpEnabled : profile.apiEnabled;
}

async function getColbertHealthIfNeeded(configs: RagAdminConfig[]): Promise<HttpTestResult | undefined> {
  const colbertConfig = configs.find(profileRequiresColbert);
  if (!colbertConfig) return undefined;
  return testColbertReranker(colbertConfig);
}

async function getOpenSearchStatusIfNeeded(configs: RagAdminConfig[]): Promise<OpenSearchStatus | undefined> {
  if (!configs.some((item) => profileRequiresLexicalProvider(item) && item.lexicalBackend === 'opensearch')) {
    return undefined;
  }
  return getOpenSearchStatus();
}

function buildReadiness(input: {
  profile: RetrievalProfile;
  effectiveConfig: RagAdminConfig;
  searchIndexStatus: Awaited<ReturnType<typeof getSearchIndexStatus>>;
  colbertHealth?: HttpTestResult;
  openSearchStatus?: OpenSearchStatus;
}): RetrievalProfileReadiness {
  const reasons: string[] = [];
  const requiredIndexTargets = new Set<string>(['dense']);
  const missingIndexTargets = new Set<string>();
  const config = input.effectiveConfig;
  const requiresLexicalProvider = profileRequiresLexicalProvider(config);
  const requiresBm25Index = requiresLexicalProvider && config.lexicalBackend === 'sqlite_fts';
  const requiresOpenSearch = requiresLexicalProvider && config.lexicalBackend === 'opensearch';
  const requiresColbert = profileRequiresColbert(config);

  if (!input.profile.enabled) {
    reasons.push('Profile is disabled');
  }
  if (requiresBm25Index) {
    requiredIndexTargets.add('bm25');
  }
  if (requiresOpenSearch) {
    requiredIndexTargets.add('opensearch');
  }
  if (requiresColbert) {
    requiredIndexTargets.add('colbert');
  }
  if (config.trigramIndexEnabled) {
    requiredIndexTargets.add('trigram');
  }
  if (requiresBm25Index && (!input.searchIndexStatus.populated || input.searchIndexStatus.ftsChunks <= 0)) {
    missingIndexTargets.add('bm25');
    reasons.push('BM25/search index is not populated');
  }
  if (requiresOpenSearch && input.openSearchStatus?.status !== 'ok') {
    missingIndexTargets.add('opensearch');
    reasons.push(input.openSearchStatus?.error
      ? `OpenSearch index is not ready: ${input.openSearchStatus.error}`
      : 'OpenSearch index is not ready');
  }
  if (config.includeAttachments) {
    requiredIndexTargets.add('attachments');
    if (input.searchIndexStatus.attachmentChunks <= 0) {
      missingIndexTargets.add('attachments');
      reasons.push('Attachment index is empty');
    }
    if (
      requiresOpenSearch
      && input.searchIndexStatus.attachmentChunks > 0
      && (input.openSearchStatus?.attachmentDocumentCount ?? 0) <= 0
    ) {
      missingIndexTargets.add('opensearch_attachments');
      reasons.push('OpenSearch attachment index is empty while BM25 attachment chunks exist');
    }
    if (
      requiresOpenSearch
      && input.searchIndexStatus.attachmentChunks > 0
      && (input.openSearchStatus?.attachmentDocumentCount ?? 0) > 0
      && (input.openSearchStatus?.attachmentDocumentCount ?? 0) < input.searchIndexStatus.attachmentChunks
    ) {
      missingIndexTargets.add('opensearch_attachments');
      reasons.push(
        `OpenSearch attachment index is incomplete: ${input.openSearchStatus?.attachmentDocumentCount ?? 0}/${input.searchIndexStatus.attachmentChunks} chunks`
      );
    }
  }
  if (config.trigramIndexEnabled && !input.searchIndexStatus.trigramPopulated) {
    missingIndexTargets.add('trigram');
    reasons.push('trigram_index_not_ready: run trigram backfill before using this profile');
  }
  if (requiresColbert && input.colbertHealth?.status !== 'ok') {
    missingIndexTargets.add('colbert');
    reasons.push(input.colbertHealth?.error
      ? `ColBERT health is not ok: ${input.colbertHealth.error}`
      : 'ColBERT health is not ok');
  }
  if (!requiresColbert) {
    reasons.push('ColBERT is not required by this profile; production scope is limited');
  }
  if (config.searchMode === 'vector_only') {
    reasons.push('BM25 gate is not used by vector_only profile; validate dense Qdrant quality separately');
  }

  const hardFailure = reasons.some((reason) => (
    reason === 'Profile is disabled'
    || reason === 'BM25/search index is not populated'
    || reason === 'Attachment index is empty'
    || reason.startsWith('OpenSearch index is not ready')
    || reason.startsWith('OpenSearch attachment index is')
    || reason.startsWith('trigram_index_not_ready')
    || reason.startsWith('ColBERT health is not ok')
  ));
  const base = {
    reasons,
    requiredIndexTargets: Array.from(requiredIndexTargets),
    missingIndexTargets: Array.from(missingIndexTargets),
  };
  if (hardFailure) return { status: 'not_ready', ...base };
  if (requiresColbert && input.colbertHealth?.status === 'ok') return { status: 'prod_ready', ...base };
  return { status: 'limited_ready', ...base };
}

export async function getRetrievalProfilesWithReadiness(): Promise<RetrievalProfileWithReadiness[]> {
  const [profiles, baseConfig, searchIndexStatus, chatProfiles, chatManagementConfig] = await Promise.all([
    getRetrievalProfiles(),
    getRagAdminConfig(),
    getSearchIndexStatus(),
    getChatProfiles(),
    getChatManagementConfig(),
  ]);
  const chatProfileById = new Map(chatProfiles.map((profile) => [profile.id, profile]));
  const effectiveConfigs = profiles.map((profile) => applyRetrievalProfileToRagConfig(baseConfig, profile));
  const [colbertHealth, openSearchStatus] = await Promise.all([
    getColbertHealthIfNeeded(effectiveConfigs),
    getOpenSearchStatusIfNeeded(effectiveConfigs),
  ]);
  return profiles.map((profile, index) => {
    const effectiveChatProfileId = legacyChatProfileIdForRetrievalProfile(profile)
      ?? chatManagementConfig.defaultChatProfileId;
    const chatProfile = chatProfileById.get(effectiveChatProfileId);
    return {
      ...profile,
      chatProfileId: profile.chatProfileId,
      chatProfile: chatProfile ? {
        id: chatProfile.id,
        name: chatProfile.name,
        promptHistoryScope: chatProfile.promptHistoryScope,
        promptHistoryTurns: chatProfile.promptHistoryTurns,
        retrievalHistoryMode: chatProfile.retrievalHistoryMode,
        retrievalHistoryTurns: chatProfile.retrievalHistoryTurns,
        experimental: chatProfile.experimental,
      } : undefined,
      readiness: buildReadiness({
      profile,
      effectiveConfig: effectiveConfigs[index] ?? baseConfig,
      searchIndexStatus,
      colbertHealth,
      openSearchStatus,
      }),
    };
  });
}

export async function getRetrievalProfileCapabilities(): Promise<RetrievalProfileCapability[]> {
  const profiles = await getRetrievalProfilesWithReadiness();
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    enabled: profile.enabled,
    apiEnabled: profile.apiEnabled,
    mcpEnabled: profile.mcpEnabled,
    anonymousAllowed: profile.anonymousAllowed,
    maxTopK: profile.maxTopK,
    tags: profile.tags,
    chatProfileId: profile.chatProfileId,
    chatProfile: profile.chatProfile as ChatProfileSummary | undefined,
    lexicalBackend: profile.config.lexicalBackend,
    searchMode: profile.config.searchMode,
    rerankMode: profile.config.rerankMode,
    chatRetrievalQueryMode: profile.config.chatRetrievalQueryMode,
    readiness: profile.readiness,
  }));
}

export async function getRetrievalProfileAccess(
  profileId: string | undefined,
  surface: RetrievalProfileSurface
): Promise<RetrievalProfile | undefined> {
  if (!profileId) return undefined;
  const profile = (await getRetrievalProfiles()).find((item) => item.id === profileId);
  if (!profile || !profile.enabled || !profileAllowedForSurface(profile, surface)) {
    throw new RuntimeHttpError(400, {
      error: 'invalid_retrieval_profile',
      message: `Retrieval profile is not available for ${surface}: ${profileId}`,
    });
  }
  return profile;
}

export async function resolveRuntimeRetrievalProfile(
  profileId: string | undefined,
  surface: RetrievalProfileSurface
): Promise<ResolvedRetrievalProfile | undefined> {
  if (!profileId) return undefined;
  const [profiles, baseConfig, searchIndexStatus] = await Promise.all([
    getRetrievalProfiles(),
    getRagAdminConfig(),
    getSearchIndexStatus(),
  ]);
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile || !profile.enabled || !profileAllowedForSurface(profile, surface)) {
    logOperationalEvent('warn', 'retrieval_profile.rejected', {
      profileId,
      surface,
      reason: 'invalid_or_disabled',
    });
    throw new RuntimeHttpError(400, {
      error: 'invalid_retrieval_profile',
      message: `Retrieval profile is not available for ${surface}: ${profileId}`,
    });
  }

  const effectiveConfig = applyRetrievalProfileToRagConfig(baseConfig, profile);
  const [colbertHealth, openSearchStatus] = await Promise.all([
    getColbertHealthIfNeeded([effectiveConfig]),
    getOpenSearchStatusIfNeeded([effectiveConfig]),
  ]);
  const readiness = buildReadiness({
    profile,
    effectiveConfig,
    searchIndexStatus,
    colbertHealth,
    openSearchStatus,
  });
  if (readiness.status === 'not_ready') {
    logOperationalEvent('warn', 'retrieval_profile.rejected', {
      profileId,
      surface,
      reason: 'not_ready',
      readinessReasons: readiness.reasons,
    });
    throw new RuntimeHttpError(409, {
      error: 'retrieval_profile_not_ready',
      message: `Retrieval profile is not ready: ${profileId}`,
      readiness,
    });
  }

  logOperationalEvent('info', 'retrieval_profile.selected', {
    profileId,
    surface,
      readiness: readiness.status,
      searchMode: effectiveConfig.searchMode,
      lexicalBackend: effectiveConfig.lexicalBackend,
    });
  return { profile, readiness, effectiveConfig };
}
