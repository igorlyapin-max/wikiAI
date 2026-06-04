import Fastify from 'fastify';
import { config } from './config.js';
import {
  fetchPageContent,
  fetchSemanticFacts,
  editPageContent,
  getMediaWikiServiceAuthStatus,
  semanticFactsToText,
  testMediaWikiServiceLogin,
} from './services/mediawiki.js';
import { splitText } from './services/chunker.js';
import { upsertChunks, upsertCmdbDynamicSnapshotChunks } from './services/qdrant.js';
import { getAllowedGroups } from './services/acl.js';
import {
  deleteSearchIndexPage,
  evaluateSemanticAutofill,
  fetchIndexedSmwProperties,
  notifyTrustRecalculation,
  recordSemanticAutofillApplied,
} from './services/gateway.js';
import { getWebhookTitle, normalizeEvent, WebhookBody } from './services/webhook.js';
import { getReindexJobStatus, startReindexJob } from './services/reindex-job.js';
import { ReindexOptions } from './services/reindex.js';
import { applySemanticAutofillPatch } from './services/semantic-autofill.js';
import { qdrant } from './services/qdrant.js';
import {
  createFastifyLoggerOptions,
  diagnosticStartupFields,
} from './services/logging.js';
import { registerMetrics } from './services/metrics.js';
import { extractCmdbDynamicSources, fetchCmdbDynamicSnapshotChunks } from './services/cmdbdynamicpages.js';

const app = Fastify({ logger: createFastifyLoggerOptions() });

registerMetrics(app, 'syncer');

app.addHook('onReady', async () => {
  app.log.info(
    {
      event: 'syncer.ready',
      ...(config.debugDiagnosticsEnabled ? diagnosticStartupFields() : {}),
    },
    'Syncer ready'
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseNamespaceList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const namespaces = value.filter((item): item is number => Number.isInteger(item) && item >= 0);
  return namespaces.length > 0 ? namespaces : undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseTextFilters(value: unknown): { include: string[]; exclude: string[] } | undefined {
  if (!isRecord(value)) return undefined;
  return {
    include: parseStringList(value.include) ?? [],
    exclude: parseStringList(value.exclude) ?? [],
  };
}

function parseNamespaceAcl(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([namespace, groups]) => /^\d+$/.test(namespace) && Array.isArray(groups))
    .map(([namespace, groups]) => [
      namespace,
      (groups as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    ] as const)
    .filter(([, groups]) => groups.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseReindexOptions(body: unknown): ReindexOptions {
  if (!isRecord(body)) return {};
  return {
    profileId: typeof body.profileId === 'string' && body.profileId.trim() ? body.profileId.trim() : undefined,
    indexTargets: parseStringList(body.indexTargets),
    source: body.source === 'qdrant_payload' ? 'qdrant_payload' : body.source === 'mediawiki' ? 'mediawiki' : undefined,
    colbertModel: typeof body.colbertModel === 'string' && body.colbertModel.trim()
      ? body.colbertModel.trim()
      : undefined,
    colbertCollection: typeof body.colbertCollection === 'string' && body.colbertCollection.trim()
      ? body.colbertCollection.trim()
      : undefined,
    attachmentsEnabled: parseBoolean(body.attachmentsEnabled),
    semanticFactsEnabled: parseBoolean(body.semanticFactsEnabled),
    smwProperties: parseStringList(body.smwProperties),
    namespaces: parseNamespaceList(body.namespaces),
    namespaceAcl: parseNamespaceAcl(body.namespaceAcl),
    titleFilters: parseTextFilters(body.titleFilters),
    categoryFilters: parseTextFilters(body.categoryFilters),
    documentPolicyId: typeof body.documentPolicyId === 'string' && body.documentPolicyId.trim()
      ? body.documentPolicyId.trim()
      : undefined,
    maxPages: parsePositiveInteger(body.maxPages),
    chunkSize: parsePositiveInteger(body.chunkSize),
    chunkOverlap: parseNonNegativeInteger(body.chunkOverlap),
    chunkSeparators: parseStringList(body.chunkSeparators),
    dryRun: parseBoolean(body.dryRun),
    llmEnrichmentEnabled: parseBoolean(body.llmEnrichmentEnabled),
    llmEnrichmentModel: typeof body.llmEnrichmentModel === 'string' && body.llmEnrichmentModel.trim()
      ? body.llmEnrichmentModel.trim()
      : undefined,
    llmEnrichmentMaxChars: parsePositiveInteger(body.llmEnrichmentMaxChars),
    cmdbDynamicPagesEnabled: parseBoolean(body.cmdbDynamicPagesEnabled),
  };
}

function hasAdminAccess(headers: Record<string, unknown>): boolean {
  if (!config.syncerAdminToken) return config.allowUnprotectedSyncerAdmin;
  return headers['x-wikiai-admin-token'] === config.syncerAdminToken;
}

interface HealthCheck {
  status: string;
  latencyMs: number;
  error?: string;
}

interface HealthStatus {
  status: 'healthy' | 'degraded';
  checks: Record<string, HealthCheck>;
}

function buildServiceUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ''), normalizedBase).toString();
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${config.healthCheckTimeoutMs}ms`)), config.healthCheckTimeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.healthCheckTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function runCheck(name: string, operation: () => Promise<void>): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await withTimeout(operation(), name);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

async function getReadinessStatus(): Promise<HealthStatus> {
  const checks: Record<string, HealthCheck> = {};

  checks.qdrant = await runCheck('qdrant', async () => {
    await qdrant.getCollections();
  });

  checks.gateway = await runCheck('gateway', async () => {
    const res = await fetchWithTimeout(buildServiceUrl(config.gatewayBaseUrl, '/live'));
    if (!res.ok) throw new Error(`Gateway liveness failed with HTTP ${res.status}`);
  });

  checks.mediawiki = await runCheck('mediawiki', async () => {
    const url = new URL(config.mwApiPath, config.mwBaseUrl);
    url.searchParams.set('action', 'query');
    url.searchParams.set('meta', 'siteinfo');
    url.searchParams.set('format', 'json');
    const res = await fetchWithTimeout(url.toString(), {
      headers: { 'User-Agent': 'WikiAI-Syncer/0.1' },
    });
    if (!res.ok) throw new Error(`MediaWiki API failed with HTTP ${res.status}`);
  });

  const allOk = Object.values(checks).every((check) => check.status === 'ok');
  return {
    status: allOk ? 'healthy' : 'degraded',
    checks,
  };
}

function isWikiAiServiceEdit(body: WebhookBody): boolean {
  const summary = typeof body.summary === 'string' ? body.summary : '';
  const user = typeof body.user === 'string' ? body.user : '';
  return Boolean(
    summary.startsWith('WikiAI semantic autofill') ||
    (config.mwServiceUsername && user === config.mwServiceUsername)
  );
}

app.post('/webhook/page', async (request, reply) => {
  const body = request.body as WebhookBody;
  const event = normalizeEvent(body.event);
  const title = getWebhookTitle(body);

  if (!event) {
    reply.status(400).send({ error: 'Unknown event' });
    return;
  }

  request.log.info({ event: 'syncer.webhook_received', webhookEvent: event, title }, 'Webhook received');

  if (event === 'delete') {
    // Delete all chunks for page
    await qdrant.delete(config.qdrantCollection, {
      filter: { must: [{ key: 'page_id', match: { value: body.page_id } }] },
    });
    const searchIndexSync = await deleteSearchIndexPage(body.page_id);
    reply.send({ status: 'deleted', page_id: body.page_id, search_index_sync: searchIndexSync });
    return;
  }

  if (!title) {
    reply.status(400).send({ error: 'Missing page title' });
    return;
  }

  if (event === 'edit' || event === 'move' || event === 'protect') {
    const page = await fetchPageContent(title);
    if (!page || !page.content) {
      reply.status(404).send({ error: 'Page not found or empty' });
      return;
    }

    const indexedSmwProperties = config.smwSyncEnabled ? await fetchIndexedSmwProperties() : undefined;
    const semanticFacts = config.smwSyncEnabled
      ? await fetchSemanticFacts(page.title, indexedSmwProperties?.properties)
      : {};
    const semanticText = semanticFactsToText(semanticFacts);
    const indexText = semanticText ? `${semanticText}\n\n${page.content}` : page.content;
    const chunks = splitText(indexText);
    const allowedGroups = getAllowedGroups(page.ns);
    const searchIndexSync = await upsertChunks(
      page.pageid,
      page.title,
      page.ns,
      chunks,
      allowedGroups,
      page.lastModified ?? body.timestamp,
      semanticFacts
    );
    let dynamicBlocks: unknown;
    if (config.cmdbDynamicPagesEnabled) {
      try {
        const sources = extractCmdbDynamicSources(page.content, page.title);
        const snapshotChunks = await fetchCmdbDynamicSnapshotChunks(sources);
        const expandedSnapshotChunks = snapshotChunks.flatMap((snapshot) =>
          splitText(snapshot.text).map((chunk) => ({ ...snapshot, text: chunk.text }))
        );
        const syncResult = expandedSnapshotChunks.length > 0
          ? await upsertCmdbDynamicSnapshotChunks(
            page.pageid,
            page.title,
            page.ns,
            expandedSnapshotChunks,
            allowedGroups,
            page.lastModified ?? body.timestamp
          )
          : undefined;
        dynamicBlocks = {
          matched: sources.length,
          snapshotHits: snapshotChunks.filter((chunk) => chunk.snapshotFound).length,
          snapshotMisses: snapshotChunks.filter((chunk) => !chunk.snapshotFound && chunk.status !== 'error').length,
          snapshotErrors: snapshotChunks.filter((chunk) => chunk.status === 'error').length,
          chunks: expandedSnapshotChunks.length,
          searchIndexSync: syncResult,
        };
      } catch (err) {
        dynamicBlocks = {
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown cmdbdynamicpages indexing error',
        };
      }
    }
    const trustRecalculation = await notifyTrustRecalculation({
      pageId: page.pageid,
      reason: `webhook-${event}`,
    });
    let semanticAutofill: unknown;

    if (event === 'edit') {
      try {
        const serviceEdit = isWikiAiServiceEdit(body);
        const evaluation = await evaluateSemanticAutofill({
          pageId: page.pageid,
          title: page.title,
          namespace: page.ns,
          revId: body.rev_id,
          editor: {
            username: body.user,
            userId: body.user_id,
            serviceUser: serviceEdit,
          },
          summary: body.summary,
          content: page.content,
          semanticFacts,
        });

        semanticAutofill = evaluation;
        if (!serviceEdit && evaluation.mode === 'apply_empty' && evaluation.patch.length > 0) {
          const patch = applySemanticAutofillPatch(page.content, evaluation.patch, evaluation.templates);
          semanticAutofill = { ...evaluation, applied: patch.applied, skippedPatch: patch.skipped };

          if (patch.changed) {
            const edit = await editPageContent(
              page.title,
              patch.content,
              `WikiAI semantic autofill: ${patch.applied.map((field) => field.property).join(', ')}`
            );
            const appliedState = await recordSemanticAutofillApplied({
              pageId: page.pageid,
              title: page.title,
              revId: edit.newRevisionId,
              fields: patch.applied,
            });
            semanticAutofill = {
              ...evaluation,
              applied: patch.applied,
              skippedPatch: patch.skipped,
              edit,
              appliedState,
            };
          }
        }
      } catch (err) {
        semanticAutofill = {
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown semantic autofill error',
        };
      }
    }

    reply.send({
      status: 'indexed',
      page_id: page.pageid,
      title: page.title,
      chunks: chunks.length,
      allowed_groups: allowedGroups,
      semantic_facts: Object.keys(semanticFacts).length,
      smw_properties_source: indexedSmwProperties?.source,
      smw_properties_error: indexedSmwProperties?.error,
      search_index_sync: searchIndexSync,
      dynamic_blocks: dynamicBlocks,
      trust_recalculation: trustRecalculation,
      semantic_autofill: semanticAutofill,
    });
    return;
  }

  reply.status(400).send({ error: 'Unknown event' });
});

app.post('/admin/reindex', async (request, reply) => {
  if (!hasAdminAccess(request.headers)) {
    reply.status(401).send({ error: 'Invalid syncer admin token' });
    return;
  }

  try {
    const status = await startReindexJob(parseReindexOptions(request.body));
    reply.status(202).send({ status });
  } catch (err) {
    reply.status(409).send({
      error: 'Unable to start reindex',
      message: err instanceof Error ? err.message : 'Unknown reindex error',
      status: getReindexJobStatus(),
    });
  }
});

app.get('/admin/reindex/status', async (request, reply) => {
  if (!hasAdminAccess(request.headers)) {
    reply.status(401).send({ error: 'Invalid syncer admin token' });
    return;
  }

  reply.send({ status: getReindexJobStatus() });
});

app.get('/admin/mediawiki-service-auth/status', async (request, reply) => {
  if (!hasAdminAccess(request.headers)) {
    reply.status(401).send({ error: 'Invalid syncer admin token' });
    return;
  }

  reply.send({ auth: getMediaWikiServiceAuthStatus() });
});

app.post('/admin/mediawiki-service-auth/test', async (request, reply) => {
  if (!hasAdminAccess(request.headers)) {
    reply.status(401).send({ error: 'Invalid syncer admin token' });
    return;
  }

  reply.send(await testMediaWikiServiceLogin());
});

app.get('/live', async () => ({ status: 'ok', service: 'syncer' }));

app.get('/ready', async (_request, reply) => {
  const health = await getReadinessStatus();
  reply.status(health.status === 'healthy' ? 200 : 503).send(health);
});

app.get('/health', async (_request, reply) => {
  const health = await getReadinessStatus();
  reply.status(health.status === 'healthy' ? 200 : 503).send(health);
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.syncerPort, host: '0.0.0.0' });
    app.log.info(
      { event: 'syncer.listen', port: config.syncerPort, host: '0.0.0.0' },
      `Syncer listening on http://0.0.0.0:${config.syncerPort}`
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
