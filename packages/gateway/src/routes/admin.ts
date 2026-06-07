import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getAdminStore } from '../db/admin-store.js';
import { mwAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getRuntimeConfig, setRuntimeConfig, resetRuntimeConfig, RuntimeConfig } from '../services/config.js';
import { getHealthStatus } from './health.js';
import {
  getDocumentProcessingConfig,
  resetDocumentProcessingConfig,
  setDocumentProcessingConfig,
} from '../services/document-processing.js';
import { getSemanticStatus, searchSemanticFacts } from '../services/semantic-diagnostics.js';
import {
  classifyOntologyFragment,
  clusterizeOntologyProperties,
  deleteOntologyProperty,
  generateOntologyVector,
  getOntologyProperties,
  getOntologySimilarities,
  upsertOntologyProperty,
} from '../services/ontology-vectors.js';
import { getIndexedSmwProperties } from '../services/smw-indexing-properties.js';
import {
  evaluateSemanticAutofill,
  getSemanticAutofillConfig,
  getSemanticAutofillStatus,
  recordSemanticAutofillApplied,
  resetSemanticAutofillOwnership,
  setSemanticAutofillConfig,
} from '../services/semantic-autofill.js';
import {
  getSyncerReindexStatus,
  isSyncerAdminError,
  startSyncerReindex,
  StartReindexRequest,
} from '../services/syncer-admin.js';
import { maybeRecalculateTrustAfterReindex } from '../services/trust-auto-recalculation.js';
import { recalculateTrustScores } from '../services/trust-recalculation.js';
import {
  getServiceAdminConfig,
  setServiceAdminConfig,
  testServiceAdminConfig,
  getLlmAdminConfig,
  setLlmAdminConfig,
  testLlmAdminConfig,
  getEmbeddingAdminConfig,
  getEffectiveEmbeddingConfig,
  setEmbeddingAdminConfig,
  testEmbeddingAdminConfig,
  getIndexingProfiles,
  getIndexingAutomationConfig,
  upsertIndexingProfile,
  setIndexingAutomationConfig,
  upsertRetrievalProfile,
  restoreDefaultRetrievalProfiles,
  applyIndexingProfileToReindexRequest,
  getRagAdminConfig,
  previewRagAdminConfig,
  setRagAdminConfig,
  getWebhookAdminConfig,
  setWebhookAdminConfig,
  testWebhookAdminConfig,
  getChatRetentionAdminConfig,
  setChatRetentionAdminConfig,
  getChatRetentionRedisTtlSeconds,
  getConflictDetectionConfig,
  setConflictDetectionConfig,
  getTrustRecalculationAdminConfig,
  setTrustRecalculationAdminConfig,
  getTrustModels,
  upsertTrustModel,
  getTrustEntities,
  upsertTrustEntity,
  deleteTrustEntity,
  getTrustRules,
  upsertTrustRule,
  deleteTrustRule,
  previewTrustModel,
  listAdminAuditLog,
} from '../services/admin-platform-config.js';
import {
  getRetrievalProfileCapabilities,
  getRetrievalProfilesWithReadiness,
} from '../services/retrieval-profiles.js';
import {
  getChatProfileStatus,
  restoreDefaultChatProfiles,
  setChatManagementConfig,
  upsertChatProfile,
} from '../services/chat-profiles.js';
import type { ChatExportFormat } from '../services/admin-platform-config.js';
import { buildConflictDetectionTestData, detectConflicts } from '../services/conflict-detection.js';
import { getEmbedding } from '../services/embedding.js';
import { callLiteLLM } from '../services/litellm.js';
import {
  deleteColbertIndexPage,
  syncColbertIndexPage,
  testColbertReranker,
} from '../services/colbert-reranker.js';
import {
  cancelColbertIndexSpec,
  createColbertIndexSpec,
  getColbertIndexSpecs,
  promoteColbertIndexSpec,
  updateColbertIndexSpecStatus,
} from '../services/colbert-indexes.js';
import {
  archiveChatSession,
  enforceChatRetention,
  exportChatSession,
  getChatRegistryStats,
  getChatSessionMessages,
  listChatSessions,
  type ChatSessionStatus,
} from '../services/chat-store.js';
import { getIndexingProfileSchedulerStatus } from '../services/indexing-profile-scheduler.js';
import { getTrustRecalculationSchedulerStatus } from '../services/trust-recalculation-scheduler.js';
import {
  cancelTrigramBackfillJob,
  deleteSearchIndexPage,
  getSearchIndexAttachmentDiagnostics,
  getSearchIndexStatus,
  getTrigramBackfillJobStatus,
  startTrigramBackfillJob,
  upsertSearchIndexPage,
} from '../services/search-index.js';
import {
  analyzeOpenSearchQuery,
  deleteOpenSearchPage,
  getOpenSearchAttachmentDiagnostics,
  getOpenSearchStatus,
  searchOpenSearchChunksWithDiagnostics,
  upsertOpenSearchPage,
} from '../services/opensearch.js';
import {
  fetchWikiCategories,
  fetchWikiNamespaces,
  fetchWikiPages,
  fetchWikiTags,
  fetchWikiTemplates,
  fetchWikiUserGroups,
  fetchSmwProperties,
} from '../services/mediawiki.js';
import {
  getExternalApiConfig,
  setExternalApiConfig,
  toExternalApiCapabilities,
} from '../services/external-api-config.js';
import {
  getMediaWikiProfileConfigStatus,
  setMediaWikiProfileConfig,
} from '../services/mediawiki-profile-config.js';
import {
  getKnowledgeSourceProfileConfigStatus,
  setKnowledgeSourceProfileConfig,
} from '../services/knowledge-sources.js';
import { runAdminChatDebugTrace } from '../services/chat-debug-trace.js';
import { principalFromMwUser } from '../services/principal-auth.js';
import { type WikiPageUrlOptions } from '../services/mediawiki-url.js';
import { timingSafeEqualString } from '../services/security.js';

const HELP_TEXT: Record<keyof RuntimeConfig, { label: string; help: string; type: string; min?: number; max?: number }> = {
  litellmModel: {
    label: 'Модель LLM',
    help: 'Название модели в LiteLLM. Примеры: mistral-7b-instruct, gpt-4o, llama-3.1-8b. Изменение требует наличия модели в LiteLLM.',
    type: 'string',
  },
  temperature: {
    label: 'Температура',
    help: '0.1 = точные, консервативные ответы. 1.0 = креативные, разнообразные. Для корпоративной вики рекомендуется 0.2–0.4.',
    type: 'number',
    min: 0,
    max: 2,
  },
  maxTokens: {
    label: 'Макс. токенов в ответе',
    help: 'Максимальная длина ответа LLM. Больше = длиннее ответы, но дороже и дольше. Рекомендуется 512–1024.',
    type: 'number',
    min: 64,
    max: 4096,
  },
  topK: {
    label: 'Количество чанков в контексте (top-k)',
    help: 'Сколько фрагментов вики передавать LLM. Больше = точнее, но дороже (больше токенов в промпте). Рекомендуется 3–5.',
    type: 'number',
    min: 1,
    max: 10,
  },
  chunkSize: {
    label: 'Размер чанка (при переиндексации)',
    help: 'Размер фрагмента текста в токенах. Больше = меньше чанков, но контекст размывается. Меньше = точнее, но больше записей. Рекомендуется 384–768.',
    type: 'number',
    min: 128,
    max: 2048,
  },
  chunkOverlap: {
    label: 'Перекрытие чанков',
    help: 'Сколько токенов дублировать между соседними чанками. Предотвращает потерю смысла на границах. Рекомендуется 40–100.',
    type: 'number',
    min: 0,
    max: 512,
  },
  showSources: {
    label: 'Показывать источники в ответе',
    help: 'Если включено — в конце каждого ответа будет список страниц вики, на которых основан ответ. Рекомендуется включить.',
    type: 'boolean',
  },
  systemPrompt: {
    label: 'Системный промпт',
    help: 'Инструкция для LLM, которая подаётся в начале каждого диалога. Определяет стиль и ограничения ответов.',
    type: 'string',
  },
  timeoutMs: {
    label: 'Таймаут LLM (мс)',
    help: 'Сколько миллисекунд ждать ответа от LLM. Если превышен — вернётся ошибка или fallback. Рекомендуется 15000–60000.',
    type: 'number',
    min: 5000,
    max: 120000,
  },
  searchHistoryEnabled: {
    label: 'Запоминать последние поисковые запросы',
    help: 'Если включено — UI ассистента сохраняет последние успешные поисковые запросы в браузере пользователя.',
    type: 'boolean',
  },
  searchHistoryLimit: {
    label: 'Лимит последних поисковых запросов',
    help: 'Сколько последних запросов показывать в ИИ-поиске. История хранится локально в браузере.',
    type: 'number',
    min: 1,
    max: 20,
  },
};

function isAdmin(user: AuthenticatedRequest['mwUser']): boolean {
  return user?.groups?.some((group) => group === 'sysop' || group === 'aiadmin') ?? false;
}

function auditActor(request: AuthenticatedRequest): string | undefined {
  return request.mwUser?.username;
}

function rejectNonAdmin(request: AuthenticatedRequest, reply: FastifyReply): boolean {
  const mwUser = request.mwUser;
  if (isAdmin(mwUser)) return false;
  reply.status(403).send({ error: 'Requires sysop or aiadmin group' });
  return true;
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function wikiUrlOptionsFromRequest(request: FastifyRequest): WikiPageUrlOptions {
  return {
    requestOrigin: readHeader(request.headers.origin),
    requestHost: readHeader(request.headers.host),
    requestProtocol: readHeader(request.headers['x-forwarded-proto']),
  };
}

function hasInternalAdminAccess(headers: Record<string, unknown>): boolean {
  if (!config.syncerAdminToken) return true;
  return timingSafeEqualString(headers['x-wikiai-admin-token'], config.syncerAdminToken);
}

function parseIntegerParam(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveIntegerBodyField(value: Record<string, unknown>, field: string): number | undefined {
  const raw = value[field];
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function parseNonNegativeIntegerBodyField(value: Record<string, unknown>, field: string): number | undefined {
  const raw = value[field];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

function parseStringArrayBodyField(value: Record<string, unknown>, field: string): string[] {
  const raw = value[field];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseSearchIndexChunks(value: unknown): Array<{
  id: number;
  text: string;
  chunkIndex?: number;
  totalChunks?: number;
  sourceType?: string;
  attachmentFilename?: string;
  mimeType?: string;
  processingMode?: string;
  contentType?: string;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      id: parsePositiveIntegerBodyField(item, 'id') ?? 0,
      text: typeof item.text === 'string' ? item.text : '',
      chunkIndex: parseNonNegativeIntegerBodyField(item, 'chunkIndex'),
      totalChunks: parsePositiveIntegerBodyField(item, 'totalChunks'),
      sourceType: typeof item.sourceType === 'string' ? item.sourceType : undefined,
      attachmentFilename: typeof item.attachmentFilename === 'string' ? item.attachmentFilename : undefined,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
      processingMode: typeof item.processingMode === 'string' ? item.processingMode : undefined,
      contentType: typeof item.contentType === 'string' ? item.contentType : undefined,
    }));
}

function parseIndexTargets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  ));
}

function buildSearchReadiness(input: {
  searchIndexPopulated: boolean;
  bm25Populated: boolean;
  attachmentColumnsReady: boolean;
  colbertEnabled: boolean;
  colbertStatus?: 'ok' | 'error';
}): {
  status: 'prod_ready' | 'limited_ready' | 'not_ready';
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!input.searchIndexPopulated || !input.bm25Populated) {
    reasons.push('BM25/search index is not populated');
  }
  if (!input.attachmentColumnsReady) {
    reasons.push('Attachment index schema is not ready');
  }
  if (!input.colbertEnabled) {
    reasons.push('ColBERT is disabled; only limited scenarios are allowed');
  } else if (input.colbertStatus !== 'ok') {
    reasons.push('ColBERT is enabled but health check is not ok');
  }

  if (
    input.searchIndexPopulated
    && input.bm25Populated
    && input.attachmentColumnsReady
    && input.colbertEnabled
    && input.colbertStatus === 'ok'
  ) {
    return { status: 'prod_ready', reasons };
  }
  if (input.searchIndexPopulated && input.bm25Populated) {
    return { status: 'limited_ready', reasons };
  }
  return { status: 'not_ready', reasons };
}

function parseRouteId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = params.id;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseChatSessionStatus(value: unknown): ChatSessionStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'deleted' ? value : undefined;
}

function parseChatExportFormat(value: unknown): ChatExportFormat {
  return value === 'csv' || value === 'html' ? value : 'json';
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseReindexEnrichmentPayload(value: unknown): {
  title: string;
  text: string;
  model?: string;
  maxChars: number;
} | undefined {
  if (!isRecord(value)) return undefined;
  const title = readTrimmedString(value.title);
  const text = readTrimmedString(value.text);
  if (!title || !text) return undefined;
  const maxChars = typeof value.maxChars === 'number' && Number.isInteger(value.maxChars) && value.maxChars > 0
    ? Math.min(value.maxChars, 50_000)
    : 8000;
  return {
    title,
    text,
    model: readTrimmedString(value.model),
    maxChars,
  };
}

function parseEnrichmentJson(content: string): { summary: string; keywords: string[] } {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
  try {
    const parsed = JSON.parse(jsonText) as { summary?: unknown; keywords?: unknown };
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : content.trim().slice(0, 1200);
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 20)
      : [];
    return { summary, keywords };
  } catch {
    return { summary: content.trim().slice(0, 1200), keywords: [] };
  }
}

function extractSyncerReindexStatus(err: unknown): unknown | undefined {
  if (!isSyncerAdminError(err) || !isRecord(err.responseBody)) return undefined;
  return err.responseBody.status;
}

function parseReindexBody(value: unknown): StartReindexRequest {
  if (!isRecord(value)) return { attachmentsEnabled: false };
  const namespaces = Array.isArray(value.namespaces)
    ? value.namespaces.filter((item): item is number => Number.isInteger(item) && item >= 0)
    : undefined;
  const profileId = typeof value.profileId === 'string' && value.profileId.trim()
    ? value.profileId.trim()
    : undefined;
  const attachmentsEnabled = typeof value.attachmentsEnabled === 'boolean'
    ? value.attachmentsEnabled
    : profileId ? undefined : false;
  const indexTargets = parseIndexTargets(value.indexTargets);
  const effectiveIndexTargets = indexTargets && typeof attachmentsEnabled === 'boolean'
    ? Array.from(new Set(
      attachmentsEnabled
        ? [...indexTargets, 'attachments']
        : indexTargets.filter((target) => target !== 'attachments')
    ))
    : indexTargets;

  const request: StartReindexRequest = {
    indexTargets: effectiveIndexTargets,
    source: value.source === 'qdrant_payload' ? 'qdrant_payload' : value.source === 'mediawiki' ? 'mediawiki' : undefined,
    colbertModel: typeof value.colbertModel === 'string' && value.colbertModel.trim()
      ? value.colbertModel.trim()
      : undefined,
    colbertCollection: typeof value.colbertCollection === 'string' && value.colbertCollection.trim()
      ? value.colbertCollection.trim()
      : undefined,
    attachmentsEnabled,
    semanticFactsEnabled: typeof value.semanticFactsEnabled === 'boolean' ? value.semanticFactsEnabled : undefined,
    cmdbDynamicPagesEnabled: typeof value.cmdbDynamicPagesEnabled === 'boolean'
      ? value.cmdbDynamicPagesEnabled
      : undefined,
    maxPages: typeof value.maxPages === 'number' && Number.isInteger(value.maxPages) && value.maxPages > 0
      ? value.maxPages
      : undefined,
    namespaces: namespaces && namespaces.length > 0 ? namespaces : undefined,
  };

  if (profileId) {
    request.profileId = profileId;
  }
  if (typeof value.dryRun === 'boolean') {
    request.dryRun = value.dryRun;
  }
  if (typeof value.llmEnrichmentEnabled === 'boolean') {
    request.llmEnrichmentEnabled = value.llmEnrichmentEnabled;
  }
  if (typeof value.llmEnrichmentModel === 'string' && value.llmEnrichmentModel.trim()) {
    request.llmEnrichmentModel = value.llmEnrichmentModel.trim();
  }
  if (
    typeof value.llmEnrichmentMaxChars === 'number'
    && Number.isInteger(value.llmEnrichmentMaxChars)
    && value.llmEnrichmentMaxChars > 0
  ) {
    request.llmEnrichmentMaxChars = Math.min(value.llmEnrichmentMaxChars, 50_000);
  }

  return request;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/health',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const health = await getHealthStatus();
      reply.send(health);
    }
  );

  app.get(
    '/api/admin/service-config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send(await getServiceAdminConfig());
    }
  );

  app.get(
    '/api/admin/external-api/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const values = await getExternalApiConfig();
      reply.send({
        values,
        capabilities: {
          ...toExternalApiCapabilities(values),
          retrievalProfiles: await getRetrievalProfileCapabilities(),
        },
        metadata: { secretsRedacted: true },
      });
    }
  );

  app.post(
    '/api/admin/external-api/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        const values = await setExternalApiConfig(request.body, auditActor(authenticated));
        reply.send({
          status: 'saved',
          values,
          capabilities: {
            ...toExternalApiCapabilities(values),
            retrievalProfiles: await getRetrievalProfileCapabilities(),
          },
          metadata: { secretsRedacted: true },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid external API config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/knowledge-source-profile/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({
        ...(await getKnowledgeSourceProfileConfigStatus()),
        metadata: { secretsRedacted: true },
      });
    }
  );

  app.post(
    '/api/admin/knowledge-source-profile/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        await setKnowledgeSourceProfileConfig(request.body, auditActor(authenticated));
        reply.send({
          status: 'saved',
          ...(await getKnowledgeSourceProfileConfigStatus()),
          metadata: { secretsRedacted: true },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid knowledge source profile config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/mediawiki-profile/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({
        ...(await getMediaWikiProfileConfigStatus()),
        metadata: { secretsRedacted: true },
      });
    }
  );

  app.post(
    '/api/admin/mediawiki-profile/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        const values = await setMediaWikiProfileConfig(request.body, auditActor(authenticated));
        await setKnowledgeSourceProfileConfig({
          retrievalProfileId: values.defaultRetrievalProfileId,
        }, auditActor(authenticated));
        reply.send({
          status: 'saved',
          ...(await getMediaWikiProfileConfigStatus()),
          metadata: { secretsRedacted: true },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid MediaWiki profile config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/wiki/categories',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.query) ? request.query : {};
      const search = typeof query.search === 'string' ? query.search : undefined;
      const limit = parseIntegerParam(query.limit, 50);
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      const values = await fetchWikiCategories({ search, limit, sessionCookie });
      reply.send({ values });
    }
  );

  app.get(
    '/api/admin/wiki/namespaces',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      const values = await fetchWikiNamespaces({ sessionCookie });
      reply.send({ values });
    }
  );

  app.get(
    '/api/admin/wiki/user-groups',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      const values = await fetchWikiUserGroups({ sessionCookie });
      reply.send({ values });
    }
  );

  app.get(
    '/api/admin/wiki/tags',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.query) ? request.query : {};
      const search = typeof query.search === 'string' ? query.search : undefined;
      const limit = parseIntegerParam(query.limit, 50);
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      const values = await fetchWikiTags({ search, limit, sessionCookie });
      reply.send({ values });
    }
  );

  app.get(
    '/api/admin/wiki/templates',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.query) ? request.query : {};
      const search = typeof query.search === 'string' ? query.search : undefined;
      const limit = parseIntegerParam(query.limit, 50);
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      const values = await fetchWikiTemplates({ search, limit, sessionCookie });
      reply.send({ values });
    }
  );

  app.get(
    '/api/admin/wiki/pages',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.query) ? request.query : {};
      const search = typeof query.search === 'string' ? query.search : undefined;
      const limit = parseIntegerParam(query.limit, 50);
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      const values = await fetchWikiPages({ search, limit, sessionCookie });
      reply.send({ values });
    }
  );

  app.get(
    '/api/admin/smw/properties',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.query) ? request.query : {};
      const search = typeof query.search === 'string' ? query.search : undefined;
      const limit = parseIntegerParam(query.limit, 100);
      const continueToken = typeof query.continue === 'string' ? query.continue : undefined;
      const sessionCookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined;
      try {
        const result = await fetchSmwProperties({
          search,
          limit,
          continue: continueToken,
          sessionCookie,
        });
        reply.send(result);
      } catch (err) {
        reply.status(503).send({
          error: 'SMW properties unavailable',
          message: err instanceof Error ? err.message : 'Unknown SMW properties error',
        });
      }
    }
  );

  app.post(
    '/api/admin/service-config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        const result = await setServiceAdminConfig(request.body, auditActor(authenticated));
        reply.send({ status: 'saved', ...result });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid service config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/service-config/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const [health, diagnostics, opensearch] = await Promise.all([
        getHealthStatus(),
        testServiceAdminConfig(),
        getOpenSearchStatus(),
      ]);
      reply.send({ values: { health, ...diagnostics, opensearch } });
    }
  );

  app.get(
    '/api/admin/opensearch/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getOpenSearchStatus() });
    }
  );

  app.post(
    '/api/admin/opensearch/attachment-diagnostics',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const filename = isRecord(request.body) && typeof request.body.filename === 'string'
        ? request.body.filename.trim()
        : '';
      if (!filename) {
        reply.status(400).send({ error: 'filename is required' });
        return;
      }
      const limit = isRecord(request.body) && typeof request.body.limit === 'number'
        ? request.body.limit
        : undefined;
      const [searchIndex, opensearch] = await Promise.all([
        getSearchIndexAttachmentDiagnostics(filename, limit),
        getOpenSearchAttachmentDiagnostics(filename, limit),
      ]);
      reply.send({
        values: {
          filename,
          searchIndex,
          opensearch,
          mismatch: searchIndex.chunks > 0 && opensearch.chunks < searchIndex.chunks,
        },
      });
    }
  );

  app.post(
    '/api/admin/opensearch/analyze',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.body) && typeof request.body.query === 'string'
        ? request.body.query.trim()
        : '';
      if (!query) {
        reply.status(400).send({ error: 'query is required' });
        return;
      }
      reply.send({ values: await analyzeOpenSearchQuery(query) });
    }
  );

  app.post(
    '/api/admin/opensearch/search-preview',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = isRecord(request.body) && typeof request.body.query === 'string'
        ? request.body.query.trim()
        : '';
      const limit = isRecord(request.body) && typeof request.body.limit === 'number'
        ? request.body.limit
        : undefined;
      if (!query) {
        reply.status(400).send({ error: 'query is required' });
        return;
      }
      const result = await searchOpenSearchChunksWithDiagnostics(query, limit, await getRagAdminConfig());
      reply.send({
        values: {
          diagnostics: result.diagnostics,
          chunks: result.chunks.map((chunk) => ({
            id: chunk.id,
            pageId: chunk.pageId,
            title: chunk.title,
            namespace: chunk.namespace,
            lexicalRank: chunk.lexicalRank,
            matchedTerms: chunk.lexicalMatchedTerms,
            sourceType: chunk.sourceType,
            text: chunk.text.slice(0, 500),
          })),
        },
      });
    }
  );

  app.get(
    '/api/admin/llm/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getLlmAdminConfig(), metadata: { secretsRedacted: true } });
    }
  );

  app.post(
    '/api/admin/llm/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setLlmAdminConfig(request.body, auditActor(authenticated)),
          metadata: { secretsRedacted: true },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid LLM config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/llm/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await testLlmAdminConfig(), metadata: { paidApiPossible: true } });
    }
  );

  app.post(
    '/api/admin/chat/debug-trace',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          values: await runAdminChatDebugTrace(request.body, {
            principal: principalFromMwUser(authenticated.mwUser!, authenticated.sessionCookie),
            wikiUrlOptions: wikiUrlOptionsFromRequest(request),
          }),
          metadata: {
            paidApiPossible: true,
            sideEffects: 'dry-run',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown chat debug trace error';
        const statusCode = /LiteLLM|timed out|fetch/i.test(message) ? 502 : 400;
        reply.status(statusCode).send({
          error: 'Chat debug trace failed',
          message,
        });
      }
    }
  );

  app.get(
    '/api/admin/conflict-detection/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({
        values: await getConflictDetectionConfig(),
        metadata: { paidApiPossible: true },
      });
    }
  );

  app.post(
    '/api/admin/conflict-detection/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setConflictDetectionConfig(request.body, auditActor(authenticated)),
          metadata: { paidApiPossible: true },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid conflict detection config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/conflict-detection/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      try {
        const sample = buildConflictDetectionTestData(request.body);
        const config = await getConflictDetectionConfig();
        const values = await detectConflicts(sample.query, sample.chunks, { config, force: true });
        reply.send({
          values,
          metadata: { paidApiPossible: true, query: sample.query },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Conflict detection test failed',
          message: err instanceof Error ? err.message : 'Unknown conflict detection test error',
        });
      }
    }
  );

  app.get(
    '/api/admin/embedding/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getEmbeddingAdminConfig() });
    }
  );

  app.post(
    '/api/admin/embedding/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setEmbeddingAdminConfig(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid embedding config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/embedding/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      const values = await testEmbeddingAdminConfig(auditActor(authenticated));
      reply.send({
        values,
        metadata: { paidApiPossible: values.provider === 'openai_compatible' },
      });
    }
  );

  app.get('/api/internal/embedding/config', async (request, reply) => {
    if (!hasInternalAdminAccess(request.headers)) {
      reply.status(401).send({ error: 'Invalid internal admin token' });
      return;
    }

    const embedding = await getEffectiveEmbeddingConfig();
    reply.send({
      values: {
        provider: embedding.provider,
        baseUrl: embedding.baseUrl,
        model: embedding.model,
        dimensions: embedding.dimensions,
        apiKeyConfigured: Boolean(embedding.apiKey),
      },
      metadata: { secretsRedacted: true },
    });
  });

  app.get('/api/internal/indexing-profiles', async (request, reply) => {
    if (!hasInternalAdminAccess(request.headers)) {
      reply.status(401).send({ error: 'Invalid internal admin token' });
      return;
    }

    reply.send({ values: await getIndexingProfiles() });
  });

  app.get('/api/internal/indexing-automation', async (request, reply) => {
    if (!hasInternalAdminAccess(request.headers)) {
      reply.status(401).send({ error: 'Invalid internal admin token' });
      return;
    }

    reply.send({ values: await getIndexingAutomationConfig() });
  });

  app.post('/api/internal/embedding/vector', async (request, reply) => {
    if (!hasInternalAdminAccess(request.headers)) {
      reply.status(401).send({ error: 'Invalid internal admin token' });
      return;
    }

    const text = isRecord(request.body) ? readTrimmedString(request.body.text) : undefined;
    if (!text) {
      reply.status(400).send({ error: 'text is required' });
      return;
    }

    const [embeddingConfig, vector] = await Promise.all([
      getEffectiveEmbeddingConfig(),
      getEmbedding(text),
    ]);
    reply.send({
      values: {
        vector,
        provider: embeddingConfig.provider,
        model: embeddingConfig.model,
        dimensions: vector.length,
      },
      metadata: {
        paidApiPossible: embeddingConfig.provider === 'openai_compatible',
      },
    });
  });

  app.post('/api/internal/reindex/llm-enrich', async (request, reply) => {
    if (!hasInternalAdminAccess(request.headers)) {
      reply.status(401).send({ error: 'Invalid internal admin token' });
      return;
    }

    const payload = parseReindexEnrichmentPayload(request.body);
    if (!payload) {
      reply.status(400).send({ error: 'title and text are required' });
      return;
    }

    const truncated = payload.text.slice(0, payload.maxChars);
    const response = await callLiteLLM([
      {
        role: 'system',
        content: [
          'You summarize corporate wiki pages for search indexing.',
          'Return only compact JSON with fields summary and keywords.',
          'summary must be Russian, factual, <= 900 characters.',
          'keywords must be an array of 3-12 short Russian search phrases.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Title: ${payload.title}\n\nPage text:\n${truncated}`,
      },
    ], payload.model);
    const content = response.choices?.[0]?.message?.content ?? '';
    const parsed = parseEnrichmentJson(content);

    reply.send({
      values: {
        ...parsed,
        model: payload.model ?? response.model,
        inputChars: truncated.length,
      },
      metadata: { paidApiPossible: true },
    });
  });

  app.get(
    '/api/admin/rag/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getRagAdminConfig() });
    }
  );

  app.get(
    '/api/admin/retrieval-profiles',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getRetrievalProfilesWithReadiness() });
    }
  );

  app.post(
    '/api/admin/retrieval-profiles',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        await upsertRetrievalProfile(request.body, auditActor(authenticated));
        reply.send({
          status: 'saved',
          values: await getRetrievalProfilesWithReadiness(),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid retrieval profile',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/retrieval-profiles/restore-defaults',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      await restoreDefaultRetrievalProfiles(auditActor(authenticated));
      reply.send({
        status: 'saved',
        values: await getRetrievalProfilesWithReadiness(),
      });
    }
  );

  app.post(
    '/api/admin/rag/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setRagAdminConfig(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid RAG config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/rag/colbert/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await testColbertReranker(await previewRagAdminConfig(request.body)) });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid RAG config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/rag/colbert/indexes',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getColbertIndexSpecs() });
    }
  );

  app.post(
    '/api/admin/rag/colbert/indexes',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      if (!isRecord(request.body)) {
        reply.status(400).send({ error: 'Invalid ColBERT index request' });
        return;
      }

      let createdSpecId: string | undefined;
      try {
        const spec = await createColbertIndexSpec(request.body, auditActor(authenticated));
        createdSpecId = spec.id;
        const reindex = await startSyncerReindex({
          profileId: typeof request.body.sourceProfile === 'string' ? request.body.sourceProfile : undefined,
          indexTargets: ['colbert'],
          source: spec.source,
          colbertModel: spec.model,
          colbertCollection: spec.collection,
          dryRun: typeof request.body.dryRun === 'boolean' ? request.body.dryRun : false,
          maxPages: parsePositiveIntegerBodyField(request.body, 'maxPages'),
          attachmentsEnabled: false,
          semanticFactsEnabled: false,
        });
        reply.status(202).send({ values: spec, reindex });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown ColBERT index build error';
        if (createdSpecId) {
          await updateColbertIndexSpecStatus(createdSpecId, { status: 'failed', error: message }, auditActor(authenticated))
            .catch(() => undefined);
        }
        reply.status(isSyncerAdminError(err) ? err.statusCode : 400).send({
          error: 'Unable to start ColBERT index build',
          message,
        });
      }
    }
  );

  app.get(
    '/api/admin/rag/colbert/indexes/:id/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      const id = parseRouteId(request.params);
      if (!id) {
        reply.status(400).send({ error: 'ColBERT index id is required' });
        return;
      }

      try {
        const indexes = await getColbertIndexSpecs();
        let spec = indexes.find((item) => item.id === id);
        if (!spec) {
          reply.status(404).send({ error: 'ColBERT index not found' });
          return;
        }
        const reindexStatus = await getSyncerReindexStatus().catch(() => undefined);
        const reindexStartedAt = isRecord(reindexStatus) && typeof reindexStatus.startedAt === 'string'
          ? Date.parse(reindexStatus.startedAt)
          : NaN;
        const specStartedAt = Date.parse(spec.startedAt ?? spec.createdAt);
        const reindexBelongsToSpec = Number.isFinite(reindexStartedAt)
          && Number.isFinite(specStartedAt)
          && reindexStartedAt >= specStartedAt;
        if (spec.status === 'building' && isRecord(reindexStatus) && reindexBelongsToSpec) {
          if (reindexStatus.state === 'completed' && isRecord(reindexStatus.summary)) {
            spec = await updateColbertIndexSpecStatus(id, {
              status: 'complete',
              pagesProcessed: typeof reindexStatus.summary.processed === 'number'
                ? reindexStatus.summary.processed
                : spec.pagesProcessed,
              chunksIndexed: typeof reindexStatus.summary.totalChunks === 'number'
                ? reindexStatus.summary.totalChunks
                : spec.chunksIndexed,
              failures: typeof reindexStatus.summary.failed === 'number'
                ? reindexStatus.summary.failed
                : spec.failures,
            }, auditActor(authenticated));
          } else if (reindexStatus.state === 'failed') {
            spec = await updateColbertIndexSpecStatus(id, {
              status: 'failed',
              error: typeof reindexStatus.error === 'string' ? reindexStatus.error : 'Syncer reindex failed',
            }, auditActor(authenticated));
          }
        }
        reply.send({ values: spec, reindex: reindexStatus });
      } catch (err) {
        reply.status(400).send({
          error: 'Unable to read ColBERT index status',
          message: err instanceof Error ? err.message : 'Unknown ColBERT index status error',
        });
      }
    }
  );

  app.post(
    '/api/admin/rag/colbert/indexes/:id/promote',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      const id = parseRouteId(request.params);
      if (!id) {
        reply.status(400).send({ error: 'ColBERT index id is required' });
        return;
      }

      try {
        reply.send({ values: await promoteColbertIndexSpec(id, auditActor(authenticated)) });
      } catch (err) {
        reply.status(400).send({
          error: 'Unable to promote ColBERT index',
          message: err instanceof Error ? err.message : 'Unknown ColBERT promote error',
        });
      }
    }
  );

  app.post(
    '/api/admin/rag/colbert/indexes/:id/cancel',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      const id = parseRouteId(request.params);
      if (!id) {
        reply.status(400).send({ error: 'ColBERT index id is required' });
        return;
      }

      try {
        reply.send({ values: await cancelColbertIndexSpec(id, auditActor(authenticated)) });
      } catch (err) {
        reply.status(400).send({
          error: 'Unable to cancel ColBERT index',
          message: err instanceof Error ? err.message : 'Unknown ColBERT cancel error',
        });
      }
    }
  );

  app.get(
    '/api/admin/search-index/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const [status, ragConfig] = await Promise.all([
        getSearchIndexStatus(),
        getRagAdminConfig(),
      ]);
      const colbertHealth = ragConfig.colbertEnabled
        ? await testColbertReranker(ragConfig).catch((err) => ({
          status: 'error' as const,
          url: ragConfig.colbertBaseUrl,
          latencyMs: 0,
          error: err instanceof Error ? err.message : 'Unknown ColBERT health error',
        }))
        : undefined;
      reply.send({
        values: {
          ...status,
          readiness: buildSearchReadiness({
            searchIndexPopulated: status.populated,
            bm25Populated: status.ftsChunks > 0,
            attachmentColumnsReady: status.attachmentColumnsReady,
            colbertEnabled: ragConfig.colbertEnabled,
            colbertStatus: colbertHealth?.status,
          }),
          colbertHealth,
        },
      });
    }
  );

  app.post(
    '/api/admin/search-index/trigram/backfill',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.status(202).send({ values: await startTrigramBackfillJob(auditActor(authenticated)) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown trigram backfill error';
        reply.status(message.includes('already running') ? 409 : 400).send({
          error: 'Trigram backfill failed',
          message,
        });
      }
    }
  );

  app.get(
    '/api/admin/search-index/trigram/backfill/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getTrigramBackfillJobStatus() ?? null });
    }
  );

  app.post(
    '/api/admin/search-index/trigram/backfill/cancel',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await cancelTrigramBackfillJob() ?? null });
    }
  );

  app.get(
    '/api/admin/indexing-profiles',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getIndexingProfiles() });
    }
  );

  app.post(
    '/api/admin/indexing-profiles',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await upsertIndexingProfile(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid indexing profile',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/indexing-automation',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getIndexingAutomationConfig() });
    }
  );

  app.post(
    '/api/admin/indexing-automation',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setIndexingAutomationConfig(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid indexing automation config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/indexing-profile-scheduler/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ scheduler: await getIndexingProfileSchedulerStatus() });
    }
  );

  app.get(
    '/api/admin/webhook/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getWebhookAdminConfig() });
    }
  );

  app.post(
    '/api/admin/webhook/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setWebhookAdminConfig(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid webhook config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/webhook/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      reply.send({ values: await testWebhookAdminConfig(auditActor(authenticated)) });
    }
  );

  app.get(
    '/api/admin/chat-profiles',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send(await getChatProfileStatus());
    }
  );

  app.post(
    '/api/admin/chat-profiles',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        await upsertChatProfile(request.body, auditActor(authenticated));
        reply.send({
          status: 'saved',
          ...(await getChatProfileStatus()),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid chat profile',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/chat-profiles/restore-defaults',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      await restoreDefaultChatProfiles(auditActor(authenticated));
      reply.send({
        status: 'saved',
        ...(await getChatProfileStatus()),
      });
    }
  );

  app.get(
    '/api/admin/chat-management/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send(await getChatProfileStatus());
    }
  );

  app.post(
    '/api/admin/chat-management/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        await setChatManagementConfig(request.body, auditActor(authenticated));
        reply.send({
          status: 'saved',
          ...(await getChatProfileStatus()),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid chat management config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/chat-retention/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const values = await getChatRetentionAdminConfig();
      await enforceChatRetention(values);
      reply.send({
        values,
        metadata: {
          redisTtlSeconds: await getChatRetentionRedisTtlSeconds(),
          registry: await getChatRegistryStats(),
        },
      });
    }
  );

  app.post(
    '/api/admin/chat-retention/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        const values = await setChatRetentionAdminConfig(request.body, auditActor(authenticated));
        await enforceChatRetention(values);
        reply.send({
          status: 'saved',
          values,
          metadata: {
            redisTtlSeconds: await getChatRetentionRedisTtlSeconds(),
            registry: await getChatRegistryStats(),
          },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid chat retention config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/admin/chat-sessions',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      await enforceChatRetention(await getChatRetentionAdminConfig());
      const status = parseChatSessionStatus(request.query.status);
      const limit = parseIntegerParam(request.query.limit, 50);
      reply.send({
        values: await listChatSessions(status, limit),
        metadata: { registry: await getChatRegistryStats() },
      });
    }
  );

  app.get<{ Params: { sessionId: string } }>(
    '/api/admin/chat-sessions/:sessionId/messages',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getChatSessionMessages(request.params.sessionId) });
    }
  );

  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/api/admin/chat-sessions/:sessionId/archive',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const reason = isRecord(request.body) && typeof request.body.reason === 'string'
        ? request.body.reason
        : 'manual';
      try {
        const values = await archiveChatSession(request.params.sessionId, reason);
        await getAdminStore().appendAuditLog({
          actor: auditActor(request as AuthenticatedRequest),
          action: 'chat-session.archive',
          entityType: 'chat-sessions',
          entityId: request.params.sessionId,
          newValue: { reason, status: values.status },
        });
        reply.send({ status: 'archived', values });
      } catch (err) {
        reply.status(404).send({
          error: 'Chat session archive failed',
          message: err instanceof Error ? err.message : 'Unknown chat archive error',
        });
      }
    }
  );

  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/api/admin/chat-sessions/:sessionId/export',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const format = parseChatExportFormat(isRecord(request.body) ? request.body.format : undefined);
      try {
        const values = await exportChatSession(
          request.params.sessionId,
          format,
          await getChatRetentionAdminConfig()
        );
        await getAdminStore().appendAuditLog({
          actor: auditActor(request as AuthenticatedRequest),
          action: 'chat-session.export',
          entityType: 'chat-sessions',
          entityId: request.params.sessionId,
          newValue: { exportId: values.id, format: values.format },
        });
        reply.send({ status: 'exported', values });
      } catch (err) {
        reply.status(404).send({
          error: 'Chat session export failed',
          message: err instanceof Error ? err.message : 'Unknown chat export error',
        });
      }
    }
  );

  app.get<{ Params: { modelId: string } }>(
    '/api/admin/trust-models/:modelId/rules',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await getTrustRules(request.params.modelId) });
      } catch (err) {
        reply.status(404).send({
          error: 'Trust rules unavailable',
          message: err instanceof Error ? err.message : 'Unknown trust rules error',
        });
      }
    }
  );

  app.post<{ Params: { modelId: string }; Body: unknown }>(
    '/api/admin/trust-models/:modelId/rules',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'saved',
          values: await upsertTrustRule(
            request.params.modelId,
            undefined,
            request.body,
            auditActor(authenticated)
          ),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown trust rule validation error';
        reply.status(message.includes('not found') ? 404 : 400).send({
          error: 'Invalid trust rule',
          message,
        });
      }
    }
  );

  app.delete<{ Params: { modelId: string; ruleId: string } }>(
    '/api/admin/trust-models/:modelId/rules/:ruleId',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'deleted',
          values: await deleteTrustRule(
            request.params.modelId,
            undefined,
            request.params.ruleId,
            auditActor(authenticated)
          ),
        });
      } catch (err) {
        reply.status(404).send({
          error: 'Trust rule delete failed',
          message: err instanceof Error ? err.message : 'Unknown trust rule delete error',
        });
      }
    }
  );

  app.get<{ Params: { modelId: string; entityId: string } }>(
    '/api/admin/trust-models/:modelId/entities/:entityId/rules',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await getTrustRules(request.params.modelId, request.params.entityId) });
      } catch (err) {
        reply.status(404).send({
          error: 'Trust rules unavailable',
          message: err instanceof Error ? err.message : 'Unknown trust rules error',
        });
      }
    }
  );

  app.post<{ Params: { modelId: string; entityId: string } }>(
    '/api/admin/trust-models/:modelId/entities/:entityId/rules',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'saved',
          values: await upsertTrustRule(
            request.params.modelId,
            request.params.entityId,
            request.body,
            auditActor(authenticated)
          ),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown trust rule validation error';
        reply.status(message.includes('not found') ? 404 : 400).send({
          error: 'Invalid trust rule',
          message,
        });
      }
    }
  );

  app.delete<{ Params: { modelId: string; entityId: string; ruleId: string } }>(
    '/api/admin/trust-models/:modelId/entities/:entityId/rules/:ruleId',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'deleted',
          values: await deleteTrustRule(
            request.params.modelId,
            request.params.entityId,
            request.params.ruleId,
            auditActor(authenticated)
          ),
        });
      } catch (err) {
        reply.status(404).send({
          error: 'Trust rule delete failed',
          message: err instanceof Error ? err.message : 'Unknown trust rule delete error',
        });
      }
    }
  );

  app.get<{ Params: { modelId: string } }>(
    '/api/admin/trust-models/:modelId/entities',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await getTrustEntities(request.params.modelId) });
      } catch (err) {
        reply.status(404).send({
          error: 'Trust entities unavailable',
          message: err instanceof Error ? err.message : 'Unknown trust entities error',
        });
      }
    }
  );

  app.post<{ Params: { modelId: string } }>(
    '/api/admin/trust-models/:modelId/entities',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'saved',
          values: await upsertTrustEntity(request.params.modelId, request.body, auditActor(authenticated)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown trust entity validation error';
        reply.status(message.includes('not found') ? 404 : 400).send({
          error: 'Invalid trust entity',
          message,
        });
      }
    }
  );

  app.delete<{ Params: { modelId: string; entityId: string } }>(
    '/api/admin/trust-models/:modelId/entities/:entityId',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'deleted',
          values: await deleteTrustEntity(
            request.params.modelId,
            request.params.entityId,
            auditActor(authenticated)
          ),
        });
      } catch (err) {
        reply.status(404).send({
          error: 'Trust entity delete failed',
          message: err instanceof Error ? err.message : 'Unknown trust entity delete error',
        });
      }
    }
  );

  app.post<{ Params: { modelId: string } }>(
    '/api/admin/trust-models/:modelId/preview',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await previewTrustModel(request.params.modelId, request.body) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown trust preview error';
        reply.status(message.includes('not found') ? 404 : 400).send({
          error: 'Trust preview failed',
          message,
        });
      }
    }
  );

  app.post(
    '/api/admin/trust-scores/recalculate',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await recalculateTrustScores(request.body ?? {}) });
      } catch (err) {
        reply.status(400).send({
          error: 'Trust recalculation failed',
          message: err instanceof Error ? err.message : 'Unknown trust recalculation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/trust-recalculation/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({
        values: await getTrustRecalculationAdminConfig(),
        scheduler: await getTrustRecalculationSchedulerStatus(),
      });
    }
  );

  app.post(
    '/api/admin/trust-recalculation/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;

      try {
        reply.send({
          status: 'saved',
          values: await setTrustRecalculationAdminConfig(request.body, auditActor(authenticated)),
          scheduler: await getTrustRecalculationSchedulerStatus(),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid trust recalculation config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/internal/trust/recalculate-page',
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }
      if (!isRecord(request.body)) {
        reply.status(400).send({ error: 'Invalid trust recalculation request' });
        return;
      }

      const pageId = parsePositiveIntegerBodyField(request.body, 'pageId');
      if (!pageId) {
        reply.status(400).send({ error: 'pageId must be a positive integer' });
        return;
      }

      try {
        reply.send({
          values: await recalculateTrustScores({
            pageId,
            dryRun: false,
            batchSize: parsePositiveIntegerBodyField(request.body, 'batchSize'),
            maxScan: parsePositiveIntegerBodyField(request.body, 'maxScan'),
          }),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Trust recalculation failed',
          message: err instanceof Error ? err.message : 'Unknown trust recalculation error',
        });
      }
    }
  );

  app.get(
    '/api/internal/smw/indexed-properties',
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }

      reply.send({ values: await getIndexedSmwProperties() });
    }
  );

  app.post(
    '/api/internal/smw/autofill/evaluate',
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }

      try {
        reply.send({ values: await evaluateSemanticAutofill(request.body) });
      } catch (err) {
        reply.status(400).send({
          error: 'Semantic autofill evaluation failed',
          message: err instanceof Error ? err.message : 'Unknown semantic autofill error',
        });
      }
    }
  );

  app.post(
    '/api/internal/smw/autofill/applied',
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }

      try {
        reply.send({ status: 'saved', values: await recordSemanticAutofillApplied(request.body) });
      } catch (err) {
        reply.status(400).send({
          error: 'Semantic autofill applied state failed',
          message: err instanceof Error ? err.message : 'Unknown semantic autofill state error',
        });
      }
    }
  );

  app.get(
    '/api/internal/search-index/status',
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }
      reply.send({ values: await getSearchIndexStatus() });
    }
  );

  app.post(
    '/api/internal/search-index/page',
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }
      if (!isRecord(request.body)) {
        reply.status(400).send({ error: 'Invalid search index request' });
        return;
      }

      const pageId = parsePositiveIntegerBodyField(request.body, 'pageId');
      const namespace = parseNonNegativeIntegerBodyField(request.body, 'namespace');
      const title = typeof request.body.title === 'string' ? request.body.title.trim() : '';
      if (!pageId || namespace === undefined || !title) {
        reply.status(400).send({ error: 'pageId, namespace and title are required' });
        return;
      }

      try {
        const pageInput = {
          pageId,
          title,
          namespace,
          allowedGroups: parseStringArrayBodyField(request.body, 'allowedGroups'),
          lastModified: typeof request.body.lastModified === 'string' ? request.body.lastModified : undefined,
          replacePage: typeof request.body.replacePage === 'boolean' ? request.body.replacePage : undefined,
          indexTargets: parseIndexTargets(request.body.indexTargets),
          colbertModel: typeof request.body.colbertModel === 'string' ? request.body.colbertModel.trim() : undefined,
          colbertCollection: typeof request.body.colbertCollection === 'string'
            ? request.body.colbertCollection.trim()
            : undefined,
          chunks: parseSearchIndexChunks(request.body.chunks),
        };
        const targets = pageInput.indexTargets;
        const shouldUpdateBm25 = !targets || targets.includes('bm25');
        const shouldUpdateColbert = !targets || targets.includes('colbert');
        const shouldUpdateOpenSearch = !targets || targets.includes('opensearch');
        const searchIndex = shouldUpdateBm25
          ? await upsertSearchIndexPage(pageInput)
          : { status: 'disabled' as const, pageId, replacedPage: pageInput.replacePage !== false, chunks: 0 };
        const colbertIndex = shouldUpdateColbert
          ? await syncColbertIndexPage(pageInput)
          : { status: 'disabled' as const, url: '/index/page', chunks: 0, error: 'ColBERT target is disabled for this request' };
        const openSearchIndex = shouldUpdateOpenSearch
          ? await upsertOpenSearchPage(pageInput)
          : { status: 'disabled' as const, pageId, replacedPage: pageInput.replacePage !== false, chunks: 0 };
        const anyTargetUpdated = searchIndex.status === 'ok'
          || colbertIndex.status === 'ok'
          || openSearchIndex.status === 'ok';
        reply.send({
          values: {
            ...searchIndex,
            status: anyTargetUpdated ? 'ok' : searchIndex.status,
            chunks: searchIndex.chunks + colbertIndex.chunks + openSearchIndex.chunks,
            chunksByTarget: {
              bm25: searchIndex.chunks,
              colbert: colbertIndex.chunks,
              opensearch: openSearchIndex.chunks,
            },
            colbertIndex,
            openSearchIndex,
          },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Search index update failed',
          message: err instanceof Error ? err.message : 'Unknown search index error',
        });
      }
    }
  );

  app.post(
    '/api/internal/search-index/delete-page',
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!hasInternalAdminAccess(request.headers)) {
        reply.status(401).send({ error: 'Invalid internal admin token' });
        return;
      }
      if (!isRecord(request.body)) {
        reply.status(400).send({ error: 'Invalid search index delete request' });
        return;
      }

      const pageId = parsePositiveIntegerBodyField(request.body, 'pageId');
      if (!pageId) {
        reply.status(400).send({ error: 'pageId must be a positive integer' });
        return;
      }

      try {
        const searchIndex = await deleteSearchIndexPage(pageId);
        const colbertIndex = await deleteColbertIndexPage(pageId);
        const openSearchIndex = await deleteOpenSearchPage(pageId);
        reply.send({
          values: {
            ...searchIndex,
            colbertIndex,
            openSearchIndex,
          },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Search index delete failed',
          message: err instanceof Error ? err.message : 'Unknown search index error',
        });
      }
    }
  );

  app.get(
    '/api/admin/trust-models',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getTrustModels() });
    }
  );

  app.post(
    '/api/admin/trust-models',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'saved',
          values: await upsertTrustModel(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid trust model',
          message: err instanceof Error ? err.message : 'Unknown trust model validation error',
        });
      }
    }
  );

  app.get(
    '/api/admin/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      const config = await getRuntimeConfig();
      reply.send({
        values: config,
        fields: HELP_TEXT,
        defaults: Object.fromEntries(
          Object.entries(HELP_TEXT).map(([k, v]) => [k, v.label])
        ),
      });
    }
  );

  app.post(
    '/api/admin/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      const body = request.body as Partial<RuntimeConfig>;
      await setRuntimeConfig(body);
      reply.send({ status: 'saved', config: await getRuntimeConfig() });
    }
  );

  app.post(
    '/api/admin/config/reset',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      await resetRuntimeConfig();
      reply.send({ status: 'reset', config: await getRuntimeConfig() });
    }
  );

  app.post(
    '/api/admin/cache/clear',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      const { clearUserGroupCache } = await import('../services/redis.js');
      const deleted = await clearUserGroupCache();
      reply.send({ status: 'cache_cleared', deleted });
    }
  );

  app.get(
    '/api/admin/document-processing',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getDocumentProcessingConfig() });
    }
  );

  app.post(
    '/api/admin/document-processing',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        const config = await setDocumentProcessingConfig(request.body);
        reply.send({ status: 'saved', config });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid document processing config',
          message: err instanceof Error ? err.message : 'Unknown validation error',
        });
      }
    }
  );

  app.post(
    '/api/admin/document-processing/reset',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ status: 'reset', config: await resetDocumentProcessingConfig() });
    }
  );

  app.get(
    '/api/admin/semantic/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = request.query as Record<string, unknown>;

      try {
        reply.send({
          values: await getSemanticStatus({
            batchSize: parseIntegerParam(query.batchSize, undefined),
            maxScan: parseIntegerParam(query.maxScan, undefined),
          }),
        });
      } catch (err) {
        reply.status(503).send({
          error: 'Semantic diagnostics unavailable',
          message: err instanceof Error ? err.message : 'Unknown semantic diagnostics error',
        });
      }
    }
  );

  app.get(
    '/api/admin/semantic/search',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = request.query as Record<string, unknown>;
      const property = typeof query.property === 'string' ? query.property.trim() : '';
      if (!property) {
        reply.status(400).send({ error: 'Query parameter "property" is required' });
        return;
      }

      try {
        reply.send({
          values: await searchSemanticFacts(
            {
              property,
              value: typeof query.value === 'string' ? query.value : undefined,
              namespace: parseIntegerParam(query.namespace, undefined),
              limit: parseIntegerParam(query.limit, undefined),
              batchSize: parseIntegerParam(query.batchSize, undefined),
              maxScan: parseIntegerParam(query.maxScan, undefined),
            },
            (request as AuthenticatedRequest).sessionCookie
          ),
        });
      } catch (err) {
        reply.status(503).send({
          error: 'Semantic search unavailable',
          message: err instanceof Error ? err.message : 'Unknown semantic search error',
        });
      }
    }
  );

  app.get(
    '/api/admin/smw/autofill/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getSemanticAutofillConfig() });
    }
  );

  app.post(
    '/api/admin/smw/autofill/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'saved',
          values: await setSemanticAutofillConfig(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid semantic autofill config',
          message: err instanceof Error ? err.message : 'Unknown semantic autofill config error',
        });
      }
    }
  );

  app.get(
    '/api/admin/smw/autofill/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = request.query as Record<string, unknown>;
      try {
        reply.send({
          values: await getSemanticAutofillStatus({
            state: typeof query.state === 'string' ? query.state : undefined,
            property: typeof query.property === 'string' ? query.property : undefined,
            title: typeof query.title === 'string' ? query.title : undefined,
            limit: parseIntegerParam(query.limit, undefined),
          }),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Semantic autofill status failed',
          message: err instanceof Error ? err.message : 'Unknown semantic autofill status error',
        });
      }
    }
  );

  app.post(
    '/api/admin/smw/autofill/test',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        const body = isRecord(request.body) ? { ...request.body, force: true } : request.body;
        reply.send({ values: await evaluateSemanticAutofill(body) });
      } catch (err) {
        reply.status(400).send({
          error: 'Semantic autofill test failed',
          message: err instanceof Error ? err.message : 'Unknown semantic autofill test error',
        });
      }
    }
  );

  app.post(
    '/api/admin/smw/autofill/reset-ownership',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'reset',
          values: await resetSemanticAutofillOwnership(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Semantic autofill ownership reset failed',
          message: err instanceof Error ? err.message : 'Unknown semantic autofill reset error',
        });
      }
    }
  );

  app.get(
    '/api/admin/smw/ontology',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      reply.send({ values: await getOntologyProperties() });
    }
  );

  app.post(
    '/api/admin/smw/ontology',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'saved',
          values: await upsertOntologyProperty(request.body, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Invalid ontology property',
          message: err instanceof Error ? err.message : 'Unknown ontology validation error',
        });
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/smw/ontology/:id',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        reply.send({
          status: 'deleted',
          values: await deleteOntologyProperty(request.params.id, auditActor(authenticated)),
        });
      } catch (err) {
        reply.status(404).send({
          error: 'Ontology property delete failed',
          message: err instanceof Error ? err.message : 'Unknown ontology delete error',
        });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/smw/ontology/:id/generate-vector',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const authenticated = request as AuthenticatedRequest;
      if (rejectNonAdmin(authenticated, reply)) return;
      try {
        const embeddingConfig = await getEffectiveEmbeddingConfig();
        reply.send({
          values: await generateOntologyVector(request.params.id, auditActor(authenticated)),
          metadata: {
            embeddingProvider: embeddingConfig.provider,
            paidApiPossible: embeddingConfig.provider === 'openai_compatible',
            openAiUsed: embeddingConfig.provider === 'openai_compatible',
          },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Ontology vector generation failed',
          message: err instanceof Error ? err.message : 'Unknown ontology vector error',
        });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/smw/ontology/:id/similarities',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = request.query as Record<string, unknown>;
      const threshold = typeof query.threshold === 'string' ? Number(query.threshold) : undefined;
      try {
        reply.send({
          values: await getOntologySimilarities(request.params.id, {
            limit: parseIntegerParam(query.limit, undefined),
            threshold: Number.isFinite(threshold) ? threshold : undefined,
          }),
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Ontology similarities failed',
          message: err instanceof Error ? err.message : 'Unknown ontology similarities error',
        });
      }
    }
  );

  app.post(
    '/api/admin/smw/ontology/clusterize',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        reply.send({ values: await clusterizeOntologyProperties(request.body ?? {}) });
      } catch (err) {
        reply.status(400).send({
          error: 'Ontology clusterization failed',
          message: err instanceof Error ? err.message : 'Unknown ontology clusterization error',
        });
      }
    }
  );

  app.post(
    '/api/admin/smw/ontology/classify-fragment',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      try {
        const embeddingConfig = await getEffectiveEmbeddingConfig();
        reply.send({
          values: await classifyOntologyFragment(request.body ?? {}),
          metadata: {
            embeddingProvider: embeddingConfig.provider,
            paidApiPossible: embeddingConfig.provider === 'openai_compatible',
            openAiUsed: embeddingConfig.provider === 'openai_compatible',
          },
        });
      } catch (err) {
        reply.status(400).send({
          error: 'Ontology fragment classification failed',
          message: err instanceof Error ? err.message : 'Unknown ontology classification error',
        });
      }
    }
  );

  app.post(
    '/api/admin/reindex',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      try {
        const data = await startSyncerReindex(
          await applyIndexingProfileToReindexRequest(parseReindexBody(request.body))
        );
        reply.status(202).send(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown syncer reindex error';
        const isProfileError = message.startsWith('Indexing profile');
        const existingStatus = extractSyncerReindexStatus(err);
        if (isSyncerAdminError(err) && err.statusCode === 409 && existingStatus) {
          reply.status(202).send({
            status: existingStatus,
            message,
          });
          return;
        }
        const statusCode = isProfileError
          ? 400
          : isSyncerAdminError(err) && err.statusCode >= 400 && err.statusCode < 500
            ? err.statusCode
            : 502;
        reply.status(statusCode).send({
          error: 'Unable to start syncer reindex',
          message,
        });
      }
    }
  );

  app.get(
    '/api/admin/reindex/status',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;

      try {
        const data = await getSyncerReindexStatus();
        const trustRecalculation = await maybeRecalculateTrustAfterReindex(data);
        const shouldIncludeTrustStatus =
          trustRecalculation.status !== 'skipped' ||
          trustRecalculation.reason !== 'reindex_not_completed';
        reply.send(
          shouldIncludeTrustStatus && isRecord(data)
            ? { ...data, trustRecalculation }
            : data
        );
      } catch (err) {
        reply.status(502).send({
          error: 'Unable to read syncer reindex status',
          message: err instanceof Error ? err.message : 'Unknown syncer reindex error',
        });
      }
    }
  );

  app.get(
    '/api/admin/audit-log',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      if (rejectNonAdmin(request as AuthenticatedRequest, reply)) return;
      const query = request.query as Record<string, unknown>;
      reply.send({ values: await listAdminAuditLog(parseIntegerParam(query.limit, 50)) });
    }
  );
}
