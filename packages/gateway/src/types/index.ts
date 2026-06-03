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
  qdrantUrl: string;
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

export interface SearchChunk {
  id: number;
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
  chunkIndex?: number;
  totalChunks?: number;
  lastModified?: string;
  semanticFacts?: SemanticFacts;
  trust?: ChunkTrustMetadata;
}

export interface SearchRequest {
  query: string;
  topK?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  stream?: boolean;
}
