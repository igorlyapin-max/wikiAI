import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, DEFAULT_OPENSEARCH_BASE_URL } from '../config.js';
import { parseDatabaseUrl, getAdminStore, AuditLogEntry } from '../db/admin-store.js';
import { getRuntimeConfig, setRuntimeConfig, type RuntimeConfig } from './config.js';
import { qdrant, QDRANT_VECTOR_SIZE } from './qdrant.js';
import { getSearchIndexStatus } from './search-index.js';
import { getChatProfiles } from './chat-profiles.js';
import {
  getSyncerMediaWikiServiceAuthStatus,
  StartReindexRequest,
  SyncerMediaWikiServiceAuthStatus,
  SyncerMediaWikiServiceLoginTestResult,
  testSyncerMediaWikiServiceAuth,
} from './syncer-admin.js';
import { getIndexedSmwProperties } from './smw-indexing-properties.js';

const SERVICE_CONFIG_AREA = 'service-config';
const RAG_CONFIG_AREA = 'rag-config';
const RETRIEVAL_PROFILE_AREA = 'retrieval-profiles';
const WEBHOOK_CONFIG_AREA = 'webhook-config';
const INDEXING_PROFILE_AREA = 'indexing-profiles';
const INDEXING_AUTOMATION_CONFIG_AREA = 'indexing-automation-config';
const CHAT_RETENTION_CONFIG_AREA = 'chat-retention-config';
const TRUST_RECALCULATION_CONFIG_AREA = 'trust-recalculation-config';
const CONFLICT_DETECTION_CONFIG_AREA = 'conflict-detection-config';
const TRUST_STORE_AREA = 'trust-models';
const DEFAULT_KEY = 'default';
const SECONDS_PER_DAY = 24 * 60 * 60;
const DEFAULT_STALENESS_PENALTY_PER_YEAR = 0.1;
const DEFAULT_INDEXING_SCHEDULE_INTERVAL_MINUTES = 1440;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[]
    ? T[K]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

export interface ServiceAdminConfig {
  database: {
    url: string;
    dialect: 'sqlite' | 'postgres';
    connectionStatus: 'ok' | 'error';
    migrationStatus: 'ok' | 'error';
    error?: string;
  };
  mediaWiki: {
    baseUrl: string;
    apiPath: string;
  };
  gateway: {
    port: number;
    nodeEnv: string;
    corsOrigins: string[];
  };
  syncer: {
    baseUrl: string;
    adminTokenConfigured: boolean;
    mediaWikiServiceAuth: SyncerMediaWikiServiceAuthStatus;
  };
  redis: {
    url: string;
  };
  qdrant: {
    url: string;
    collection: string;
  };
  opensearch: OpenSearchAdminConfig;
  llm: {
    baseUrl: string;
    model: string;
    apiKeyConfigured: boolean;
    timeoutMs: number;
  };
  embeddings: {
    provider: EmbeddingProvider;
    baseUrl: string;
    model: string;
    dimensions: number;
    apiKeyConfigured: boolean;
  };
}

export interface ServiceAdminConfigResponse {
  values: ServiceAdminConfig;
  runtime: ServiceAdminConfig;
  overrides: ServiceConfigUpdate;
  metadata: {
    secretsRedacted: true;
    requiresRestart: string[];
    note: string;
  };
}

export interface QdrantAdminDiagnostics {
  status: 'ok' | 'error';
  url: string;
  collection: string;
  expectedVectorSize: number;
  vectorSize?: number;
  vectorSizeCompatible?: boolean;
  pointsCount?: number;
  indexedVectorsCount?: number;
  error?: string;
}

export interface OpenSearchAdminConfig {
  enabled: boolean;
  baseUrl: string;
  indexName: string;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  apiKeyConfigured: boolean;
  authConfigured: boolean;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
  analyzer: string;
  fuzzyEnabled: boolean;
  highlightEnabled: boolean;
  titleBoost: number;
  textBoost: number;
  candidateLimit: number;
}

export interface EffectiveOpenSearchConfig extends OpenSearchAdminConfig {
  username?: string;
  password?: string;
  apiKey?: string;
}

export type ChunkingSourceType =
  | 'wiki_page'
  | 'attachment_text'
  | 'attachment_metadata'
  | 'cmdb_dynamic_snapshot';

export interface ChunkingRule {
  chunkSize: number;
  chunkOverlap: number;
  chunkSeparators: string[];
}

export interface ChunkingNamespaceOverride {
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
}

export interface ChunkingPolicy {
  defaults: ChunkingRule;
  sources: Partial<Record<ChunkingSourceType, ChunkingRule>>;
  namespaceOverrides: Record<string, ChunkingNamespaceOverride>;
}

export interface RagAdminConfig {
  chunkSize: number;
  chunkOverlap: number;
  chunkSeparators: string[];
  chunkingPolicy: ChunkingPolicy;
  minChunkLength: number;
  maxChunksPerPage: number;
  retrievalTopK: number;
  contextTopK: number;
  contextMaxChars: number;
  chatRetrievalQueryMode: 'current_message' | 'history_augmented';
  topK: number;
  maxContextChunks: number;
  maxContextChars: number;
  minSearchScore: number;
  searchMode: 'vector_only' | 'hybrid' | 'colbert_full' | 'hybrid_colbert';
  rerankMode: 'none' | 'colbert_v2';
  vectorWeight: number;
  lexicalWeight: number;
  lexicalBackend: 'sqlite_fts' | 'opensearch';
  vectorCandidateLimit: number;
  lexicalCandidateLimit: number;
  lexicalMinMatchedTerms: number;
  lexicalGateMode: 'off' | 'when_bm25_available';
  lexicalNormalizationMode: 'simple_stem' | 'raw_prefix';
  lexicalSynonymsEnabled: boolean;
  lexicalSynonyms: Array<{
    term: string;
    synonyms: string[];
  }>;
  lexicalTransliterationEnabled: boolean;
  lexicalEditDistanceEnabled: boolean;
  trigramIndexEnabled: boolean;
  trigramCandidateLimit: number;
  trigramMinQueryLength: number;
  vectorOnlyFallbackEnabled: boolean;
  vectorOnlyFallbackMinScore: number;
  minFinalScore: number;
  showRawScores: boolean;
  colbertEnabled: boolean;
  colbertBaseUrl: string;
  colbertModel: string;
  colbertCollection: string;
  colbertCandidateLimit: number;
  colbertTimeoutMs: number;
  colbertMinScore: number;
  colbertTailDropEnabled: boolean;
  colbertTailMaxGap: number;
  colbertTailMinScore: number;
  colbertTailMinKeep: number;
  colbertFailMode: 'fallback_current' | 'fail_search';
  semanticFactsInContext: boolean;
  includeAttachments: boolean;
  includeSemanticHeader: boolean;
}

export type AssistantUiMode = 'compact' | 'standard' | 'expert';

export type RetrievalProfileReadinessStatus = 'prod_ready' | 'limited_ready' | 'not_ready';

export interface RetrievalProfileReadiness {
  status: RetrievalProfileReadinessStatus;
  reasons: string[];
  requiredIndexTargets?: string[];
  missingIndexTargets?: string[];
}

export interface RetrievalProfileResponseOverrides {
  llmModel?: string;
  llmTemperature?: number;
  llmMaxTokens?: number;
  llmTimeoutMs?: number;
  systemPrompt?: string;
  conflictSystemPrompt?: string;
  showSources?: boolean;
  assistantUiMode?: AssistantUiMode;
}

export type RetrievalProfileOverrides = Pick<RagAdminConfig,
  | 'retrievalTopK'
  | 'contextTopK'
  | 'contextMaxChars'
  | 'chatRetrievalQueryMode'
  | 'topK'
  | 'maxContextChunks'
  | 'maxContextChars'
  | 'searchMode'
  | 'rerankMode'
  | 'vectorWeight'
  | 'lexicalWeight'
  | 'lexicalBackend'
  | 'vectorCandidateLimit'
  | 'lexicalCandidateLimit'
  | 'lexicalMinMatchedTerms'
  | 'lexicalGateMode'
  | 'lexicalNormalizationMode'
  | 'lexicalSynonymsEnabled'
  | 'lexicalSynonyms'
  | 'lexicalTransliterationEnabled'
  | 'lexicalEditDistanceEnabled'
  | 'trigramIndexEnabled'
  | 'trigramCandidateLimit'
  | 'trigramMinQueryLength'
  | 'vectorOnlyFallbackEnabled'
  | 'vectorOnlyFallbackMinScore'
  | 'minFinalScore'
  | 'showRawScores'
  | 'colbertEnabled'
  | 'colbertCandidateLimit'
  | 'colbertTimeoutMs'
  | 'colbertMinScore'
  | 'colbertTailDropEnabled'
  | 'colbertTailMaxGap'
  | 'colbertTailMinScore'
  | 'colbertTailMinKeep'
  | 'colbertFailMode'
  | 'semanticFactsInContext'
  | 'includeAttachments'
  | 'includeSemanticHeader'
> & RetrievalProfileResponseOverrides;

export interface RetrievalProfile {
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
  config: RetrievalProfileOverrides;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievalProfileWithReadiness extends RetrievalProfile {
  readiness: RetrievalProfileReadiness;
  chatProfile?: {
    id: string;
    name: string;
    promptHistoryScope: 'current_session' | 'current_user_active_sessions';
    promptHistoryTurns: number;
    retrievalHistoryMode: 'current_message' | 'current_session_questions' | 'current_session_questions_and_answers';
    retrievalHistoryTurns: number;
    experimental: boolean;
  };
}

export interface WebhookAdminConfig {
  syncerUrl: string;
  events: {
    edit: boolean;
    delete: boolean;
    move: boolean;
    protect: boolean;
  };
  timeoutMs: number;
  retryCount: number;
  retryBackoffMs: number;
  lastStatus?: HttpTestResult;
}

export type ChatRetentionMode = 'auto_delete' | 'archive' | 'export_then_archive';
export type ChatLimitExceededPolicy = 'delete_oldest' | 'block_new' | 'archive_oldest';
export type ChatExportFormat = 'json' | 'csv' | 'html';

export interface ChatRetentionConfig {
  retentionMode: ChatRetentionMode;
  activeDays: number;
  recentDays: number;
  archiveDays: number;
  maxPinnedChats: number;
  maxActiveChats: number;
  maxTotalChats: number;
  onLimitExceeded: ChatLimitExceededPolicy;
  exportOptions: {
    formats: ChatExportFormat[];
    includeMetadata: boolean;
    includeSources: boolean;
    includeMessages: boolean;
  };
}

export interface TrustRecalculationConfig {
  enabled: boolean;
  intervalMinutes: number;
  maxScan: number;
  batchSize: number;
}

export type ConflictDetectionRunMode = 'risk_only' | 'always' | 'manual';
export type AttachmentParentConflictMode = 'disabled' | 'risk_only' | 'always';

export interface ConflictDetectionConfig {
  enabled: boolean;
  runMode: ConflictDetectionRunMode;
  attachmentParentConflictMode: AttachmentParentConflictMode;
  model: string;
  systemPrompt: string;
  maxSources: number;
  maxCharsPerSource: number;
  trustGapThreshold: number;
  lowConfidenceThreshold: number;
  showConflictBlock: boolean;
}

export const DEFAULT_CONFLICT_DETECTION_SYSTEM_PROMPT = [
  'Ты проверяешь корпоративные wiki-источники на противоречия для RAG-ответа.',
  'Нужно сравнить только предоставленные источники. Не добавляй внешние знания.',
  'Считай противоречием только несовместимые утверждения об одном и том же объекте, правиле, сроке, числе или факте.',
  'Если источник помечен как attachment, а другой источник как parent_page той же страницы, сравнивай вложение с текстом родительской страницы по фактам, датам, статусам, регламентам и числовым значениям.',
  'Не считай конфликтом то, что вложение подробнее страницы, страница короче вложения, или источники описывают разные разделы одной темы.',
  'Разные темы, разные предметные области, разные кухни, разные процедуры или нерелевантные источники сами по себе не являются противоречием.',
  'Верни только JSON без Markdown.',
  'Схема JSON: {"hasConflict":boolean,"confidence":number,"summary":string,"conflictingSources":[{"sourceIndex":number,"title":string,"claim":string,"status":string}],"recommendedSourceIndex":number,"recommendedSourceTitle":string,"lowTrustReason":string}.',
  'confidence означает уверенность в выводе о наличии или отсутствии противоречия от 0 до 1.',
].join('\n');

export type TrustEntityType =
  | 'namespace'
  | 'category'
  | 'tag'
  | 'author_group'
  | 'page_property'
  | 'template'
  | 'date_property'
  | 'smw_property';
export type TrustConditionField =
  | 'namespace'
  | 'title'
  | 'category'
  | 'tag'
  | 'author_group'
  | 'template'
  | 'property'
  | 'status'
  | 'date_property';
export type TrustConditionOperator = 'equals' | 'contains' | 'starts_with' | 'exists' | 'older_than_days' | 'newer_than_days';

export interface TrustModel {
  id: string;
  name: string;
  active: boolean;
  baseScore: number;
  minTrustScoreForContext: number;
  includeDrafts: boolean;
  includeOutdated: boolean;
  stalenessPenaltyPerYear: number;
  requireVerifiedForDirectAnswer: boolean;
  requireSources: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrustEntity {
  id: string;
  modelId: string;
  entityType: TrustEntityType;
  name: string;
  value: string;
  weight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrustRule {
  id: string;
  modelId: string;
  entityId?: string;
  name: string;
  enabled: boolean;
  condition: {
    field: TrustConditionField;
    operator: TrustConditionOperator;
    value?: string;
    propertyName?: string;
  };
  modifier: number;
  flags: string[];
  excludeFromIndex: boolean;
  requireManualApproval: boolean;
  notifyAuthor: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrustStore {
  models: TrustModel[];
  entities: TrustEntity[];
  rules: TrustRule[];
}

export interface TrustPreviewInput {
  pageId?: number;
  title: string;
  namespace: number;
  categories: string[];
  tags: string[];
  authorGroups: string[];
  templates: string[];
  lastModified?: string;
  properties: Record<string, string[]>;
}

export interface TrustPreviewResult {
  modelId: string;
  score: number;
  baseScore: number;
  entityScoreDelta: number;
  ruleScoreDelta: number;
  lastModified?: string;
  ageYears?: number;
  stalenessPenalty: number;
  flags: string[];
  appliedEntities: Array<{
    id: string;
    name: string;
    entityType: TrustEntityType;
    value: string;
    weight: number;
  }>;
  appliedRules: Array<{
    id: string;
    name: string;
    modifier: number;
    flags: string[];
    excludeFromIndex: boolean;
    requireManualApproval: boolean;
    notifyAuthor: boolean;
  }>;
  decisions: {
    includeInContext: boolean;
    allowDirectAnswer: boolean;
    excludeFromIndex: boolean;
    requireManualApproval: boolean;
    notifyAuthor: boolean;
    requireSources: boolean;
  };
}

export interface LlmAdminConfig {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  showSources: boolean;
  systemPrompt: string;
  searchHistoryEnabled: boolean;
  searchHistoryLimit: number;
}

export interface EffectiveLlmConfig extends LlmAdminConfig {
  apiKey: string;
}

export type EmbeddingProvider = 'ollama' | 'openai_compatible';

export interface EmbeddingAdminConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKeyConfigured: boolean;
  lastTest?: EmbeddingTestResult;
}

export interface IndexingProfile {
  id: string;
  name: string;
  enabled: boolean;
  namespaces: number[];
  namespaceAcl: Record<string, string[]>;
  smwProperties: string[];
  titleFilters: {
    include: string[];
    exclude: string[];
  };
  categoryFilters: {
    include: string[];
    exclude: string[];
  };
  documentPolicyId: string;
  runMode: 'manual' | 'scheduled';
  scheduleIntervalMinutes?: number;
  indexTargets: string[];
  attachmentsEnabled: boolean;
  semanticFactsEnabled: boolean;
  ontologyVectorsEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  chunkSeparators: string[];
  dryRunDefault: boolean;
  maxPagesDefault?: number;
  createdAt: string;
  updatedAt: string;
}

export interface IndexingAutomationConfig {
  changeIndexingProfileId?: string;
  scheduledReindexProfileId?: string;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: number;
  updatedAt?: string;
}

export interface EffectiveEmbeddingConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey?: string;
}

export interface HttpTestResult {
  status: 'ok' | 'error';
  url: string;
  httpStatus?: number;
  latencyMs: number;
  error?: string;
}

export interface EmbeddingTestResult extends HttpTestResult {
  dimension?: number;
}

const urlSchema = z.string().trim().url();
const httpUrlSchema = urlSchema.refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'must be a valid HTTP(S) URL');
const optionalUrlSchema = z.string().trim().max(500).refine((value) => {
  if (value.length === 0) return true;
  return urlSchema.safeParse(value).success;
}, 'must be empty or a valid URL');
const optionalHttpUrlSchema = z.string().trim().max(500).refine((value) => {
  if (value.length === 0) return true;
  return httpUrlSchema.safeParse(value).success;
}, 'must be empty or a valid HTTP(S) URL');
const pathSchema = z.string().trim().min(1).regex(/^\//, 'apiPath must start with /');

const serviceConfigUpdateSchema = z.object({
  mediaWiki: z.object({
    baseUrl: urlSchema.optional(),
    apiPath: pathSchema.optional(),
  }).strict().optional(),
  gateway: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    corsOrigins: z.array(urlSchema).max(20).optional(),
  }).strict().optional(),
  syncer: z.object({
    baseUrl: urlSchema.optional(),
  }).strict().optional(),
  qdrant: z.object({
    url: urlSchema.optional(),
    collection: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  }).strict().optional(),
  opensearch: z.object({
    enabled: z.boolean().optional(),
    baseUrl: optionalHttpUrlSchema.optional(),
    indexName: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/).optional(),
    timeoutMs: z.number().int().min(500).max(120000).optional(),
    tlsRejectUnauthorized: z.boolean().optional(),
    analyzer: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/).optional(),
    fuzzyEnabled: z.boolean().optional(),
    highlightEnabled: z.boolean().optional(),
    titleBoost: z.number().min(0).max(20).optional(),
    textBoost: z.number().min(0).max(20).optional(),
    candidateLimit: z.number().int().min(5).max(200).optional(),
  }).strict().optional(),
  llm: z.object({
    baseUrl: urlSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    timeoutMs: z.number().int().min(5000).max(120000).optional(),
  }).strict().optional(),
  embeddings: z.object({
    provider: z.enum(['ollama', 'openai_compatible']).optional(),
    baseUrl: urlSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    dimensions: z.number().int().min(1).max(4096).optional(),
  }).strict().optional(),
}).strict();

export type ServiceConfigUpdate = z.infer<typeof serviceConfigUpdateSchema>;

const llmConfigUpdateSchema = z.object({
  baseUrl: urlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(5000).max(120000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(4096).optional(),
  showSources: z.boolean().optional(),
  systemPrompt: z.string().trim().min(1).max(8000).optional(),
  searchHistoryEnabled: z.boolean().optional(),
  searchHistoryLimit: z.number().int().min(1).max(20).optional(),
}).strict();

const embeddingConfigUpdateSchema = z.object({
  provider: z.enum(['ollama', 'openai_compatible']).optional(),
  baseUrl: urlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  dimensions: z.number().int().min(1).max(4096).optional(),
}).strict();

const filterSetSchema = z.object({
  include: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  exclude: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
}).strict();

const namespaceAclSchema = z.record(
  z.string().regex(/^\d+$/),
  z.array(z.string().trim().min(1).max(120)).min(1).max(50)
).refine((value) => Object.keys(value).length <= 100, {
  message: 'namespaceAcl can contain up to 100 namespaces',
});

const indexTargetSchema = z.enum([
  'dense',
  'bm25',
  'colbert',
  'opensearch',
  'attachments',
  'semanticFacts',
  'ontologyVectors',
]);

const chunkingRuleSchema = z.object({
  chunkSize: z.number().int().min(128).max(4096),
  chunkOverlap: z.number().int().min(0).max(2048),
  chunkSeparators: z.array(z.string().min(1)).min(1).max(16),
}).strict().refine((value) => value.chunkOverlap < value.chunkSize, {
  message: 'chunkOverlap must be lower than chunkSize',
  path: ['chunkOverlap'],
});

const chunkingNamespaceOverrideSchema = z.object({
  chunkSize: z.number().int().min(128).max(4096).optional(),
  chunkOverlap: z.number().int().min(0).max(2048).optional(),
  chunkSeparators: z.array(z.string().min(1)).min(1).max(16).optional(),
}).strict().refine((value) => {
  if (value.chunkSize === undefined || value.chunkOverlap === undefined) return true;
  return value.chunkOverlap < value.chunkSize;
}, {
  message: 'chunkOverlap must be lower than chunkSize',
  path: ['chunkOverlap'],
});

const chunkingPolicySchema = z.object({
  defaults: chunkingRuleSchema,
  sources: z.object({
    wiki_page: chunkingRuleSchema.optional(),
    attachment_text: chunkingRuleSchema.optional(),
    attachment_metadata: chunkingRuleSchema.optional(),
    cmdb_dynamic_snapshot: chunkingRuleSchema.optional(),
  }).strict(),
  namespaceOverrides: z.record(
    z.string().regex(/^\d+$/),
    chunkingNamespaceOverrideSchema
  ).refine((value) => Object.keys(value).length <= 100, {
    message: 'namespaceOverrides can contain up to 100 namespaces',
  }),
}).strict();

const indexingProfileInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  namespaces: z.array(z.number().int().min(0)).min(1).max(50),
  namespaceAcl: namespaceAclSchema.optional(),
  smwProperties: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  titleFilters: filterSetSchema.optional(),
  categoryFilters: filterSetSchema.optional(),
  documentPolicyId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  runMode: z.enum(['manual', 'scheduled']).optional(),
  scheduleIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  indexTargets: z.array(indexTargetSchema).min(1).max(7).optional(),
  attachmentsEnabled: z.boolean().optional(),
  semanticFactsEnabled: z.boolean().optional(),
  ontologyVectorsEnabled: z.boolean().optional(),
  chunkSize: z.number().int().min(128).max(4096).optional(),
  chunkOverlap: z.number().int().min(0).max(2048).optional(),
  chunkSeparators: z.array(z.string().min(1)).min(1).max(16).optional(),
  dryRunDefault: z.boolean().optional(),
  maxPagesDefault: z.number().int().min(1).max(10000).nullable().optional(),
}).strict().refine((value) => {
  if (value.chunkSize === undefined || value.chunkOverlap === undefined) return true;
  return value.chunkOverlap < value.chunkSize;
}, {
  message: 'chunkOverlap must be lower than chunkSize',
  path: ['chunkOverlap'],
});

const optionalProfileIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).nullable();

const indexingAutomationConfigInputSchema = z.object({
  changeIndexingProfileId: optionalProfileIdSchema.optional(),
  scheduledReindexProfileId: optionalProfileIdSchema.optional(),
  scheduleEnabled: z.boolean().optional(),
  scheduleIntervalMinutes: z.number().int().min(5).max(10080).optional(),
}).strict();

const ragConfigBaseSchema = z.object({
  chunkSize: z.number().int().min(128).max(4096),
  chunkOverlap: z.number().int().min(0).max(2048),
  chunkSeparators: z.array(z.string().min(1)).min(1).max(16),
  chunkingPolicy: chunkingPolicySchema,
  minChunkLength: z.number().int().min(1).max(1024),
  maxChunksPerPage: z.number().int().min(1).max(10000),
  retrievalTopK: z.number().int().min(1).max(20),
  contextTopK: z.number().int().min(1).max(50),
  contextMaxChars: z.number().int().min(1000).max(200000),
  chatRetrievalQueryMode: z.enum(['current_message', 'history_augmented']),
  topK: z.number().int().min(1).max(20),
  maxContextChunks: z.number().int().min(1).max(50),
  maxContextChars: z.number().int().min(1000).max(200000),
  minSearchScore: z.number().min(0).max(1),
  searchMode: z.enum(['vector_only', 'hybrid', 'colbert_full', 'hybrid_colbert']),
  rerankMode: z.enum(['none', 'colbert_v2']),
  vectorWeight: z.number().min(0).max(1),
  lexicalWeight: z.number().min(0).max(1),
  lexicalBackend: z.enum(['sqlite_fts', 'opensearch']),
  vectorCandidateLimit: z.number().int().min(5).max(200),
  lexicalCandidateLimit: z.number().int().min(5).max(200),
  lexicalMinMatchedTerms: z.number().int().min(1).max(6),
  lexicalGateMode: z.enum(['off', 'when_bm25_available']),
  lexicalNormalizationMode: z.enum(['simple_stem', 'raw_prefix']),
  lexicalSynonymsEnabled: z.boolean(),
  lexicalSynonyms: z.array(z.object({
    term: z.string().trim().min(1).max(80),
    synonyms: z.array(z.string().trim().min(1).max(80)).min(1).max(24),
  }).strict()).max(100),
  lexicalTransliterationEnabled: z.boolean(),
  lexicalEditDistanceEnabled: z.boolean(),
  trigramIndexEnabled: z.boolean(),
  trigramCandidateLimit: z.number().int().min(5).max(200),
  trigramMinQueryLength: z.number().int().min(3).max(32),
  vectorOnlyFallbackEnabled: z.boolean(),
  vectorOnlyFallbackMinScore: z.number().min(0).max(1),
  minFinalScore: z.number().min(0).max(1),
  showRawScores: z.boolean(),
  colbertEnabled: z.boolean(),
  colbertBaseUrl: optionalUrlSchema,
  colbertModel: z.string().trim().min(1).max(200),
  colbertCollection: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/),
  colbertCandidateLimit: z.number().int().min(5).max(200),
  colbertTimeoutMs: z.number().int().min(500).max(60000),
  colbertMinScore: z.number().min(0).max(1),
  colbertTailDropEnabled: z.boolean(),
  colbertTailMaxGap: z.number().min(0).max(1),
  colbertTailMinScore: z.number().min(0).max(1),
  colbertTailMinKeep: z.number().int().min(1).max(20),
  colbertFailMode: z.enum(['fallback_current', 'fail_search']),
  semanticFactsInContext: z.boolean(),
  includeAttachments: z.boolean(),
  includeSemanticHeader: z.boolean(),
}).strict();

const ragConfigSchema = ragConfigBaseSchema
  .refine((value) => value.chunkOverlap < value.chunkSize, {
    message: 'chunkOverlap must be lower than chunkSize',
    path: ['chunkOverlap'],
  })
  .refine((value) => value.vectorWeight + value.lexicalWeight > 0, {
    message: 'vectorWeight and lexicalWeight cannot both be zero',
    path: ['vectorWeight'],
  });

const ragConfigUpdateSchema = ragConfigBaseSchema.partial().strict();

const retrievalProfileRagConfigSchema = ragConfigBaseSchema.pick({
  retrievalTopK: true,
  contextTopK: true,
  contextMaxChars: true,
  chatRetrievalQueryMode: true,
  topK: true,
  maxContextChunks: true,
  maxContextChars: true,
  searchMode: true,
  rerankMode: true,
  vectorWeight: true,
  lexicalWeight: true,
  lexicalBackend: true,
  vectorCandidateLimit: true,
  lexicalCandidateLimit: true,
  lexicalMinMatchedTerms: true,
  lexicalGateMode: true,
  lexicalNormalizationMode: true,
  lexicalSynonymsEnabled: true,
  lexicalSynonyms: true,
  lexicalTransliterationEnabled: true,
  lexicalEditDistanceEnabled: true,
  trigramIndexEnabled: true,
  trigramCandidateLimit: true,
  trigramMinQueryLength: true,
  vectorOnlyFallbackEnabled: true,
  vectorOnlyFallbackMinScore: true,
  minFinalScore: true,
  showRawScores: true,
  colbertEnabled: true,
  colbertCandidateLimit: true,
  colbertTimeoutMs: true,
  colbertMinScore: true,
  colbertTailDropEnabled: true,
  colbertTailMaxGap: true,
  colbertTailMinScore: true,
  colbertTailMinKeep: true,
  colbertFailMode: true,
  semanticFactsInContext: true,
  includeAttachments: true,
  includeSemanticHeader: true,
});

const retrievalProfileConfigSchema = retrievalProfileRagConfigSchema.extend({
  llmModel: z.string().trim().min(1).max(200).optional(),
  llmTemperature: z.number().min(0).max(2).optional(),
  llmMaxTokens: z.number().int().min(64).max(4096).optional(),
  llmTimeoutMs: z.number().int().min(5000).max(120000).optional(),
  systemPrompt: z.string().trim().min(1).max(8000).optional(),
  conflictSystemPrompt: z.string().trim().min(1).max(8000).optional(),
  showSources: z.boolean().optional(),
  assistantUiMode: z.enum(['compact', 'standard', 'expert']).optional(),
}).strict();

const retrievalProfileInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  apiEnabled: z.boolean().optional(),
  mcpEnabled: z.boolean().optional(),
  anonymousAllowed: z.boolean().optional(),
  maxTopK: z.number().int().min(1).max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  chatProfileId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  config: retrievalProfileConfigSchema,
}).strict();

function normalizeRetrievalProfileInput(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.config)) return input;
  return {
    ...input,
    config: withRetrievalLimitAliases({
      chatRetrievalQueryMode: 'current_message',
      ...(input.config as DeepPartial<RagAdminConfig>),
    }),
  };
}

const webhookConfigSchema = z.object({
  syncerUrl: urlSchema,
  events: z.object({
    edit: z.boolean(),
    delete: z.boolean(),
    move: z.boolean(),
    protect: z.boolean(),
  }).strict(),
  timeoutMs: z.number().int().min(1000).max(30000),
  retryCount: z.number().int().min(0).max(10),
  retryBackoffMs: z.number().int().min(100).max(60000),
  lastStatus: z.object({
    status: z.enum(['ok', 'error']),
    url: z.string(),
    httpStatus: z.number().int().optional(),
    latencyMs: z.number().int(),
    error: z.string().optional(),
  }).optional(),
}).strict();

const webhookConfigUpdateSchema = z.object({
  syncerUrl: urlSchema.optional(),
  events: z.object({
    edit: z.boolean().optional(),
    delete: z.boolean().optional(),
    move: z.boolean().optional(),
    protect: z.boolean().optional(),
  }).strict().optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  retryBackoffMs: z.number().int().min(100).max(60000).optional(),
}).strict();

const chatExportFormatSchema = z.enum(['json', 'csv', 'html']);
const chatExportOptionsSchema = z.object({
  formats: z.array(chatExportFormatSchema).min(1).max(3),
  includeMetadata: z.boolean(),
  includeSources: z.boolean(),
  includeMessages: z.boolean(),
}).strict();

const chatRetentionConfigSchema = z.object({
  retentionMode: z.enum(['auto_delete', 'archive', 'export_then_archive']),
  activeDays: z.number().int().min(1).max(3650),
  recentDays: z.number().int().min(1).max(3650),
  archiveDays: z.number().int().min(1).max(3650),
  maxPinnedChats: z.number().int().min(0).max(100),
  maxActiveChats: z.number().int().min(1).max(10000),
  maxTotalChats: z.number().int().min(1).max(100000),
  onLimitExceeded: z.enum(['delete_oldest', 'block_new', 'archive_oldest']),
  exportOptions: chatExportOptionsSchema,
}).strict()
  .refine((value) => value.recentDays <= value.activeDays, {
    message: 'recentDays must be lower than or equal to activeDays',
    path: ['recentDays'],
  })
  .refine((value) => value.archiveDays >= value.activeDays, {
    message: 'archiveDays must be greater than or equal to activeDays',
    path: ['archiveDays'],
  })
  .refine((value) => value.maxActiveChats <= value.maxTotalChats, {
    message: 'maxActiveChats must be lower than or equal to maxTotalChats',
    path: ['maxActiveChats'],
  });

const chatRetentionConfigUpdateSchema = z.object({
  retentionMode: z.enum(['auto_delete', 'archive', 'export_then_archive']).optional(),
  activeDays: z.number().int().min(1).max(3650).optional(),
  recentDays: z.number().int().min(1).max(3650).optional(),
  archiveDays: z.number().int().min(1).max(3650).optional(),
  maxPinnedChats: z.number().int().min(0).max(100).optional(),
  maxActiveChats: z.number().int().min(1).max(10000).optional(),
  maxTotalChats: z.number().int().min(1).max(100000).optional(),
  onLimitExceeded: z.enum(['delete_oldest', 'block_new', 'archive_oldest']).optional(),
  exportOptions: chatExportOptionsSchema.partial().strict().optional(),
}).strict();

const trustRecalculationConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(10080),
  maxScan: z.number().int().min(1).max(100000),
  batchSize: z.number().int().min(1).max(500),
}).strict();

const trustRecalculationConfigUpdateSchema = trustRecalculationConfigSchema.partial().strict();

const conflictDetectionConfigSchema = z.object({
  enabled: z.boolean(),
  runMode: z.enum(['risk_only', 'always', 'manual']),
  attachmentParentConflictMode: z.enum(['disabled', 'risk_only', 'always']),
  model: z.string().trim().min(1).max(200),
  systemPrompt: z.string().trim().min(1).max(8000),
  maxSources: z.number().int().min(2).max(10),
  maxCharsPerSource: z.number().int().min(300).max(12000),
  trustGapThreshold: z.number().min(0).max(1),
  lowConfidenceThreshold: z.number().min(0).max(1),
  showConflictBlock: z.boolean(),
}).strict();

const conflictDetectionConfigUpdateSchema = conflictDetectionConfigSchema.partial().strict();

const trustModelInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  name: z.string().trim().min(1).max(160),
  active: z.boolean().optional(),
  baseScore: z.number().min(0).max(1).optional(),
  minTrustScoreForContext: z.number().min(0).max(1).optional(),
  includeDrafts: z.boolean().optional(),
  includeOutdated: z.boolean().optional(),
  stalenessPenaltyPerYear: z.number().min(0).max(1).optional(),
  requireVerifiedForDirectAnswer: z.boolean().optional(),
  requireSources: z.boolean().optional(),
}).strict();

const trustEntityTypeSchema = z.enum([
  'namespace',
  'category',
  'tag',
  'author_group',
  'page_property',
  'template',
  'date_property',
  'smw_property',
]);

const trustEntityInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  entityType: trustEntityTypeSchema,
  name: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(240),
  weight: z.number().min(-1).max(1).optional(),
  enabled: z.boolean().optional(),
}).strict();

const trustRuleInputSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  entityId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean().optional(),
  condition: z.object({
    field: z.enum([
      'namespace',
      'title',
      'category',
      'tag',
      'author_group',
      'template',
      'property',
      'status',
      'date_property',
    ]),
    operator: z.enum(['equals', 'contains', 'starts_with', 'exists', 'older_than_days', 'newer_than_days']),
    value: z.string().trim().max(240).optional(),
    propertyName: z.string().trim().max(160).optional(),
  }).strict(),
  modifier: z.number().min(-1).max(1).optional(),
  flags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  excludeFromIndex: z.boolean().optional(),
  requireManualApproval: z.boolean().optional(),
  notifyAuthor: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

const trustPreviewInputSchema = z.object({
  pageId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(500),
  namespace: z.number().int().min(0),
  categories: z.array(z.string().trim().min(1).max(240)).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  authorGroups: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  templates: z.array(z.string().trim().min(1).max(240)).max(200).optional(),
  lastModified: z.string().trim().max(80).optional(),
  properties: z.record(z.union([
    z.string().trim().max(1000),
    z.array(z.string().trim().max(1000)).max(100),
    z.number(),
    z.boolean(),
  ])).optional(),
}).strict();

function redactUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return value;
  }
}

function urlHasCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function normalizeOpenSearchAdminConfig(value: OpenSearchAdminConfig): OpenSearchAdminConfig {
  const baseUrl = value.baseUrl.trim().length === 0
    ? DEFAULT_OPENSEARCH_BASE_URL
    : value.baseUrl;
  return {
    ...value,
    baseUrl,
    authConfigured: Boolean(
      value.apiKeyConfigured ||
      (value.usernameConfigured && value.passwordConfigured) ||
      urlHasCredentials(baseUrl)
    ),
  };
}

function applyServiceOverrides(base: ServiceAdminConfig, overrides: ServiceConfigUpdate): ServiceAdminConfig {
  return {
    ...base,
    mediaWiki: { ...base.mediaWiki, ...overrides.mediaWiki },
    gateway: { ...base.gateway, ...overrides.gateway },
    syncer: { ...base.syncer, ...overrides.syncer },
    qdrant: { ...base.qdrant, ...overrides.qdrant },
    opensearch: normalizeOpenSearchAdminConfig({ ...base.opensearch, ...overrides.opensearch }),
    llm: { ...base.llm, ...overrides.llm },
    embeddings: { ...base.embeddings, ...overrides.embeddings },
  };
}

function mergeServiceUpdates(current: ServiceConfigUpdate, next: ServiceConfigUpdate): ServiceConfigUpdate {
  const merged = {
    mediaWiki: { ...current.mediaWiki, ...next.mediaWiki },
    gateway: { ...current.gateway, ...next.gateway },
    syncer: { ...current.syncer, ...next.syncer },
    qdrant: { ...current.qdrant, ...next.qdrant },
    opensearch: { ...current.opensearch, ...next.opensearch },
    llm: { ...current.llm, ...next.llm },
    embeddings: { ...current.embeddings, ...next.embeddings },
  };
  return normalizeOpenSearchUpdate(merged);
}

function normalizeOpenSearchUpdate(value: ServiceConfigUpdate): ServiceConfigUpdate {
  if (!value.opensearch?.enabled) return value;
  const baseUrl = value.opensearch.baseUrl?.trim();
  if (baseUrl) return value;
  return {
    ...value,
    opensearch: {
      ...value.opensearch,
      baseUrl: DEFAULT_OPENSEARCH_BASE_URL,
    },
  };
}

function cleanEmptySections<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested !== undefined;
      return Object.keys(nested).length > 0;
    })
  ) as T;
}

function cleanUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function cleanNestedUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [key, item];
      return [key, cleanUndefined(item as Record<string, unknown>)];
    })
  ) as T;
}

export function buildServiceUrl(baseUrl: string, pathSuffix: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathSuffix.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}

async function getRuntimeServiceConfig(): Promise<ServiceAdminConfig> {
  const runtimeConfig = await getRuntimeConfig();
  const database = parseDatabaseUrl(config.databaseUrl);
  let databaseStatus: Pick<ServiceAdminConfig['database'], 'connectionStatus' | 'migrationStatus' | 'error'> = {
    connectionStatus: 'ok',
    migrationStatus: 'ok',
  };
  try {
    await getAdminStore().getJson('__diagnostics__', '__connection__');
  } catch (err) {
    databaseStatus = {
      connectionStatus: 'error',
      migrationStatus: 'error',
      error: err instanceof Error ? err.message : 'Unable to verify database connection',
    };
  }
  const mediaWikiServiceAuth = await getSyncerMediaWikiServiceAuthStatus(config.syncerBaseUrl)
    .catch((err: unknown) => ({
      configured: false,
      source: 'unknown' as const,
      usernameConfigured: false,
      passwordConfigured: false,
      passwordUsesSecretReference: false,
      pamProviderConfigured: false,
      deprecatedCookieConfigured: false,
      error: err instanceof Error ? err.message : 'Unable to read Syncer MediaWiki auth status',
    }));

  return {
    database: {
      url: database.redactedUrl,
      dialect: database.dialect,
      ...databaseStatus,
    },
    mediaWiki: {
      baseUrl: config.mwBaseUrl,
      apiPath: config.mwApiPath,
    },
    gateway: {
      port: config.gatewayPort,
      nodeEnv: config.nodeEnv,
      corsOrigins: config.corsOrigins,
    },
    syncer: {
      baseUrl: config.syncerBaseUrl,
      adminTokenConfigured: Boolean(config.syncerAdminToken),
      mediaWikiServiceAuth,
    },
    redis: {
      url: redactUrlCredentials(config.redisUrl),
    },
    qdrant: {
      url: config.qdrantUrl,
      collection: config.qdrantCollection,
    },
    opensearch: {
      enabled: config.opensearchEnabled,
      baseUrl: redactUrlCredentials(config.opensearchBaseUrl),
      indexName: config.opensearchIndexName,
      usernameConfigured: Boolean(config.opensearchUsername),
      passwordConfigured: Boolean(config.opensearchPassword),
      apiKeyConfigured: Boolean(config.opensearchApiKey),
      authConfigured: Boolean(config.opensearchApiKey || (config.opensearchUsername && config.opensearchPassword) || urlHasCredentials(config.opensearchBaseUrl)),
      timeoutMs: config.opensearchTimeoutMs,
      tlsRejectUnauthorized: config.opensearchTlsRejectUnauthorized,
      analyzer: config.opensearchAnalyzer,
      fuzzyEnabled: config.opensearchFuzzyEnabled,
      highlightEnabled: config.opensearchHighlightEnabled,
      titleBoost: config.opensearchTitleBoost,
      textBoost: config.opensearchTextBoost,
      candidateLimit: config.opensearchCandidateLimit,
    },
    llm: {
      baseUrl: config.litellmBaseUrl,
      model: runtimeConfig.litellmModel,
      apiKeyConfigured: Boolean(config.litellmApiKey),
      timeoutMs: runtimeConfig.timeoutMs,
    },
    embeddings: {
      provider: 'ollama',
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaEmbeddingModel,
      dimensions: QDRANT_VECTOR_SIZE,
      apiKeyConfigured: false,
    },
  };
}

async function getServiceOverrides(): Promise<ServiceConfigUpdate> {
  return (await getAdminStore().getJson<ServiceConfigUpdate>(SERVICE_CONFIG_AREA, DEFAULT_KEY)) ?? {};
}

export async function getServiceAdminConfig(): Promise<ServiceAdminConfigResponse> {
  const runtime = await getRuntimeServiceConfig();
  const overrides = await getServiceOverrides();
  const values = applyServiceOverrides(runtime, overrides);
  values.opensearch.baseUrl = redactUrlCredentials(values.opensearch.baseUrl);
  values.embeddings.apiKeyConfigured = values.embeddings.provider === 'openai_compatible'
    ? Boolean(config.litellmApiKey)
    : false;

  return {
    values,
    runtime,
    overrides,
    metadata: {
      secretsRedacted: true,
      requiresRestart: [
        'database',
        'mediaWiki',
        'gateway.port',
        'syncer.baseUrl',
        'qdrant',
        'opensearch.auth',
        'embeddings',
      ],
      note: 'LLM and embedding runtime calls use saved overrides with env fallback. Infrastructure settings such as database, ports and MediaWiki extension URLs can still require restart or LocalSettings.php changes.',
    },
  };
}

export async function setServiceAdminConfig(input: unknown, actor?: string): Promise<ServiceAdminConfigResponse> {
  const next = serviceConfigUpdateSchema.parse(input);
  const current = await getServiceOverrides();
  const merged = cleanEmptySections(mergeServiceUpdates(current, next));
  await getAdminStore().setJson(SERVICE_CONFIG_AREA, DEFAULT_KEY, merged, {
    actor,
    action: 'service-config.update',
    entityType: SERVICE_CONFIG_AREA,
  });
  return getServiceAdminConfig();
}

export async function getEffectiveOpenSearchConfig(): Promise<EffectiveOpenSearchConfig> {
  const overrides = await getServiceOverrides();
  const username = config.opensearchUsername || undefined;
  const password = config.opensearchPassword || undefined;
  const apiKey = config.opensearchApiKey || undefined;
  const enabled = overrides.opensearch?.enabled ?? config.opensearchEnabled;
  const configuredBaseUrl = overrides.opensearch?.baseUrl ?? config.opensearchBaseUrl;
  const baseUrl = configuredBaseUrl.trim().length === 0
    ? DEFAULT_OPENSEARCH_BASE_URL
    : configuredBaseUrl;
  return {
    enabled,
    baseUrl,
    indexName: overrides.opensearch?.indexName ?? config.opensearchIndexName,
    usernameConfigured: Boolean(username),
    passwordConfigured: Boolean(password),
    apiKeyConfigured: Boolean(apiKey),
    authConfigured: Boolean(apiKey || (username && password) || urlHasCredentials(baseUrl)),
    timeoutMs: overrides.opensearch?.timeoutMs ?? config.opensearchTimeoutMs,
    tlsRejectUnauthorized: overrides.opensearch?.tlsRejectUnauthorized ?? config.opensearchTlsRejectUnauthorized,
    analyzer: overrides.opensearch?.analyzer ?? config.opensearchAnalyzer,
    fuzzyEnabled: overrides.opensearch?.fuzzyEnabled ?? config.opensearchFuzzyEnabled,
    highlightEnabled: overrides.opensearch?.highlightEnabled ?? config.opensearchHighlightEnabled,
    titleBoost: overrides.opensearch?.titleBoost ?? config.opensearchTitleBoost,
    textBoost: overrides.opensearch?.textBoost ?? config.opensearchTextBoost,
    candidateLimit: overrides.opensearch?.candidateLimit ?? config.opensearchCandidateLimit,
    username,
    password,
    apiKey,
  };
}

async function saveServiceOverrides(
  patch: ServiceConfigUpdate,
  actor: string | undefined,
  action: string,
  entityType: string
): Promise<ServiceConfigUpdate> {
  const current = await getServiceOverrides();
  const merged = cleanEmptySections(mergeServiceUpdates(current, cleanNestedUndefined(patch)));
  await getAdminStore().setJson(SERVICE_CONFIG_AREA, DEFAULT_KEY, merged, {
    actor,
    action,
    entityType,
  });
  return merged;
}

export async function getEffectiveLlmConfig(): Promise<EffectiveLlmConfig> {
  const runtime = await getRuntimeConfig();
  const overrides = await getServiceOverrides();
  const llm = overrides.llm ?? {};

  return {
    provider: 'openai-compatible',
    baseUrl: llm.baseUrl ?? config.litellmBaseUrl,
    model: llm.model ?? runtime.litellmModel,
    apiKey: config.litellmApiKey,
    apiKeyConfigured: Boolean(config.litellmApiKey),
    timeoutMs: llm.timeoutMs ?? runtime.timeoutMs,
    temperature: runtime.temperature,
    maxTokens: runtime.maxTokens,
    showSources: runtime.showSources,
    systemPrompt: runtime.systemPrompt,
    searchHistoryEnabled: runtime.searchHistoryEnabled,
    searchHistoryLimit: runtime.searchHistoryLimit,
  };
}

export async function getLlmAdminConfig(): Promise<LlmAdminConfig> {
  const { apiKey: _apiKey, ...safe } = await getEffectiveLlmConfig();
  return safe;
}

export async function setLlmAdminConfig(input: unknown, actor?: string): Promise<LlmAdminConfig> {
  const patch = llmConfigUpdateSchema.parse(input);

  await saveServiceOverrides(
    {
      llm: {
        baseUrl: patch.baseUrl,
        model: patch.model,
        timeoutMs: patch.timeoutMs,
      },
    },
    actor,
    'llm-config.update',
    'llm-config'
  );

  await setRuntimeConfig(cleanUndefined({
    litellmModel: patch.model,
    timeoutMs: patch.timeoutMs,
    temperature: patch.temperature,
    maxTokens: patch.maxTokens,
    showSources: patch.showSources,
    systemPrompt: patch.systemPrompt,
    searchHistoryEnabled: patch.searchHistoryEnabled,
    searchHistoryLimit: patch.searchHistoryLimit,
  }));

  return getLlmAdminConfig();
}

export async function getEffectiveEmbeddingConfig(): Promise<EffectiveEmbeddingConfig> {
  const overrides = await getServiceOverrides();
  const provider = overrides.embeddings?.provider ?? 'ollama';
  return {
    provider,
    baseUrl: overrides.embeddings?.baseUrl ?? (
      provider === 'openai_compatible' ? config.litellmBaseUrl : config.ollamaBaseUrl
    ),
    model: overrides.embeddings?.model ?? (
      provider === 'openai_compatible' ? 'text-embedding-3-small' : config.ollamaEmbeddingModel
    ),
    dimensions: overrides.embeddings?.dimensions ?? QDRANT_VECTOR_SIZE,
    apiKey: provider === 'openai_compatible' ? config.litellmApiKey : undefined,
  };
}

export async function getEmbeddingAdminConfig(): Promise<EmbeddingAdminConfig> {
  const current = await getEffectiveEmbeddingConfig();
  const stored = (await getAdminStore().getJson<DeepPartial<EmbeddingAdminConfig>>('embedding-config', DEFAULT_KEY)) ?? {};
  return {
    provider: current.provider,
    baseUrl: current.baseUrl,
    model: current.model,
    dimensions: current.dimensions,
    apiKeyConfigured: current.provider === 'openai_compatible' ? Boolean(current.apiKey) : false,
    lastTest: stored.lastTest,
  };
}

export async function setEmbeddingAdminConfig(input: unknown, actor?: string): Promise<EmbeddingAdminConfig> {
  const patch = embeddingConfigUpdateSchema.parse(input);
  await saveServiceOverrides(
    {
      embeddings: {
        provider: patch.provider,
        baseUrl: patch.baseUrl,
        model: patch.model,
        dimensions: patch.dimensions,
      },
    },
    actor,
    'embedding-config.update',
    'embedding-config'
  );

  return getEmbeddingAdminConfig();
}

function profileIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || randomUUID();
}

function idFromName(name: string): string {
  return profileIdFromName(name);
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

function defaultNamespaceAcl(namespaces: number[]): Record<string, string[]> {
  return Object.fromEntries(uniqueNumbers(namespaces).map((namespace) => [String(namespace), ['*']]));
}

function normalizeFilterSet(input?: { include?: string[]; exclude?: string[] }): { include: string[]; exclude: string[] } {
  return {
    include: input?.include ?? [],
    exclude: input?.exclude ?? [],
  };
}

function normalizeNamespaceAcl(
  input: Record<string, string[]> | undefined,
  namespaces: number[],
  fallback?: Record<string, string[]>
): Record<string, string[]> {
  if (input && Object.keys(input).length > 0) return input;
  if (fallback && Object.keys(fallback).length > 0) return fallback;
  return defaultNamespaceAcl(namespaces);
}

function defaultIndexTargets(input: {
  attachmentsEnabled?: boolean;
  semanticFactsEnabled?: boolean;
  ontologyVectorsEnabled?: boolean;
  colbertEnabled?: boolean;
  opensearchEnabled?: boolean;
}): string[] {
  return [
    'dense',
    'bm25',
    ...(input.colbertEnabled ? ['colbert'] : []),
    ...(input.opensearchEnabled ? ['opensearch'] : []),
    ...(input.attachmentsEnabled ? ['attachments'] : []),
    ...(input.semanticFactsEnabled !== false ? ['semanticFacts'] : []),
    ...(input.ontologyVectorsEnabled ? ['ontologyVectors'] : []),
  ];
}

function syncAttachmentIndexTarget(indexTargets: string[] | undefined, attachmentsEnabled: boolean): string[] | undefined {
  if (!indexTargets) return undefined;
  const targets = new Set(indexTargets);
  if (attachmentsEnabled) {
    targets.add('attachments');
  } else {
    targets.delete('attachments');
  }
  return Array.from(targets);
}

async function getDefaultIndexingProfile(): Promise<IndexingProfile> {
  const rag = await getRagAdminConfig();
  const now = new Date().toISOString();
  const namespaces = [0];
  const attachmentsEnabled = true;
  return {
    id: 'default',
    name: 'Default env profile',
    enabled: true,
    namespaces,
    namespaceAcl: defaultNamespaceAcl(namespaces),
    smwProperties: await getIndexedSmwProperties(),
    titleFilters: { include: [], exclude: [] },
    categoryFilters: { include: [], exclude: [] },
    documentPolicyId: 'default',
    runMode: 'manual',
    indexTargets: defaultIndexTargets({
      attachmentsEnabled,
      semanticFactsEnabled: true,
      ontologyVectorsEnabled: false,
      colbertEnabled: rag.colbertEnabled,
      opensearchEnabled: rag.lexicalBackend === 'opensearch',
    }),
    attachmentsEnabled,
    semanticFactsEnabled: true,
    ontologyVectorsEnabled: false,
    chunkSize: rag.chunkSize,
    chunkOverlap: rag.chunkOverlap,
    chunkSeparators: rag.chunkSeparators,
    dryRunDefault: false,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeLegacyDefaultIndexingProfile(profile: IndexingProfile): IndexingProfile {
  const normalized: IndexingProfile = {
    ...profile,
    indexTargets: profile.indexTargets ?? defaultIndexTargets(profile),
  };
  if (
    normalized.id === 'default'
    && normalized.name === 'Default env profile'
    && normalized.maxPagesDefault === 10
  ) {
    const { maxPagesDefault: _legacyLimit, ...withoutLegacyLimit } = normalized;
    return withoutLegacyLimit;
  }
  return normalized;
}

export async function getIndexingProfiles(): Promise<IndexingProfile[]> {
  const stored = await getAdminStore().getJson<IndexingProfile[]>(INDEXING_PROFILE_AREA, DEFAULT_KEY);
  if (stored && stored.length > 0) return stored.map(normalizeLegacyDefaultIndexingProfile);
  return [await getDefaultIndexingProfile()];
}

function normalizeProfileId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export async function getIndexingAutomationConfig(): Promise<IndexingAutomationConfig> {
  const stored = (await getAdminStore().getJson<Partial<IndexingAutomationConfig>>(
    INDEXING_AUTOMATION_CONFIG_AREA,
    DEFAULT_KEY,
  )) ?? {};

  return {
    changeIndexingProfileId: normalizeProfileId(stored.changeIndexingProfileId),
    scheduledReindexProfileId: normalizeProfileId(stored.scheduledReindexProfileId),
    scheduleEnabled: Boolean(stored.scheduleEnabled),
    scheduleIntervalMinutes: Number.isInteger(stored.scheduleIntervalMinutes)
      ? Math.max(5, Math.min(stored.scheduleIntervalMinutes ?? DEFAULT_INDEXING_SCHEDULE_INTERVAL_MINUTES, 10080))
      : DEFAULT_INDEXING_SCHEDULE_INTERVAL_MINUTES,
    updatedAt: stored.updatedAt,
  };
}

function profileExists(profiles: IndexingProfile[], profileId: string | undefined): boolean {
  return !profileId || profiles.some((profile) => profile.id === profileId);
}

export async function setIndexingAutomationConfig(input: unknown, actor?: string): Promise<IndexingAutomationConfig> {
  const parsed = indexingAutomationConfigInputSchema.parse(input);
  const current = await getIndexingAutomationConfig();
  const profiles = await getIndexingProfiles();
  const hasChangeProfile = Object.prototype.hasOwnProperty.call(parsed, 'changeIndexingProfileId');
  const hasScheduledProfile = Object.prototype.hasOwnProperty.call(parsed, 'scheduledReindexProfileId');
  const next: IndexingAutomationConfig = {
    changeIndexingProfileId: hasChangeProfile
      ? normalizeProfileId(parsed.changeIndexingProfileId)
      : current.changeIndexingProfileId,
    scheduledReindexProfileId: hasScheduledProfile
      ? normalizeProfileId(parsed.scheduledReindexProfileId)
      : current.scheduledReindexProfileId,
    scheduleEnabled: parsed.scheduleEnabled ?? current.scheduleEnabled,
    scheduleIntervalMinutes: parsed.scheduleIntervalMinutes ?? current.scheduleIntervalMinutes,
    updatedAt: new Date().toISOString(),
  };

  if (!profileExists(profiles, next.changeIndexingProfileId)) {
    throw new Error(`Indexing profile not found: ${next.changeIndexingProfileId}`);
  }
  if (!profileExists(profiles, next.scheduledReindexProfileId)) {
    throw new Error(`Indexing profile not found: ${next.scheduledReindexProfileId}`);
  }
  if (next.scheduleEnabled && !next.scheduledReindexProfileId) {
    throw new Error('scheduledReindexProfileId is required when scheduleEnabled is true');
  }

  await getAdminStore().setJson(INDEXING_AUTOMATION_CONFIG_AREA, DEFAULT_KEY, next, {
    actor,
    action: 'indexing-automation.update',
    entityType: INDEXING_AUTOMATION_CONFIG_AREA,
  });

  return next;
}

export async function upsertIndexingProfile(input: unknown, actor?: string): Promise<IndexingProfile> {
  const parsed = indexingProfileInputSchema.parse(input);
  const profiles = await getIndexingProfiles();
  const now = new Date().toISOString();
  const existing = parsed.id ? profiles.find((profile) => profile.id === parsed.id) : undefined;
  const id = parsed.id ?? profileIdFromName(parsed.name);
  const attachmentsEnabled = parsed.attachmentsEnabled ?? existing?.attachmentsEnabled ?? false;
  const semanticFactsEnabled = parsed.semanticFactsEnabled ?? existing?.semanticFactsEnabled ?? true;
  const ontologyVectorsEnabled = parsed.ontologyVectorsEnabled ?? existing?.ontologyVectorsEnabled ?? false;

  const profile: IndexingProfile = {
    id,
    name: parsed.name,
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    namespaces: uniqueNumbers(parsed.namespaces),
    namespaceAcl: normalizeNamespaceAcl(parsed.namespaceAcl, parsed.namespaces, existing?.namespaceAcl),
    smwProperties: parsed.smwProperties ?? existing?.smwProperties ?? [],
    titleFilters: normalizeFilterSet(parsed.titleFilters ?? existing?.titleFilters),
    categoryFilters: normalizeFilterSet(parsed.categoryFilters ?? existing?.categoryFilters),
    documentPolicyId: parsed.documentPolicyId ?? existing?.documentPolicyId ?? 'default',
    runMode: parsed.runMode ?? existing?.runMode ?? 'manual',
    scheduleIntervalMinutes: parsed.scheduleIntervalMinutes ?? existing?.scheduleIntervalMinutes,
    indexTargets: syncAttachmentIndexTarget(
      parsed.indexTargets ?? existing?.indexTargets ?? defaultIndexTargets({
        attachmentsEnabled,
        semanticFactsEnabled,
        ontologyVectorsEnabled,
      }),
      attachmentsEnabled,
    ) ?? [],
    attachmentsEnabled,
    semanticFactsEnabled,
    ontologyVectorsEnabled,
    chunkSize: parsed.chunkSize ?? existing?.chunkSize ?? (await getRagAdminConfig()).chunkSize,
    chunkOverlap: parsed.chunkOverlap ?? existing?.chunkOverlap ?? (await getRagAdminConfig()).chunkOverlap,
    chunkSeparators: parsed.chunkSeparators ?? existing?.chunkSeparators ?? (await getRagAdminConfig()).chunkSeparators,
    dryRunDefault: parsed.dryRunDefault ?? existing?.dryRunDefault ?? false,
    maxPagesDefault: parsed.maxPagesDefault === null
      ? undefined
      : parsed.maxPagesDefault ?? existing?.maxPagesDefault,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const updatedProfiles = [
    ...profiles.filter((item) => item.id !== id),
    profile,
  ].sort((a, b) => a.name.localeCompare(b.name));

  await getAdminStore().setJson(INDEXING_PROFILE_AREA, DEFAULT_KEY, updatedProfiles, {
    actor,
    action: existing ? 'indexing-profile.update' : 'indexing-profile.create',
    entityType: INDEXING_PROFILE_AREA,
  });

  return profile;
}

export async function applyIndexingProfileToReindexRequest(
  input: StartReindexRequest
): Promise<StartReindexRequest> {
  const rag = await getRagAdminConfig();
  if (!input.profileId) {
    return {
      ...input,
      chunkingPolicy: input.chunkingPolicy ?? rag.chunkingPolicy,
    };
  }
  const profile = (await getIndexingProfiles()).find((item) => item.id === input.profileId);
  if (!profile) {
    throw new Error(`Indexing profile not found: ${input.profileId}`);
  }
  if (!profile.enabled) {
    throw new Error(`Indexing profile is disabled: ${profile.name}`);
  }

  const attachmentsEnabled = input.attachmentsEnabled ?? profile.attachmentsEnabled;
  const semanticFactsEnabled = input.semanticFactsEnabled ?? profile.semanticFactsEnabled;
  const smwProperties = semanticFactsEnabled ? await getIndexedSmwProperties() : [];
  const indexTargets = syncAttachmentIndexTarget(input.indexTargets ?? profile.indexTargets, attachmentsEnabled);

  return {
    profileId: profile.id,
    indexTargets,
    source: input.source,
    colbertModel: input.colbertModel,
    colbertCollection: input.colbertCollection,
    attachmentsEnabled,
    semanticFactsEnabled,
    smwProperties,
    namespaces: input.namespaces ?? profile.namespaces,
    namespaceAcl: profile.namespaceAcl,
    titleFilters: profile.titleFilters,
    categoryFilters: profile.categoryFilters,
    documentPolicyId: profile.documentPolicyId,
    maxPages: input.maxPages ?? profile.maxPagesDefault,
    chunkSize: profile.chunkSize,
    chunkOverlap: profile.chunkOverlap,
    chunkSeparators: profile.chunkSeparators,
    chunkingPolicy: input.chunkingPolicy ?? rag.chunkingPolicy,
    dryRun: input.dryRun ?? profile.dryRunDefault,
    llmEnrichmentEnabled: input.llmEnrichmentEnabled,
    llmEnrichmentModel: input.llmEnrichmentModel,
    llmEnrichmentMaxChars: input.llmEnrichmentMaxChars,
  };
}

function mergePartial<T extends object>(base: T, patch: DeepPartial<T>): T {
  return { ...base, ...patch } as T;
}

function normalizeRuntimeLimit(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

function withRetrievalLimitAliases(configInput: DeepPartial<RagAdminConfig>): DeepPartial<RagAdminConfig> {
  const configValue = configInput as DeepPartial<RagAdminConfig>;
  const retrievalTopK = configValue.retrievalTopK ?? configValue.topK;
  const contextTopK = configValue.contextTopK ?? configValue.maxContextChunks ?? retrievalTopK;
  const contextMaxChars = configValue.contextMaxChars ?? configValue.maxContextChars;
  return {
    ...configValue,
    ...(retrievalTopK === undefined ? {} : {
      retrievalTopK,
      topK: configValue.topK ?? retrievalTopK,
    }),
    ...(contextTopK === undefined ? {} : {
      contextTopK,
      maxContextChunks: configValue.maxContextChunks ?? contextTopK,
    }),
    ...(contextMaxChars === undefined ? {} : {
      contextMaxChars,
      maxContextChars: configValue.maxContextChars ?? contextMaxChars,
    }),
  };
}

export function getEffectiveRetrievalTopK(configValue: RagAdminConfig, fallback: number): number {
  return normalizeRuntimeLimit(configValue.retrievalTopK ?? configValue.topK, fallback, 1, 20);
}

export function getEffectiveContextTopK(configValue: RagAdminConfig, fallback: number): number {
  return normalizeRuntimeLimit(
    configValue.contextTopK ?? configValue.maxContextChunks ?? configValue.retrievalTopK ?? configValue.topK,
    fallback,
    1,
    50
  );
}

export function getEffectiveContextMaxChars(configValue: RagAdminConfig, fallback = 12000): number {
  return normalizeRuntimeLimit(configValue.contextMaxChars ?? configValue.maxContextChars, fallback, 1000, 200000);
}

const DEFAULT_CHUNK_SEPARATORS = ['\n## ', '\n### ', '\n\n', '\n', '. ', ' '];

function defaultChunkingPolicy(runtime: RuntimeConfig): ChunkingPolicy {
  return {
    defaults: {
      chunkSize: runtime.chunkSize,
      chunkOverlap: runtime.chunkOverlap,
      chunkSeparators: DEFAULT_CHUNK_SEPARATORS,
    },
    sources: {
      wiki_page: {
        chunkSize: 800,
        chunkOverlap: 120,
        chunkSeparators: DEFAULT_CHUNK_SEPARATORS,
      },
      attachment_text: {
        chunkSize: 1200,
        chunkOverlap: 180,
        chunkSeparators: ['\n\n', '\n', '. ', ' '],
      },
      attachment_metadata: {
        chunkSize: 512,
        chunkOverlap: 0,
        chunkSeparators: ['\n\n', '\n', '. ', ' '],
      },
      cmdb_dynamic_snapshot: {
        chunkSize: 900,
        chunkOverlap: 120,
        chunkSeparators: ['\n\n', '\n', '. ', ' '],
      },
    },
    namespaceOverrides: {},
  };
}

export async function getRagAdminConfig(): Promise<RagAdminConfig> {
  const runtime = await getRuntimeConfig();
  const defaults: RagAdminConfig = {
    chunkSize: runtime.chunkSize,
    chunkOverlap: runtime.chunkOverlap,
    chunkSeparators: DEFAULT_CHUNK_SEPARATORS,
    chunkingPolicy: defaultChunkingPolicy(runtime),
    minChunkLength: 40,
    maxChunksPerPage: 500,
    retrievalTopK: runtime.topK,
    contextTopK: runtime.topK,
    contextMaxChars: 12000,
    chatRetrievalQueryMode: 'current_message',
    topK: runtime.topK,
    maxContextChunks: runtime.topK,
    maxContextChars: 12000,
    minSearchScore: 0,
    searchMode: 'hybrid',
    rerankMode: 'none',
    vectorWeight: 0.65,
    lexicalWeight: 0.35,
    lexicalBackend: 'sqlite_fts',
    vectorCandidateLimit: 50,
    lexicalCandidateLimit: 50,
    lexicalMinMatchedTerms: 2,
    lexicalGateMode: 'when_bm25_available',
    lexicalNormalizationMode: 'simple_stem',
    lexicalSynonymsEnabled: false,
    lexicalSynonyms: [],
    lexicalTransliterationEnabled: false,
    lexicalEditDistanceEnabled: false,
    trigramIndexEnabled: false,
    trigramCandidateLimit: 50,
    trigramMinQueryLength: 4,
    vectorOnlyFallbackEnabled: true,
    vectorOnlyFallbackMinScore: 0.78,
    minFinalScore: 0,
    showRawScores: false,
    colbertEnabled: false,
    colbertBaseUrl: config.colbertBaseUrl,
    colbertModel: config.colbertModel,
    colbertCollection: config.colbertCollection,
    colbertCandidateLimit: 50,
    colbertTimeoutMs: 5000,
    colbertMinScore: 0,
    colbertTailDropEnabled: false,
    colbertTailMaxGap: 0.2,
    colbertTailMinScore: 0.7,
    colbertTailMinKeep: 1,
    colbertFailMode: 'fallback_current',
    semanticFactsInContext: true,
    includeAttachments: true,
    includeSemanticHeader: true,
  };
  const stored = (await getAdminStore().getJson<DeepPartial<RagAdminConfig>>(RAG_CONFIG_AREA, DEFAULT_KEY)) ?? {};
  return ragConfigSchema.parse(withRetrievalLimitAliases(mergePartial(defaults, stored)));
}

export async function previewRagAdminConfig(input: unknown): Promise<RagAdminConfig> {
  const patch = withRetrievalLimitAliases(ragConfigUpdateSchema.parse(input ?? {}));
  const current = await getRagAdminConfig();
  return ragConfigSchema.parse(withRetrievalLimitAliases({ ...current, ...patch }));
}

export async function setRagAdminConfig(input: unknown, actor?: string): Promise<RagAdminConfig> {
  const updated = await previewRagAdminConfig(input);
  if (updated.trigramIndexEnabled) {
    const status = await getSearchIndexStatus();
    if (!status.trigramPopulated) {
      throw new Error(
        'trigram_index_not_ready: run trigram backfill and wait for 100% index coverage before enabling trigramIndexEnabled'
      );
    }
  }

  await getAdminStore().setJson(RAG_CONFIG_AREA, DEFAULT_KEY, updated, {
    actor,
    action: 'rag-config.update',
    entityType: RAG_CONFIG_AREA,
  });

  await setRuntimeConfig({
    topK: updated.retrievalTopK,
    chunkSize: updated.chunkSize,
    chunkOverlap: updated.chunkOverlap,
  });

  return updated;
}

function retrievalProfileConfigFromRag(
  rag: RagAdminConfig,
  overrides: Partial<RetrievalProfileOverrides> = {}
): RetrievalProfileOverrides {
  const retrievalTopK = overrides.retrievalTopK ?? overrides.topK ?? rag.retrievalTopK ?? rag.topK;
  const contextTopK = overrides.contextTopK
    ?? overrides.maxContextChunks
    ?? rag.contextTopK
    ?? rag.maxContextChunks
    ?? retrievalTopK;
  const contextMaxChars = overrides.contextMaxChars
    ?? overrides.maxContextChars
    ?? rag.contextMaxChars
    ?? rag.maxContextChars;
  return retrievalProfileConfigSchema.parse(withRetrievalLimitAliases({
    retrievalTopK,
    contextTopK,
    contextMaxChars,
    chatRetrievalQueryMode: overrides.chatRetrievalQueryMode ?? rag.chatRetrievalQueryMode,
    topK: overrides.topK ?? retrievalTopK,
    maxContextChunks: overrides.maxContextChunks ?? contextTopK,
    maxContextChars: overrides.maxContextChars ?? contextMaxChars,
    searchMode: rag.searchMode,
    rerankMode: rag.rerankMode,
    vectorWeight: rag.vectorWeight,
    lexicalWeight: rag.lexicalWeight,
    lexicalBackend: rag.lexicalBackend,
    vectorCandidateLimit: rag.vectorCandidateLimit,
    lexicalCandidateLimit: rag.lexicalCandidateLimit,
    lexicalMinMatchedTerms: rag.lexicalMinMatchedTerms,
    lexicalGateMode: rag.lexicalGateMode,
    lexicalNormalizationMode: rag.lexicalNormalizationMode,
    lexicalSynonymsEnabled: rag.lexicalSynonymsEnabled,
    lexicalSynonyms: rag.lexicalSynonyms,
    lexicalTransliterationEnabled: rag.lexicalTransliterationEnabled,
    lexicalEditDistanceEnabled: rag.lexicalEditDistanceEnabled,
    trigramIndexEnabled: rag.trigramIndexEnabled,
    trigramCandidateLimit: rag.trigramCandidateLimit,
    trigramMinQueryLength: rag.trigramMinQueryLength,
    vectorOnlyFallbackEnabled: rag.vectorOnlyFallbackEnabled,
    vectorOnlyFallbackMinScore: rag.vectorOnlyFallbackMinScore,
    minFinalScore: rag.minFinalScore,
    showRawScores: rag.showRawScores,
    colbertEnabled: rag.colbertEnabled,
    colbertCandidateLimit: rag.colbertCandidateLimit,
    colbertTimeoutMs: rag.colbertTimeoutMs,
    colbertMinScore: rag.colbertMinScore,
    colbertTailDropEnabled: rag.colbertTailDropEnabled,
    colbertTailMaxGap: rag.colbertTailMaxGap,
    colbertTailMinScore: rag.colbertTailMinScore,
    colbertTailMinKeep: rag.colbertTailMinKeep,
    colbertFailMode: rag.colbertFailMode,
    semanticFactsInContext: rag.semanticFactsInContext,
    includeAttachments: rag.includeAttachments,
    includeSemanticHeader: rag.includeSemanticHeader,
    ...overrides,
  }));
}

export async function getDefaultRetrievalProfiles(): Promise<RetrievalProfile[]> {
  const rag = await getRagAdminConfig();
  const now = new Date().toISOString();
  const base = (id: string, name: string, description: string, overrides: Partial<RetrievalProfileOverrides>, tags: string[]): RetrievalProfile => ({
    id,
    name,
    description,
    enabled: true,
    apiEnabled: true,
    mcpEnabled: true,
    anonymousAllowed: false,
    maxTopK: 20,
    tags,
    chatProfileId: 'chat_current_session',
    config: retrievalProfileConfigFromRag(rag, overrides),
    createdAt: now,
    updatedAt: now,
  });

  return [
    base('current_hybrid', 'Current hybrid stack', 'Qdrant dense search plus the current SQLite/Postgres BM25 and optional trigram lexical layer.', {
      searchMode: 'hybrid',
      rerankMode: 'none',
      lexicalBackend: 'sqlite_fts',
      vectorWeight: 0.65,
      lexicalWeight: 0.35,
      lexicalGateMode: 'when_bm25_available',
      lexicalMinMatchedTerms: 2,
      colbertEnabled: false,
      colbertFailMode: 'fallback_current',
    }, ['current', 'qdrant', 'bm25']),
    base('current_hybrid_colbert', 'Current hybrid + ColBERT', 'Current Qdrant/BM25 stack with ColBERT rerank. Use when the production contour requires ColBERT.', {
      searchMode: 'hybrid_colbert',
      rerankMode: 'colbert_v2',
      lexicalBackend: 'sqlite_fts',
      vectorWeight: 0.65,
      lexicalWeight: 0.35,
      lexicalGateMode: 'when_bm25_available',
      lexicalMinMatchedTerms: 2,
      colbertEnabled: true,
      colbertFailMode: 'fail_search',
    }, ['current', 'hybrid', 'colbert']),
    base('opensearch_hybrid', 'OpenSearch hybrid stack', 'Qdrant dense search plus OpenSearch relevance layer for language analyzers, fuzzy matching and highlights.', {
      searchMode: 'hybrid',
      rerankMode: 'none',
      lexicalBackend: 'opensearch',
      vectorWeight: 0.55,
      lexicalWeight: 0.45,
      lexicalGateMode: 'when_bm25_available',
      lexicalMinMatchedTerms: 1,
      vectorOnlyFallbackEnabled: true,
      colbertEnabled: false,
      colbertFailMode: 'fallback_current',
    }, ['opensearch', 'hybrid']),
    base('opensearch_hybrid_colbert', 'OpenSearch hybrid + ColBERT', 'OpenSearch relevance layer with ColBERT rerank for production-grade expert retrieval.', {
      searchMode: 'hybrid_colbert',
      rerankMode: 'colbert_v2',
      lexicalBackend: 'opensearch',
      vectorWeight: 0.55,
      lexicalWeight: 0.45,
      lexicalGateMode: 'when_bm25_available',
      lexicalMinMatchedTerms: 1,
      colbertEnabled: true,
      colbertTimeoutMs: 12000,
      colbertMinScore: 0.58,
      colbertTailDropEnabled: true,
      colbertTailMaxGap: 0.2,
      colbertTailMinScore: 0.7,
      colbertTailMinKeep: 1,
      colbertFailMode: 'fail_search',
    }, ['opensearch', 'hybrid', 'colbert']),
    base('prod_hybrid_colbert', 'Production hybrid + ColBERT', 'BM25 gate, dense semantic search and ColBERT rerank for production-facing scenarios.', {
      searchMode: 'hybrid_colbert',
      rerankMode: 'colbert_v2',
      lexicalBackend: 'sqlite_fts',
      vectorWeight: 0.65,
      lexicalWeight: 0.35,
      lexicalGateMode: 'when_bm25_available',
      lexicalMinMatchedTerms: 2,
      colbertEnabled: true,
      colbertFailMode: 'fail_search',
    }, ['production', 'hybrid', 'colbert']),
    base('lexical_exact', 'Exact lexical / BM25', 'BM25-first profile for exact system names, terms, titles and instructions.', {
      searchMode: 'hybrid',
      rerankMode: 'none',
      lexicalBackend: 'sqlite_fts',
      vectorWeight: 0.25,
      lexicalWeight: 0.75,
      lexicalGateMode: 'when_bm25_available',
      lexicalMinMatchedTerms: 2,
      vectorOnlyFallbackEnabled: false,
      colbertEnabled: false,
      colbertFailMode: 'fallback_current',
    }, ['bm25', 'exact']),
    base('semantic_broad', 'Broad semantic hybrid', 'Dense-vector leaning profile for broad exploratory questions with BM25 as a weaker signal.', {
      searchMode: 'hybrid',
      rerankMode: 'none',
      lexicalBackend: 'sqlite_fts',
      vectorWeight: 0.8,
      lexicalWeight: 0.2,
      lexicalGateMode: 'off',
      lexicalMinMatchedTerms: 1,
      vectorOnlyFallbackEnabled: true,
      colbertEnabled: false,
      colbertFailMode: 'fallback_current',
    }, ['semantic', 'hybrid']),
    base('typo_tolerant_experimental', 'Typo tolerant experimental', 'BM25 profile with editDistance enabled; trigram can be enabled after trigram backfill readiness.', {
      searchMode: 'hybrid',
      rerankMode: 'none',
      lexicalBackend: 'sqlite_fts',
      vectorWeight: 0.45,
      lexicalWeight: 0.55,
      lexicalGateMode: 'when_bm25_available',
      lexicalEditDistanceEnabled: true,
      trigramIndexEnabled: rag.trigramIndexEnabled,
      colbertEnabled: false,
      colbertFailMode: 'fallback_current',
    }, ['experimental', 'typo']),
    base('colbert_full_strict', 'Strict ColBERT full search', 'ColBERT-first profile for expert comparison and late-interaction index checks.', {
      searchMode: 'colbert_full',
      rerankMode: 'none',
      lexicalBackend: 'sqlite_fts',
      colbertEnabled: true,
      colbertFailMode: 'fail_search',
      vectorOnlyFallbackEnabled: false,
    }, ['colbert', 'strict']),
  ];
}

function normalizeRetrievalProfile(profile: RetrievalProfile): RetrievalProfile {
  const configRecord = profile.config as unknown as Record<string, unknown>;
  const defaultTailDropEnabled = profile.id === 'opensearch_hybrid_colbert';
  return {
    ...profile,
    tags: profile.tags ?? [],
    chatProfileId: profile.chatProfileId,
    config: retrievalProfileConfigSchema.parse(withRetrievalLimitAliases({
      ...configRecord,
      chatRetrievalQueryMode: configRecord.chatRetrievalQueryMode ?? 'current_message',
      contextMaxChars: configRecord.contextMaxChars ?? configRecord.maxContextChars ?? 12000,
      maxContextChars: configRecord.maxContextChars ?? configRecord.contextMaxChars ?? 12000,
      lexicalBackend: typeof configRecord.lexicalBackend === 'string'
        ? configRecord.lexicalBackend
        : 'sqlite_fts',
      colbertTailDropEnabled: typeof configRecord.colbertTailDropEnabled === 'boolean'
        ? configRecord.colbertTailDropEnabled
        : defaultTailDropEnabled,
      colbertTailMaxGap: typeof configRecord.colbertTailMaxGap === 'number'
        ? configRecord.colbertTailMaxGap
        : 0.2,
      colbertTailMinScore: typeof configRecord.colbertTailMinScore === 'number'
        ? configRecord.colbertTailMinScore
        : 0.7,
      colbertTailMinKeep: typeof configRecord.colbertTailMinKeep === 'number'
        ? configRecord.colbertTailMinKeep
        : 1,
    } as DeepPartial<RagAdminConfig>)),
  };
}

export async function getRetrievalProfiles(): Promise<RetrievalProfile[]> {
  const stored = await getAdminStore().getJson<RetrievalProfile[]>(RETRIEVAL_PROFILE_AREA, DEFAULT_KEY);
  const defaults = await getDefaultRetrievalProfiles();
  if (!stored || stored.length === 0) return defaults;

  const normalizedStored = stored.map(normalizeRetrievalProfile);
  const storedIds = new Set(normalizedStored.map((profile) => profile.id));
  const missingDefaults = defaults.filter((profile) => !storedIds.has(profile.id));
  return [...normalizedStored, ...missingDefaults];
}

export async function upsertRetrievalProfile(input: unknown, actor?: string): Promise<RetrievalProfile> {
  const parsed = retrievalProfileInputSchema.parse(normalizeRetrievalProfileInput(input));
  const profiles = await getRetrievalProfiles();
  const now = new Date().toISOString();
  const id = parsed.id ?? profileIdFromName(parsed.name);
  const existing = profiles.find((profile) => profile.id === id);
  if (parsed.chatProfileId) {
    const chatProfiles = await getChatProfiles();
    if (!chatProfiles.some((profile) => profile.id === parsed.chatProfileId && profile.enabled)) {
      throw new Error(`Chat profile not found or disabled: ${parsed.chatProfileId}`);
    }
  }
  const profile: RetrievalProfile = {
    id,
    name: parsed.name,
    description: parsed.description ?? existing?.description ?? '',
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    apiEnabled: parsed.apiEnabled ?? existing?.apiEnabled ?? true,
    mcpEnabled: parsed.mcpEnabled ?? existing?.mcpEnabled ?? true,
    anonymousAllowed: parsed.anonymousAllowed ?? existing?.anonymousAllowed ?? false,
    maxTopK: parsed.maxTopK ?? existing?.maxTopK ?? 20,
    tags: parsed.tags ?? existing?.tags ?? [],
    chatProfileId: parsed.chatProfileId ?? existing?.chatProfileId,
    config: parsed.config,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const updatedProfiles = [
    ...profiles.filter((item) => item.id !== id),
    profile,
  ].sort((a, b) => a.name.localeCompare(b.name));

  await getAdminStore().setJson(RETRIEVAL_PROFILE_AREA, DEFAULT_KEY, updatedProfiles, {
    actor,
    action: existing ? 'retrieval-profile.update' : 'retrieval-profile.create',
    entityType: RETRIEVAL_PROFILE_AREA,
  });

  return profile;
}

export async function restoreDefaultRetrievalProfiles(actor?: string): Promise<RetrievalProfile[]> {
  const profiles = await getDefaultRetrievalProfiles();
  await getAdminStore().setJson(RETRIEVAL_PROFILE_AREA, DEFAULT_KEY, profiles, {
    actor,
    action: 'retrieval-profile.restore-defaults',
    entityType: RETRIEVAL_PROFILE_AREA,
  });
  return profiles;
}

export async function getWebhookAdminConfig(): Promise<WebhookAdminConfig> {
  const defaults: WebhookAdminConfig = {
    syncerUrl: config.syncerBaseUrl,
    events: {
      edit: true,
      delete: true,
      move: true,
      protect: true,
    },
    timeoutMs: 3000,
    retryCount: 0,
    retryBackoffMs: 1000,
  };
  const stored = (await getAdminStore().getJson<DeepPartial<WebhookAdminConfig>>(WEBHOOK_CONFIG_AREA, DEFAULT_KEY)) ?? {};
  return webhookConfigSchema.parse({
    ...defaults,
    ...stored,
    events: { ...defaults.events, ...stored.events },
  });
}

export async function setWebhookAdminConfig(input: unknown, actor?: string): Promise<WebhookAdminConfig> {
  const patch = webhookConfigUpdateSchema.parse(input);
  const current = await getWebhookAdminConfig();
  const updated = webhookConfigSchema.parse({
    ...current,
    ...patch,
    events: { ...current.events, ...patch.events },
  });

  await getAdminStore().setJson(WEBHOOK_CONFIG_AREA, DEFAULT_KEY, updated, {
    actor,
    action: 'webhook-config.update',
    entityType: WEBHOOK_CONFIG_AREA,
  });

  return updated;
}

const DEFAULT_CHAT_RETENTION_CONFIG: ChatRetentionConfig = {
  retentionMode: 'archive',
  activeDays: 7,
  recentDays: 7,
  archiveDays: 365,
  maxPinnedChats: 20,
  maxActiveChats: 200,
  maxTotalChats: 1000,
  onLimitExceeded: 'delete_oldest',
  exportOptions: {
    formats: ['json'],
    includeMetadata: true,
    includeSources: true,
    includeMessages: true,
  },
};

export async function getChatRetentionAdminConfig(): Promise<ChatRetentionConfig> {
  const stored = (await getAdminStore().getJson<DeepPartial<ChatRetentionConfig>>(
    CHAT_RETENTION_CONFIG_AREA,
    DEFAULT_KEY
  )) ?? {};

  return chatRetentionConfigSchema.parse({
    ...DEFAULT_CHAT_RETENTION_CONFIG,
    ...stored,
    exportOptions: {
      ...DEFAULT_CHAT_RETENTION_CONFIG.exportOptions,
      ...stored.exportOptions,
    },
  });
}

export async function setChatRetentionAdminConfig(input: unknown, actor?: string): Promise<ChatRetentionConfig> {
  const patch = chatRetentionConfigUpdateSchema.parse(input);
  const current = await getChatRetentionAdminConfig();
  const updated = chatRetentionConfigSchema.parse({
    ...current,
    ...patch,
    exportOptions: {
      ...current.exportOptions,
      ...patch.exportOptions,
    },
  });

  await getAdminStore().setJson(CHAT_RETENTION_CONFIG_AREA, DEFAULT_KEY, updated, {
    actor,
    action: 'chat-retention-config.update',
    entityType: CHAT_RETENTION_CONFIG_AREA,
  });

  return updated;
}

export function calculateChatRetentionRedisTtlSeconds(retention: ChatRetentionConfig): number {
  const days = retention.retentionMode === 'auto_delete' ? retention.activeDays : retention.archiveDays;
  return days * SECONDS_PER_DAY;
}

export async function getChatRetentionRedisTtlSeconds(): Promise<number> {
  return calculateChatRetentionRedisTtlSeconds(await getChatRetentionAdminConfig());
}

export async function getConflictDetectionConfig(): Promise<ConflictDetectionConfig> {
  const llm = await getEffectiveLlmConfig();
  const defaults: ConflictDetectionConfig = {
    enabled: true,
    runMode: 'risk_only',
    attachmentParentConflictMode: 'risk_only',
    model: llm.model,
    systemPrompt: DEFAULT_CONFLICT_DETECTION_SYSTEM_PROMPT,
    maxSources: 5,
    maxCharsPerSource: 2000,
    trustGapThreshold: 0.15,
    lowConfidenceThreshold: 0.7,
    showConflictBlock: true,
  };
  const stored = (await getAdminStore().getJson<DeepPartial<ConflictDetectionConfig>>(
    CONFLICT_DETECTION_CONFIG_AREA,
    DEFAULT_KEY
  )) ?? {};

  return conflictDetectionConfigSchema.parse({
    ...defaults,
    ...stored,
    model: stored.model ?? defaults.model,
    systemPrompt: stored.systemPrompt ?? defaults.systemPrompt,
  });
}

export async function setConflictDetectionConfig(
  input: unknown,
  actor?: string
): Promise<ConflictDetectionConfig> {
  const patch = conflictDetectionConfigUpdateSchema.parse(input);
  const current = await getConflictDetectionConfig();
  const updated = conflictDetectionConfigSchema.parse({ ...current, ...patch });

  await getAdminStore().setJson(CONFLICT_DETECTION_CONFIG_AREA, DEFAULT_KEY, updated, {
    actor,
    action: 'conflict-detection-config.update',
    entityType: CONFLICT_DETECTION_CONFIG_AREA,
  });

  return updated;
}

const DEFAULT_TRUST_RECALCULATION_CONFIG: TrustRecalculationConfig = {
  enabled: false,
  intervalMinutes: 1440,
  maxScan: 1000,
  batchSize: 128,
};

export async function getTrustRecalculationAdminConfig(): Promise<TrustRecalculationConfig> {
  const stored = (await getAdminStore().getJson<Partial<TrustRecalculationConfig>>(
    TRUST_RECALCULATION_CONFIG_AREA,
    DEFAULT_KEY
  )) ?? {};

  return trustRecalculationConfigSchema.parse({
    ...DEFAULT_TRUST_RECALCULATION_CONFIG,
    ...stored,
  });
}

export async function setTrustRecalculationAdminConfig(
  input: unknown,
  actor?: string
): Promise<TrustRecalculationConfig> {
  const patch = trustRecalculationConfigUpdateSchema.parse(input);
  const current = await getTrustRecalculationAdminConfig();
  const updated = trustRecalculationConfigSchema.parse({ ...current, ...patch });

  await getAdminStore().setJson(TRUST_RECALCULATION_CONFIG_AREA, DEFAULT_KEY, updated, {
    actor,
    action: 'trust-recalculation-config.update',
    entityType: TRUST_RECALCULATION_CONFIG_AREA,
  });

  return updated;
}

function normalizeStalenessPenaltyPerYear(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_STALENESS_PENALTY_PER_YEAR;
}

function normalizeTrustModel(model: TrustModel): TrustModel {
  return {
    ...model,
    stalenessPenaltyPerYear: normalizeStalenessPenaltyPerYear(model.stalenessPenaltyPerYear),
  };
}

async function getTrustStore(): Promise<TrustStore> {
  const stored = await getAdminStore().getJson<TrustStore>(TRUST_STORE_AREA, DEFAULT_KEY);
  if (stored) {
    return {
      models: (stored.models ?? []).map(normalizeTrustModel),
      entities: stored.entities ?? [],
      rules: stored.rules ?? [],
    };
  }

  const now = new Date().toISOString();
  return {
    models: [{
      id: 'default',
      name: 'Default trust model',
      active: true,
      baseScore: 0.7,
      minTrustScoreForContext: 0.4,
      includeDrafts: false,
      includeOutdated: false,
      stalenessPenaltyPerYear: DEFAULT_STALENESS_PENALTY_PER_YEAR,
      requireVerifiedForDirectAnswer: true,
      requireSources: true,
      createdAt: now,
      updatedAt: now,
    }],
    entities: [],
    rules: [],
  };
}

async function saveTrustStore(store: TrustStore, actor: string | undefined, action: string): Promise<void> {
  await getAdminStore().setJson(TRUST_STORE_AREA, DEFAULT_KEY, store, {
    actor,
    action,
    entityType: TRUST_STORE_AREA,
  });
}

function normalizePropertyValues(values: Record<string, unknown> | undefined): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (Array.isArray(value)) {
      normalized[key] = value.map((item) => String(item)).filter((item) => item.length > 0);
    } else if (value !== undefined && value !== null) {
      normalized[key] = [String(value)];
    }
  }
  return normalized;
}

function clampTrustScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function roundTrustDelta(value: number): number {
  return Number(value.toFixed(4));
}

function fullAgeYearsFromLastModified(lastModified: string | undefined, now = new Date()): number | undefined {
  if (!lastModified) return undefined;
  const modifiedAt = new Date(lastModified);
  if (Number.isNaN(modifiedAt.getTime())) return undefined;
  if (modifiedAt.getTime() > now.getTime()) return 0;

  let years = now.getUTCFullYear() - modifiedAt.getUTCFullYear();
  const anniversaryThisYear = Date.UTC(
    now.getUTCFullYear(),
    modifiedAt.getUTCMonth(),
    modifiedAt.getUTCDate(),
    modifiedAt.getUTCHours(),
    modifiedAt.getUTCMinutes(),
    modifiedAt.getUTCSeconds(),
    modifiedAt.getUTCMilliseconds()
  );
  if (now.getTime() < anniversaryThisYear) years--;
  return Math.max(0, years);
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function stringMatches(values: string[], expected: string, operator: TrustConditionOperator): boolean {
  const needle = normalizedText(expected);
  if (operator === 'exists') return values.length > 0;
  if (!needle) return false;

  return values.some((value) => {
    const text = normalizedText(value);
    if (operator === 'equals') return text === needle;
    if (operator === 'contains') return text.includes(needle);
    if (operator === 'starts_with') return text.startsWith(needle);
    return false;
  });
}

function readPreviewField(input: TrustPreviewInput, field: TrustConditionField, propertyName?: string): string[] {
  if (field === 'namespace') return [String(input.namespace)];
  if (field === 'title') return [input.title];
  if (field === 'category') return input.categories;
  if (field === 'tag') return input.tags;
  if (field === 'author_group') return input.authorGroups;
  if (field === 'template') return input.templates;
  if (field === 'property' || field === 'status' || field === 'date_property') {
    const key = propertyName || (field === 'status' ? 'Статус документа' : undefined);
    return key ? input.properties[key] ?? [] : [];
  }
  return [];
}

function evaluateDateCondition(values: string[], operator: TrustConditionOperator, expected?: string): boolean {
  if (operator !== 'older_than_days' && operator !== 'newer_than_days') return false;
  const days = expected ? Number(expected) : Number.NaN;
  if (!Number.isFinite(days) || days < 0) return false;
  const thresholdMs = days * SECONDS_PER_DAY * 1000;
  const now = Date.now();

  return values.some((value) => {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return false;
    const ageMs = now - parsed;
    return operator === 'older_than_days' ? ageMs > thresholdMs : ageMs <= thresholdMs;
  });
}

function entityMatchesPreview(entity: TrustEntity, input: TrustPreviewInput): boolean {
  if (!entity.enabled) return false;
  const expected = entity.value;
  if (entity.entityType === 'namespace') return String(input.namespace) === expected;
  if (entity.entityType === 'category') return stringMatches(input.categories, expected, 'equals');
  if (entity.entityType === 'tag') return stringMatches(input.tags, expected, 'equals');
  if (entity.entityType === 'author_group') return stringMatches(input.authorGroups, expected, 'equals');
  if (entity.entityType === 'template') return stringMatches(input.templates, expected, 'equals');
  if (entity.entityType === 'page_property' || entity.entityType === 'smw_property' || entity.entityType === 'date_property') {
    const [propertyName, propertyValue] = expected.includes('=')
      ? expected.split(/=(.*)/s).filter(Boolean)
      : [expected, undefined];
    const values = input.properties[propertyName] ?? [];
    return propertyValue ? stringMatches(values, propertyValue, 'equals') : values.length > 0;
  }
  return false;
}

function ruleMatchesPreview(rule: TrustRule, input: TrustPreviewInput): boolean {
  if (!rule.enabled) return false;
  const values = readPreviewField(input, rule.condition.field, rule.condition.propertyName);
  if (rule.condition.operator === 'older_than_days' || rule.condition.operator === 'newer_than_days') {
    return evaluateDateCondition(values, rule.condition.operator, rule.condition.value);
  }
  return stringMatches(values, rule.condition.value ?? '', rule.condition.operator);
}

function getTrustModelOrThrow(store: TrustStore, modelId: string): TrustModel {
  const model = store.models.find((item) => item.id === modelId);
  if (!model) throw new Error(`Trust model not found: ${modelId}`);
  return model;
}

export async function getTrustModels(): Promise<TrustModel[]> {
  return (await getTrustStore()).models;
}

export async function upsertTrustModel(input: unknown, actor?: string): Promise<TrustModel> {
  const parsed = trustModelInputSchema.parse(input);
  const store = await getTrustStore();
  const now = new Date().toISOString();
  const existing = parsed.id ? store.models.find((model) => model.id === parsed.id) : undefined;
  const id = parsed.id ?? idFromName(parsed.name);

  const model: TrustModel = {
    id,
    name: parsed.name,
    active: parsed.active ?? existing?.active ?? store.models.length === 0,
    baseScore: parsed.baseScore ?? existing?.baseScore ?? 0.7,
    minTrustScoreForContext: parsed.minTrustScoreForContext ?? existing?.minTrustScoreForContext ?? 0.4,
    includeDrafts: parsed.includeDrafts ?? existing?.includeDrafts ?? false,
    includeOutdated: parsed.includeOutdated ?? existing?.includeOutdated ?? false,
    stalenessPenaltyPerYear: parsed.stalenessPenaltyPerYear
      ?? existing?.stalenessPenaltyPerYear
      ?? DEFAULT_STALENESS_PENALTY_PER_YEAR,
    requireVerifiedForDirectAnswer: parsed.requireVerifiedForDirectAnswer ?? existing?.requireVerifiedForDirectAnswer ?? true,
    requireSources: parsed.requireSources ?? existing?.requireSources ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const models = [
    ...store.models.filter((item) => item.id !== id),
    model,
  ]
    .map((item) => (model.active ? { ...item, active: item.id === id } : item))
    .sort((a, b) => a.name.localeCompare(b.name));

  await saveTrustStore({ ...store, models }, actor, existing ? 'trust-model.update' : 'trust-model.create');
  return model;
}

export async function getTrustEntities(modelId: string): Promise<TrustEntity[]> {
  const store = await getTrustStore();
  getTrustModelOrThrow(store, modelId);
  return store.entities
    .filter((entity) => entity.modelId === modelId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertTrustEntity(modelId: string, input: unknown, actor?: string): Promise<TrustEntity> {
  const parsed = trustEntityInputSchema.parse(input);
  const store = await getTrustStore();
  getTrustModelOrThrow(store, modelId);
  const now = new Date().toISOString();
  const existing = parsed.id
    ? store.entities.find((entity) => entity.modelId === modelId && entity.id === parsed.id)
    : undefined;
  const id = parsed.id ?? idFromName(parsed.name);

  const entity: TrustEntity = {
    id,
    modelId,
    entityType: parsed.entityType,
    name: parsed.name,
    value: parsed.value,
    weight: parsed.weight ?? existing?.weight ?? 0,
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const entities = [
    ...store.entities.filter((item) => !(item.modelId === modelId && item.id === id)),
    entity,
  ].sort((a, b) => a.name.localeCompare(b.name));

  await saveTrustStore({ ...store, entities }, actor, existing ? 'trust-entity.update' : 'trust-entity.create');
  return entity;
}

export interface DeleteTrustEntityResult {
  deletedEntityId: string;
  deletedRuleCount: number;
}

export async function deleteTrustEntity(
  modelId: string,
  entityId: string,
  actor?: string
): Promise<DeleteTrustEntityResult> {
  const store = await getTrustStore();
  getTrustModelOrThrow(store, modelId);
  const entity = store.entities.find((item) => item.modelId === modelId && item.id === entityId);
  if (!entity) throw new Error(`Trust entity not found: ${entityId}`);

  const rules = store.rules.filter((rule) => rule.modelId === modelId && rule.entityId === entityId);
  const updatedStore: TrustStore = {
    ...store,
    entities: store.entities.filter((item) => !(item.modelId === modelId && item.id === entityId)),
    rules: store.rules.filter((rule) => !(rule.modelId === modelId && rule.entityId === entityId)),
  };

  await saveTrustStore(updatedStore, actor, 'trust-entity.delete');
  return {
    deletedEntityId: entity.id,
    deletedRuleCount: rules.length,
  };
}

export async function getTrustRules(modelId: string, entityId?: string): Promise<TrustRule[]> {
  const store = await getTrustStore();
  getTrustModelOrThrow(store, modelId);
  if (entityId && !store.entities.some((entity) => entity.modelId === modelId && entity.id === entityId)) {
    throw new Error(`Trust entity not found: ${entityId}`);
  }
  return store.rules
    .filter((rule) => rule.modelId === modelId && (!entityId || rule.entityId === entityId))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
}

export async function upsertTrustRule(
  modelId: string,
  entityId: string | undefined,
  input: unknown,
  actor?: string
): Promise<TrustRule> {
  const parsed = trustRuleInputSchema.parse(input);
  const store = await getTrustStore();
  getTrustModelOrThrow(store, modelId);
  const effectiveEntityId = parsed.entityId ?? entityId;
  if (effectiveEntityId && !store.entities.some((entity) => entity.modelId === modelId && entity.id === effectiveEntityId)) {
    throw new Error(`Trust entity not found: ${effectiveEntityId}`);
  }
  const now = new Date().toISOString();
  const existing = parsed.id
    ? store.rules.find((rule) => rule.modelId === modelId && rule.id === parsed.id)
    : undefined;
  const id = parsed.id ?? idFromName(parsed.name);

  const rule: TrustRule = {
    id,
    modelId,
    entityId: effectiveEntityId,
    name: parsed.name,
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    condition: parsed.condition,
    modifier: parsed.modifier ?? existing?.modifier ?? 0,
    flags: parsed.flags ?? existing?.flags ?? [],
    excludeFromIndex: parsed.excludeFromIndex ?? existing?.excludeFromIndex ?? false,
    requireManualApproval: parsed.requireManualApproval ?? existing?.requireManualApproval ?? false,
    notifyAuthor: parsed.notifyAuthor ?? existing?.notifyAuthor ?? false,
    displayOrder: parsed.displayOrder ?? existing?.displayOrder ?? 100,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const rules = [
    ...store.rules.filter((item) => !(item.modelId === modelId && item.id === id)),
    rule,
  ].sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));

  await saveTrustStore({ ...store, rules }, actor, existing ? 'trust-rule.update' : 'trust-rule.create');
  return rule;
}

export interface DeleteTrustRuleResult {
  deletedRuleId: string;
}

export async function deleteTrustRule(
  modelId: string,
  entityId: string | undefined,
  ruleId: string,
  actor?: string
): Promise<DeleteTrustRuleResult> {
  const store = await getTrustStore();
  getTrustModelOrThrow(store, modelId);
  if (entityId && !store.entities.some((entity) => entity.modelId === modelId && entity.id === entityId)) {
    throw new Error(`Trust entity not found: ${entityId}`);
  }
  const rule = store.rules.find(
    (item) => item.modelId === modelId && (!entityId || item.entityId === entityId) && item.id === ruleId
  );
  if (!rule) throw new Error(`Trust rule not found: ${ruleId}`);

  await saveTrustStore({
    ...store,
    rules: store.rules.filter(
      (item) => !(item.modelId === modelId && (!entityId || item.entityId === entityId) && item.id === ruleId)
    ),
  }, actor, 'trust-rule.delete');

  return { deletedRuleId: rule.id };
}

export async function previewTrustModel(modelId: string, input: unknown): Promise<TrustPreviewResult> {
  const parsed = trustPreviewInputSchema.parse(input);
  const previewInput: TrustPreviewInput = {
    pageId: parsed.pageId,
    title: parsed.title,
    namespace: parsed.namespace,
    categories: parsed.categories ?? [],
    tags: parsed.tags ?? [],
    authorGroups: parsed.authorGroups ?? [],
    templates: parsed.templates ?? [],
    lastModified: parsed.lastModified,
    properties: normalizePropertyValues(parsed.properties),
  };
  const store = await getTrustStore();
  const model = getTrustModelOrThrow(store, modelId);
  const modelEntities = store.entities.filter((entity) => entity.modelId === modelId);
  const modelRules = store.rules.filter((rule) => rule.modelId === modelId);
  const appliedEntities = modelEntities.filter((entity) => entityMatchesPreview(entity, previewInput));
  const appliedRules = modelRules.filter((rule) => ruleMatchesPreview(rule, previewInput));
  const entityScoreDelta = appliedEntities.reduce((sum, entity) => sum + entity.weight, 0);
  const ruleScoreDelta = appliedRules.reduce((sum, rule) => sum + rule.modifier, 0);
  const ageYears = fullAgeYearsFromLastModified(previewInput.lastModified);
  const stalenessPenalty = roundTrustDelta((ageYears ?? 0) * model.stalenessPenaltyPerYear);
  const score = clampTrustScore(model.baseScore + entityScoreDelta + ruleScoreDelta - stalenessPenalty);
  const flags = Array.from(new Set(appliedRules.flatMap((rule) => rule.flags))).sort();
  const excludeFromIndex = appliedRules.some((rule) => rule.excludeFromIndex);
  const requireManualApproval = appliedRules.some((rule) => rule.requireManualApproval);
  const notifyAuthor = appliedRules.some((rule) => rule.notifyAuthor);
  const statusValues = previewInput.properties['Статус документа'] ?? previewInput.properties.status ?? [];
  const isDraft = stringMatches(statusValues, 'draft', 'equals') || stringMatches(statusValues, 'черновик', 'equals');

  return {
    modelId: model.id,
    score,
    baseScore: model.baseScore,
    entityScoreDelta: roundTrustDelta(entityScoreDelta),
    ruleScoreDelta: roundTrustDelta(ruleScoreDelta),
    lastModified: previewInput.lastModified,
    ageYears,
    stalenessPenalty,
    flags,
    appliedEntities: appliedEntities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
      value: entity.value,
      weight: entity.weight,
    })),
    appliedRules: appliedRules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      modifier: rule.modifier,
      flags: rule.flags,
      excludeFromIndex: rule.excludeFromIndex,
      requireManualApproval: rule.requireManualApproval,
      notifyAuthor: rule.notifyAuthor,
    })),
    decisions: {
      includeInContext: !excludeFromIndex
        && score >= model.minTrustScoreForContext
        && (model.includeDrafts || !isDraft),
      allowDirectAnswer: !model.requireVerifiedForDirectAnswer || score >= model.minTrustScoreForContext,
      excludeFromIndex,
      requireManualApproval,
      notifyAuthor,
      requireSources: model.requireSources,
    },
  };
}

async function testHttpGet(url: string, timeoutMs: number): Promise<HttpTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return {
      status: response.ok ? 'ok' : 'error',
      url,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: 'error',
      url,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'Unknown HTTP diagnostics error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testWebhookAdminConfig(actor?: string): Promise<WebhookAdminConfig> {
  const webhook = await getWebhookAdminConfig();
  const healthUrl = new URL('/health', webhook.syncerUrl).toString();
  const lastStatus = await testHttpGet(healthUrl, webhook.timeoutMs);
  const updated = { ...webhook, lastStatus };

  await getAdminStore().setJson(WEBHOOK_CONFIG_AREA, DEFAULT_KEY, updated, {
    actor,
    action: 'webhook-config.test',
    entityType: WEBHOOK_CONFIG_AREA,
  });

  return updated;
}

export async function testLlmAdminConfig(): Promise<HttpTestResult> {
  const llm = await getEffectiveLlmConfig();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llm.timeoutMs);
  const url = buildServiceUrl(llm.baseUrl, 'chat/completions');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: 'Reply with OK.' },
          { role: 'user', content: 'healthcheck' },
        ],
        stream: false,
        temperature: 0,
        max_tokens: 8,
      }),
      signal: controller.signal,
    });

    return {
      status: response.ok ? 'ok' : 'error',
      url,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: 'error',
      url,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'Unknown LLM diagnostics error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testEmbeddingAdminConfig(actor?: string): Promise<EmbeddingAdminConfig> {
  const embedding = await getEffectiveEmbeddingConfig();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const isOpenAiCompatible = embedding.provider === 'openai_compatible';
  const url = buildServiceUrl(embedding.baseUrl, isOpenAiCompatible ? 'embeddings' : 'api/embeddings');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isOpenAiCompatible && embedding.apiKey) {
    headers.Authorization = `Bearer ${embedding.apiKey}`;
  }

  let lastTest: EmbeddingTestResult;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(isOpenAiCompatible
        ? { model: embedding.model, input: 'embedding healthcheck', dimensions: embedding.dimensions }
        : { model: embedding.model, prompt: 'embedding healthcheck' }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({})) as {
      embedding?: unknown;
      data?: Array<{ embedding?: unknown }>;
    };
    const rawVector = isOpenAiCompatible ? body.data?.[0]?.embedding : body.embedding;
    const vector = Array.isArray(rawVector) ? rawVector : undefined;
    lastTest = {
      status: response.ok && vector ? 'ok' : 'error',
      url,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      dimension: vector?.length,
    };
  } catch (err) {
    lastTest = {
      status: 'error',
      url,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'Unknown embedding diagnostics error',
    };
  } finally {
    clearTimeout(timeout);
  }

  const updated = {
    provider: embedding.provider,
    baseUrl: embedding.baseUrl,
    model: embedding.model,
    dimensions: embedding.dimensions,
    apiKeyConfigured: isOpenAiCompatible ? Boolean(embedding.apiKey) : false,
    lastTest,
  };

  await getAdminStore().setJson('embedding-config', DEFAULT_KEY, updated, {
    actor,
    action: 'embedding-config.test',
    entityType: 'embedding-config',
  });

  return updated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNumberField(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readQdrantVectorSize(collection: unknown): number | undefined {
  if (!isRecord(collection) || !isRecord(collection.config)) return undefined;
  const { params } = collection.config;
  if (!isRecord(params) || !isRecord(params.vectors)) return undefined;
  return readNumberField(params.vectors, 'size');
}

async function testQdrantAdminConfig(service: ServiceAdminConfig): Promise<QdrantAdminDiagnostics> {
  try {
    const collection = await qdrant.getCollection(service.qdrant.collection);
    const vectorSize = readQdrantVectorSize(collection);
    const collectionRecord = isRecord(collection) ? collection : {};
    return {
      status: vectorSize === QDRANT_VECTOR_SIZE ? 'ok' : 'error',
      url: service.qdrant.url,
      collection: service.qdrant.collection,
      expectedVectorSize: QDRANT_VECTOR_SIZE,
      vectorSize,
      vectorSizeCompatible: vectorSize === QDRANT_VECTOR_SIZE,
      pointsCount: readNumberField(collectionRecord, 'points_count'),
      indexedVectorsCount: readNumberField(collectionRecord, 'indexed_vectors_count'),
    };
  } catch (err) {
    return {
      status: 'error',
      url: service.qdrant.url,
      collection: service.qdrant.collection,
      expectedVectorSize: QDRANT_VECTOR_SIZE,
      error: err instanceof Error ? err.message : 'Unknown Qdrant diagnostics error',
    };
  }
}

export async function testServiceAdminConfig(): Promise<{
  syncer: HttpTestResult;
  mediaWikiServiceAuth: SyncerMediaWikiServiceLoginTestResult;
  database: { dialect: string; url: string };
  qdrant: QdrantAdminDiagnostics;
}> {
  const service = await getServiceAdminConfig();
  const syncerUrl = new URL('/health', service.values.syncer.baseUrl).toString();
  const [syncer, qdrantDiagnostics, mediaWikiServiceAuth] = await Promise.all([
    testHttpGet(syncerUrl, service.values.llm.timeoutMs),
    testQdrantAdminConfig(service.values),
    testSyncerMediaWikiServiceAuth(service.values.syncer.baseUrl).catch((err: unknown) => ({
      status: 'error' as const,
      auth: service.values.syncer.mediaWikiServiceAuth,
      error: err instanceof Error ? err.message : 'Unable to test Syncer MediaWiki auth',
    })),
  ]);

  return {
    syncer,
    mediaWikiServiceAuth,
    database: {
      dialect: service.values.database.dialect,
      url: service.values.database.url,
    },
    qdrant: qdrantDiagnostics,
  };
}

export async function listAdminAuditLog(limit?: number): Promise<AuditLogEntry[]> {
  return getAdminStore().listAuditLog(limit);
}
