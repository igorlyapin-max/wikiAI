export interface AppConfig {
  mwBaseUrl: string;
  mwPublicBaseUrl: string;
  mwApiPath: string;
  litellmBaseUrl: string;
  litellmApiKey: string;
  litellmModel: string;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  colbertBaseUrl: string;
  colbertModel: string;
  colbertCollection: string;
  opensearchEnabled: boolean;
  opensearchBaseUrl: string;
  opensearchIndexName: string;
  opensearchUsername: string;
  opensearchPassword: string;
  opensearchApiKey: string;
  opensearchTimeoutMs: number;
  opensearchTlsRejectUnauthorized: boolean;
  opensearchAnalyzer: string;
  opensearchFuzzyEnabled: boolean;
  opensearchHighlightEnabled: boolean;
  opensearchTitleBoost: number;
  opensearchTextBoost: number;
  opensearchCandidateLimit: number;
  qdrantUrl: string;
  qdrantApiKey?: string;
  qdrantCollection: string;
  redisUrl: string;
  databaseUrl: string;
  syncerBaseUrl: string;
  syncerAdminToken?: string;
  smwSyncProperties: string[];
  gatewayPort: number;
  nodeEnv: string;
  userGroupsCacheTtl: number;
  corsOrigins: string[];
  externalApiEnabled: boolean;
  externalMcpEnabled: boolean;
  externalAnonymousSearchAllowed: boolean;
  externalMaxTopK: number;
  externalAclMode: 'mediawiki_check' | 'groups_only';
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUrl: string;
  oidcSubjectClaim: string;
  oidcUsernameClaim: string;
  oidcGroupsClaim: string;
  debugDiagnosticsEnabled: boolean;
  debugDiagnosticsLevel: 'Basic' | 'Verbose';
  logSinks: Array<'stdout' | 'syslog'>;
  logSyslogHost: string;
  logSyslogPort: number;
  healthCheckTimeoutMs: number;
  httpBodyLimitBytes: number;
  embeddingTimeoutMs: number;
  gracefulShutdownTimeoutMs: number;
  schedulerLockTtlSeconds: number;
}

export interface MWUserInfo {
  username: string;
  userId: number;
  groups: string[];
  rights?: string[];
}

export type PrincipalAuthMode = 'anonymous' | 'mediawiki_cookie' | 'oidc';

export interface AuthenticatedPrincipal {
  authMode: PrincipalAuthMode;
  username: string;
  userId: number;
  groups: string[];
  rights?: string[];
  sessionCookie?: string;
  bearerToken?: string;
  subject?: string;
}

export type SemanticFacts = Record<string, string[]>;

export interface ChunkTrustMetadata {
  modelId: string;
  score: number;
  lastModified?: string;
  ageYears?: number;
  stalenessPenalty: number;
  flags: string[];
  appliedEntityIds: string[];
  appliedRuleIds: string[];
  decisions: {
    includeInContext: boolean;
    allowDirectAnswer: boolean;
    excludeFromIndex: boolean;
    requireManualApproval: boolean;
    notifyAuthor: boolean;
    requireSources: boolean;
  };
}

export type KnowledgeSourceType = 'mediawiki' | (string & {});

export type KnowledgeSourceAclMode = 'source_acl_callback' | 'groups_only';

export interface KnowledgeSourceSummary {
  id: string;
  type: KnowledgeSourceType;
  displayName: string;
  readiness: 'ready' | 'degraded' | 'not_ready';
  aclMode: KnowledgeSourceAclMode;
  semanticProviderId?: string;
}

export interface SearchChunk {
  id: number;
  sourceId?: string;
  documentId?: string;
  displayTitle?: string;
  sourceUrl?: string;
  spaceKey?: string;
  pageId: number;
  title: string;
  pageUrl?: string;
  text: string;
  namespace: number;
  allowedGroups: string[];
  score: number;
  scores?: {
    vector?: number;
    lexical?: number;
    colbert?: number;
    final: number;
  };
  sourceType?: string;
  attachmentFilename?: string;
  attachmentMime?: string;
  attachmentProcessingMode?: string;
  contentType?: string;
  chunkIndex?: number;
  totalChunks?: number;
  lastModified?: string;
  semanticFacts?: SemanticFacts;
  trust?: ChunkTrustMetadata;
}

export type DocumentChunk = SearchChunk & {
  sourceId: string;
  documentId: string;
  displayTitle: string;
  sourceUrl: string;
  spaceKey: string;
};

export interface SearchRequest {
  query: string;
  topK?: number;
  retrievalProfileId?: string;
  knowledgeSourceProfileId?: string;
  context?: ExternalRequestContext;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  stream?: boolean;
  topK?: number;
  retrievalProfileId?: string;
  knowledgeSourceProfileId?: string;
  context?: ExternalRequestContext;
}

export interface ExternalRequestContext {
  sourceApp?: string;
  objectType?: string;
  objectId?: string;
  title?: string;
  url?: string;
  tags?: string[];
  params?: Record<string, string | number | boolean | string[]>;
  attributes?: Record<string, string | number | boolean | string[]>;
  dynamicBlocks?: Array<{
    sourceApp?: 'cmdbdynamicpages';
    templateCode?: string;
    status?:
      | 'snapshot_hit'
      | 'snapshot_miss'
      | 'auth_runtime_hit'
      | 'auth_required'
      | 'permission_denied'
      | 'runtime_error'
      | 'unresolved_params';
    title?: string;
    url?: string;
  }>;
}
