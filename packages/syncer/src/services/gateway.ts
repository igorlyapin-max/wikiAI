import { config } from '../config.js';

export interface TrustRecalculationNotification {
  pageId: number;
  reason: 'webhook-edit' | 'webhook-move' | 'webhook-protect';
}

export interface TrustRecalculationNotificationResult {
  status: 'ok' | 'error';
  url: string;
  httpStatus?: number;
  error?: string;
}

export interface IndexedSmwPropertiesResult {
  properties: string[];
  source: 'gateway' | 'config';
  error?: string;
}

export interface EffectiveEmbeddingConfigResult {
  provider: 'ollama' | 'openai_compatible';
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKeyConfigured: boolean;
}

export interface GatewayEmbeddingResult {
  vector: number[];
  provider: 'ollama' | 'openai_compatible';
  model: string;
  dimensions: number;
}

export interface ReindexLlmEnrichmentResult {
  summary: string;
  keywords: string[];
  model?: string;
  inputChars?: number;
}

export interface SearchIndexChunkNotification {
  id: number;
  text: string;
  chunkIndex: number;
  totalChunks: number;
  sourceType?: string;
  attachmentFilename?: string;
  mimeType?: string;
  processingMode?: string;
  contentType?: string;
}

export interface SearchIndexPageNotification {
  pageId: number;
  title: string;
  namespace: number;
  allowedGroups: string[];
  lastModified: string;
  replacePage?: boolean;
  indexTargets?: string[];
  colbertModel?: string;
  colbertCollection?: string;
  chunks: SearchIndexChunkNotification[];
}

export interface SearchIndexNotificationResult {
  status: 'ok' | 'error';
  url: string;
  httpStatus?: number;
  chunks?: number;
  error?: string;
}

export interface SemanticAutofillPatchItem {
  property: string;
  value: string;
  confidence: number;
  evidence?: string;
  expectedValue?: string;
}

export interface SemanticAutofillEvaluationResult {
  enabled: boolean;
  mode: 'suggest_only' | 'apply_empty';
  templates: string[];
  patch: SemanticAutofillPatchItem[];
  suggestions: Array<{
    property: string;
    value: string;
    confidence: number;
    evidence?: string;
    state: 'auto' | 'user' | 'suggested' | 'disabled';
  }>;
  lockedFields: Array<{
    property: string;
    state: 'auto' | 'user' | 'suggested' | 'disabled';
    reason?: string;
  }>;
  diagnostics: {
    skippedReason?: string;
    candidateCount: number;
    eligiblePropertyCount: number;
    llmCalled: boolean;
    error?: string;
  };
}

export interface SemanticAutofillEvaluationInput {
  pageId: number;
  title: string;
  namespace: number;
  revId?: number;
  editor?: {
    username?: string;
    userId?: number;
    serviceUser?: boolean;
  };
  summary?: string;
  content: string;
  semanticFacts: Record<string, string[]>;
}

export interface SemanticAutofillAppliedInput {
  pageId: number;
  title: string;
  revId?: number;
  fields: Array<{
    property: string;
    value: string;
    confidence?: number;
    evidence?: string;
  }>;
}

function buildGatewayUrl(path: string): string {
  const normalizedBase = config.gatewayBaseUrl.endsWith('/')
    ? config.gatewayBaseUrl
    : `${config.gatewayBaseUrl}/`;
  return new URL(path.replace(/^\/+/, ''), normalizedBase).toString();
}

async function sendGatewayJson(
  path: string,
  payload: unknown,
  timeoutMs = 15_000
): Promise<{
  ok: boolean;
  url: string;
  status: number;
  body: string;
}> {
  const url = buildGatewayUrl(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.syncerAdminToken) headers['x-wikiai-admin-token'] = config.syncerAdminToken;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    return {
      ok: response.ok,
      url,
      status: response.status,
      body: await response.text().catch(() => ''),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function notifyTrustRecalculation(
  notification: TrustRecalculationNotification
): Promise<TrustRecalculationNotificationResult> {
  try {
    const response = await sendGatewayJson('/api/internal/trust/recalculate-page', {
      pageId: notification.pageId,
      reason: notification.reason,
    });

    return {
      status: response.ok ? 'ok' : 'error',
      url: response.url,
      httpStatus: response.status,
      error: response.ok ? undefined : response.body,
    };
  } catch (err) {
    return {
      status: 'error',
      url: buildGatewayUrl('/api/internal/trust/recalculate-page'),
      error: err instanceof Error ? err.message : 'Unknown Gateway notification error',
    };
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  ));
}

export async function syncSearchIndexPage(
  notification: SearchIndexPageNotification
): Promise<SearchIndexNotificationResult> {
  try {
    const response = await sendGatewayJson('/api/internal/search-index/page', notification);
    let chunks: number | undefined;
    try {
      const body = JSON.parse(response.body) as { values?: { chunks?: unknown } };
      chunks = typeof body.values?.chunks === 'number' ? body.values.chunks : undefined;
    } catch {
      chunks = undefined;
    }

    return {
      status: response.ok ? 'ok' : 'error',
      url: response.url,
      httpStatus: response.status,
      chunks,
      error: response.ok ? undefined : response.body,
    };
  } catch (err) {
    return {
      status: 'error',
      url: buildGatewayUrl('/api/internal/search-index/page'),
      error: err instanceof Error ? err.message : 'Unknown Gateway search index error',
    };
  }
}

export async function deleteSearchIndexPage(pageId: number): Promise<SearchIndexNotificationResult> {
  try {
    const response = await sendGatewayJson('/api/internal/search-index/delete-page', { pageId });
    return {
      status: response.ok ? 'ok' : 'error',
      url: response.url,
      httpStatus: response.status,
      chunks: 0,
      error: response.ok ? undefined : response.body,
    };
  } catch (err) {
    return {
      status: 'error',
      url: buildGatewayUrl('/api/internal/search-index/delete-page'),
      error: err instanceof Error ? err.message : 'Unknown Gateway search index error',
    };
  }
}

async function fetchGatewayJson<T>(path: string, timeoutMs = 15_000): Promise<T> {
  const url = buildGatewayUrl(path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (config.syncerAdminToken) headers['x-wikiai-admin-token'] = config.syncerAdminToken;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Gateway HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchEffectiveEmbeddingConfig(): Promise<EffectiveEmbeddingConfigResult> {
  const body = await fetchGatewayJson<{ values?: EffectiveEmbeddingConfigResult }>('/api/internal/embedding/config');
  if (!body.values) throw new Error('Gateway embedding config response is empty');
  return body.values;
}

export async function fetchIndexingProfiles(): Promise<unknown[]> {
  const body = await fetchGatewayJson<{ values?: unknown }>('/api/internal/indexing-profiles');
  return Array.isArray(body.values) ? body.values : [];
}

export async function fetchGatewayEmbedding(text: string): Promise<GatewayEmbeddingResult> {
  const response = await sendGatewayJson('/api/internal/embedding/vector', { text }, 60_000);
  if (!response.ok) {
    throw new Error(`Gateway embedding error ${response.status}: ${response.body}`);
  }
  const body = JSON.parse(response.body) as { values?: GatewayEmbeddingResult };
  if (!body.values || !Array.isArray(body.values.vector)) {
    throw new Error('Gateway embedding response is empty');
  }
  return body.values;
}

export async function enrichPageForReindex(input: {
  title: string;
  text: string;
  model?: string;
  maxChars?: number;
}): Promise<ReindexLlmEnrichmentResult> {
  const response = await sendGatewayJson('/api/internal/reindex/llm-enrich', input, 120_000);
  if (!response.ok) {
    throw new Error(`Gateway LLM enrichment error ${response.status}: ${response.body}`);
  }
  const body = JSON.parse(response.body) as { values?: ReindexLlmEnrichmentResult };
  if (!body.values || typeof body.values.summary !== 'string') {
    throw new Error('Gateway LLM enrichment response is empty');
  }
  return {
    summary: body.values.summary,
    keywords: Array.isArray(body.values.keywords) ? body.values.keywords : [],
    model: body.values.model,
    inputChars: body.values.inputChars,
  };
}

export async function evaluateSemanticAutofill(
  input: SemanticAutofillEvaluationInput
): Promise<SemanticAutofillEvaluationResult> {
  const response = await sendGatewayJson('/api/internal/smw/autofill/evaluate', input, 120_000);
  if (!response.ok) {
    throw new Error(`Gateway semantic autofill error ${response.status}: ${response.body}`);
  }
  const body = JSON.parse(response.body) as { values?: SemanticAutofillEvaluationResult };
  if (!body.values || !Array.isArray(body.values.patch)) {
    throw new Error('Gateway semantic autofill response is empty');
  }
  return body.values;
}

export async function recordSemanticAutofillApplied(
  input: SemanticAutofillAppliedInput
): Promise<{ status: 'ok' | 'error'; url: string; httpStatus?: number; error?: string }> {
  try {
    const response = await sendGatewayJson('/api/internal/smw/autofill/applied', input, 15_000);
    return {
      status: response.ok ? 'ok' : 'error',
      url: response.url,
      httpStatus: response.status,
      error: response.ok ? undefined : response.body,
    };
  } catch (err) {
    return {
      status: 'error',
      url: buildGatewayUrl('/api/internal/smw/autofill/applied'),
      error: err instanceof Error ? err.message : 'Unknown Gateway semantic autofill state error',
    };
  }
}

export async function fetchIndexedSmwProperties(): Promise<IndexedSmwPropertiesResult> {
  const url = buildGatewayUrl('/api/internal/smw/indexed-properties');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.syncerAdminToken) headers['x-wikiai-admin-token'] = config.syncerAdminToken;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as { values?: unknown };
    if (!response.ok || !Array.isArray(body.values)) {
      return {
        properties: config.smwSyncProperties,
        source: 'config',
        error: response.ok ? 'Gateway returned invalid indexed SMW properties' : `Gateway HTTP ${response.status}`,
      };
    }
    const properties = normalizeStringArray(body.values);
    return { properties, source: 'gateway' };
  } catch (err) {
    return {
      properties: config.smwSyncProperties,
      source: 'config',
      error: err instanceof Error ? err.message : 'Unknown Gateway indexed properties error',
    };
  } finally {
    clearTimeout(timeout);
  }
}
