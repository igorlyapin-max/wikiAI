import {
  getEffectiveOpenSearchConfig,
  type EffectiveOpenSearchConfig,
  type RagAdminConfig,
} from './admin-platform-config.js';
import type {
  LexicalSearchChunk,
  SearchIndexPageInput,
  SearchIndexWriteResult,
} from './search-index.js';
import { logOperationalError, logOperationalEvent } from './logging.js';

export interface OpenSearchStatus {
  status: 'ok' | 'disabled' | 'error';
  ready: boolean;
  enabled: boolean;
  url: string;
  indexName: string;
  authConfigured: boolean;
  analyzer: string;
  candidateLimit: number;
  timeoutMs: number;
  tlsRejectUnauthorized: boolean;
  documentCount?: number;
  sourceTypeCounts?: Array<{ sourceType: string; count: number }>;
  attachmentDocumentCount?: number;
  attachmentFilenames?: Array<{ filename: string; count: number }>;
  error?: string;
}

export interface OpenSearchAttachmentDiagnostics {
  status: 'ok' | 'disabled' | 'error';
  ready: boolean;
  enabled: boolean;
  indexName: string;
  filename: string;
  chunks: number;
  found: boolean;
  samples: Array<{
    id: number;
    pageId: number;
    title: string;
    sourceType?: string;
    attachmentFilename?: string;
    attachmentMime?: string;
    attachmentProcessingMode?: string;
    chunkIndex?: number;
    totalChunks?: number;
  }>;
  error?: string;
}

export interface OpenSearchPageSetEntry {
  pageId: number;
  title: string;
  docs: number;
  sourceType?: string;
  attachmentFilename?: string;
}

export interface OpenSearchPageSet {
  status: 'ok' | 'disabled' | 'error';
  ready: boolean;
  enabled: boolean;
  indexName: string;
  pages: OpenSearchPageSetEntry[];
  totalPages: number;
  limit: number;
  truncated: boolean;
  error?: string;
}

export interface OpenSearchPageSetOptions {
  namespaces?: number[];
}

export interface OpenSearchAnalyzeResult {
  status: 'ok' | 'disabled' | 'error';
  query: string;
  analyzer: string;
  tokens: string[];
  latencyMs: number;
  error?: string;
}

export interface OpenSearchSearchDiagnostics {
  enabled: boolean;
  ready: boolean;
  indexName: string;
  analyzer: string;
  rawHits: number;
  candidates: number;
  analyzedTerms: string[];
  removedTerms: string[];
  latencyMs: number;
  highlightsAvailable: boolean;
  error?: string;
}

export interface OpenSearchSearchResult {
  chunks: LexicalSearchChunk[];
  diagnostics: OpenSearchSearchDiagnostics;
}

type JsonRecord = Record<string, unknown>;

const OPENSEARCH_URL_REQUIRED_ERROR = 'OpenSearch URL is required when OpenSearch is enabled';
const OPENSEARCH_URL_INVALID_ERROR = 'OpenSearch URL must be a valid HTTP(S) URL when OpenSearch is enabled';

function getEnabledConfigError(config: EffectiveOpenSearchConfig): string | undefined {
  const value = config.baseUrl.trim();
  if (!value) return OPENSEARCH_URL_REQUIRED_ERROR;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? undefined
      : OPENSEARCH_URL_INVALID_ERROR;
  } catch {
    return OPENSEARCH_URL_INVALID_ERROR;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseBaseUrl(value: string): { url: string; username?: string; password?: string } {
  try {
    const parsed = new URL(value);
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    parsed.username = '';
    parsed.password = '';
    return { url: parsed.toString().replace(/\/+$/, ''), username, password };
  } catch {
    return { url: normalizeBaseUrl(value) };
  }
}

function buildUrl(config: Pick<EffectiveOpenSearchConfig, 'baseUrl'>, path: string): string {
  return `${parseBaseUrl(config.baseUrl).url}/${path.replace(/^\/+/, '')}`;
}

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

function buildHeaders(config: EffectiveOpenSearchConfig, contentType = 'application/json'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  const parsedBase = parseBaseUrl(config.baseUrl);
  const username = config.username ?? parsedBase.username;
  const password = config.password ?? parsedBase.password;
  if (config.apiKey) {
    headers.Authorization = `ApiKey ${config.apiKey}`;
  } else if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return headers;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson<T>(
  config: EffectiveOpenSearchConfig,
  path: string,
  options: RequestInit = {}
): Promise<{ response: Response; body: T | undefined }> {
  const response = await fetchWithTimeout(buildUrl(config, path), {
    ...options,
    headers: {
      ...buildHeaders(config),
      ...(options.headers as Record<string, string> | undefined),
    },
  }, config.timeoutMs);
  const text = typeof response.text === 'function'
    ? await response.text().catch(() => '')
    : '';
  const body = text ? JSON.parse(text) as T : undefined;
  return { response, body };
}

function localAnalyze(query: string): string[] {
  return query
    .toLocaleLowerCase('ru')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => term.trim())
    .filter((term) => term.length >= 2) ?? [];
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

function normalizePageSetLimit(limit = 500): number {
  if (!Number.isFinite(limit)) return 500;
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

function normalizeNamespaceFilter(namespaces: number[] | undefined): number[] {
  if (!Array.isArray(namespaces)) return [];
  return Array.from(new Set(
    namespaces.filter((namespace) => Number.isInteger(namespace) && namespace >= 0)
  )).sort((left, right) => left - right);
}

function indexName(config: Pick<EffectiveOpenSearchConfig, 'indexName'>): string {
  return encodeURIComponent(config.indexName);
}

async function ensureOpenSearchIndex(config: EffectiveOpenSearchConfig): Promise<void> {
  const head = await fetchWithTimeout(buildUrl(config, `/${indexName(config)}`), {
    method: 'HEAD',
    headers: buildHeaders(config),
  }, config.timeoutMs);
  if (head.ok) return;
  if (head.status !== 404) {
    throw new Error(`OpenSearch index check failed with HTTP ${head.status}`);
  }

  const mapping = {
    mappings: {
      dynamic: false,
      properties: {
        chunkId: { type: 'long' },
        pageId: { type: 'long' },
        title: { type: 'text', analyzer: config.analyzer },
        namespace: { type: 'integer' },
        text: { type: 'text', analyzer: config.analyzer },
        allowedGroups: { type: 'keyword' },
        sourceType: { type: 'keyword' },
        attachmentFilename: { type: 'keyword' },
        attachmentMime: { type: 'keyword' },
        attachmentProcessingMode: { type: 'keyword' },
        contentType: { type: 'keyword' },
        chunkIndex: { type: 'integer' },
        totalChunks: { type: 'integer' },
        lastModified: { type: 'date', ignore_malformed: true },
        updatedAt: { type: 'date' },
      },
    },
  };

  const created = await requestJson<JsonRecord>(config, `/${indexName(config)}`, {
    method: 'PUT',
    body: JSON.stringify(mapping),
  });
  if (!created.response.ok) {
    throw new Error(`OpenSearch index creation failed with HTTP ${created.response.status}`);
  }
}

function chunkDoc(input: SearchIndexPageInput, chunk: SearchIndexPageInput['chunks'][number], now: string): JsonRecord {
  return {
    chunkId: chunk.id,
    pageId: input.pageId,
    title: input.title,
    namespace: input.namespace,
    text: chunk.text,
    allowedGroups: input.allowedGroups.length > 0 ? input.allowedGroups : ['*'],
    sourceType: chunk.sourceType?.trim() || 'page',
    attachmentFilename: chunk.attachmentFilename?.trim() || undefined,
    attachmentMime: chunk.mimeType?.trim() || undefined,
    attachmentProcessingMode: chunk.processingMode?.trim() || undefined,
    contentType: chunk.contentType?.trim() || undefined,
    chunkIndex: chunk.chunkIndex ?? 0,
    totalChunks: chunk.totalChunks ?? input.chunks.length,
    lastModified: input.lastModified,
    updatedAt: now,
  };
}

async function deletePageDocs(config: EffectiveOpenSearchConfig, pageId: number): Promise<void> {
  const { response } = await requestJson<JsonRecord>(config, `/${indexName(config)}/_delete_by_query?conflicts=proceed&refresh=true`, {
    method: 'POST',
    body: JSON.stringify({
      query: {
        term: { pageId },
      },
    }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenSearch page delete failed with HTTP ${response.status}`);
  }
}

export async function upsertOpenSearchPage(input: SearchIndexPageInput): Promise<SearchIndexWriteResult | {
  status: 'disabled';
  pageId: number;
  replacedPage: boolean;
  chunks: number;
}> {
  const config = await getEffectiveOpenSearchConfig();
  if (!config.enabled) {
    return { status: 'disabled', pageId: input.pageId, replacedPage: input.replacePage !== false, chunks: 0 };
  }
  const configError = getEnabledConfigError(config);
  if (configError) throw new Error(configError);

  await ensureOpenSearchIndex(config);
  if (input.replacePage !== false) {
    await deletePageDocs(config, input.pageId);
  }

  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const chunk of input.chunks) {
    lines.push(JSON.stringify({ index: { _index: config.indexName, _id: String(chunk.id) } }));
    lines.push(JSON.stringify(chunkDoc(input, chunk, now)));
  }
  if (lines.length === 0) {
    return { status: 'ok', pageId: input.pageId, replacedPage: input.replacePage !== false, chunks: 0 };
  }

  const response = await fetchWithTimeout(buildUrl(config, '/_bulk?refresh=true'), {
    method: 'POST',
    headers: buildHeaders(config, 'application/x-ndjson'),
    body: `${lines.join('\n')}\n`,
  }, config.timeoutMs);
  const body = await response.json().catch(() => ({})) as { errors?: boolean };
  if (!response.ok || body.errors) {
    throw new Error(`OpenSearch bulk update failed with HTTP ${response.status}`);
  }
  logOperationalEvent('info', 'opensearch.index.page_upserted', {
    pageId: input.pageId,
    chunks: input.chunks.length,
    indexName: config.indexName,
  });
  return { status: 'ok', pageId: input.pageId, replacedPage: input.replacePage !== false, chunks: input.chunks.length };
}

export async function deleteOpenSearchPage(pageId: number): Promise<SearchIndexWriteResult | {
  status: 'disabled';
  pageId: number;
  replacedPage: boolean;
  chunks: number;
}> {
  const config = await getEffectiveOpenSearchConfig();
  if (!config.enabled) {
    return { status: 'disabled', pageId, replacedPage: true, chunks: 0 };
  }
  const configError = getEnabledConfigError(config);
  if (configError) throw new Error(configError);
  await deletePageDocs(config, pageId);
  return { status: 'ok', pageId, replacedPage: true, chunks: 0 };
}

function hitSource(hit: unknown): JsonRecord {
  if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return {};
  const source = (hit as { _source?: unknown })._source;
  return source && typeof source === 'object' && !Array.isArray(source) ? source as JsonRecord : {};
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return ['*'];
  const groups = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return groups.length > 0 ? groups : ['*'];
}

function hitToChunk(hit: unknown, lexicalRank: number, queryTerms: string[]): LexicalSearchChunk {
  const source = hitSource(hit);
  return {
    id: readNumber(source.chunkId),
    pageId: readNumber(source.pageId),
    title: typeof source.title === 'string' ? source.title : '',
    text: typeof source.text === 'string' ? source.text : '',
    namespace: readNumber(source.namespace),
    allowedGroups: readStringArray(source.allowedGroups),
    score: 0,
    sourceType: typeof source.sourceType === 'string' ? source.sourceType : undefined,
    attachmentFilename: typeof source.attachmentFilename === 'string' ? source.attachmentFilename : undefined,
    attachmentMime: typeof source.attachmentMime === 'string' ? source.attachmentMime : undefined,
    attachmentProcessingMode: typeof source.attachmentProcessingMode === 'string' ? source.attachmentProcessingMode : undefined,
    contentType: typeof source.contentType === 'string' ? source.contentType : undefined,
    chunkIndex: readNumber(source.chunkIndex),
    totalChunks: readNumber(source.totalChunks, 1),
    lastModified: typeof source.lastModified === 'string' ? source.lastModified : undefined,
    lexicalRank,
    lexicalMatchedTerms: queryTerms,
    lexicalMatchedTermCount: queryTerms.length,
  };
}

function totalHits(body: JsonRecord | undefined): number {
  const hits = body?.hits;
  if (!hits || typeof hits !== 'object' || Array.isArray(hits)) return 0;
  const total = (hits as { total?: unknown }).total;
  if (typeof total === 'number') return total;
  if (total && typeof total === 'object' && !Array.isArray(total)) {
    return readNumber((total as { value?: unknown }).value);
  }
  return 0;
}

function hitArray(body: JsonRecord | undefined): unknown[] {
  const hits = body?.hits;
  if (!hits || typeof hits !== 'object' || Array.isArray(hits)) return [];
  const items = (hits as { hits?: unknown }).hits;
  return Array.isArray(items) ? items : [];
}

function aggregationBuckets(body: JsonRecord | undefined, name: string): Array<{ key: unknown; doc_count?: unknown }> {
  const aggregations = body?.aggregations;
  if (!aggregations || typeof aggregations !== 'object' || Array.isArray(aggregations)) return [];
  const aggregation = (aggregations as Record<string, unknown>)[name];
  if (!aggregation || typeof aggregation !== 'object' || Array.isArray(aggregation)) return [];
  const buckets = (aggregation as { buckets?: unknown }).buckets;
  return Array.isArray(buckets) ? buckets as Array<{ key: unknown; doc_count?: unknown }> : [];
}

function filterDocCount(body: JsonRecord | undefined, name: string): number {
  const aggregations = body?.aggregations;
  if (!aggregations || typeof aggregations !== 'object' || Array.isArray(aggregations)) return 0;
  const aggregation = (aggregations as Record<string, unknown>)[name];
  if (!aggregation || typeof aggregation !== 'object' || Array.isArray(aggregation)) return 0;
  return readNumber((aggregation as { doc_count?: unknown }).doc_count);
}

function openSearchAttachmentSample(hit: unknown): OpenSearchAttachmentDiagnostics['samples'][number] {
  const source = hitSource(hit);
  return {
    id: readNumber(source.chunkId),
    pageId: readNumber(source.pageId),
    title: typeof source.title === 'string' ? source.title : '',
    sourceType: typeof source.sourceType === 'string' ? source.sourceType : undefined,
    attachmentFilename: typeof source.attachmentFilename === 'string' ? source.attachmentFilename : undefined,
    attachmentMime: typeof source.attachmentMime === 'string' ? source.attachmentMime : undefined,
    attachmentProcessingMode: typeof source.attachmentProcessingMode === 'string' ? source.attachmentProcessingMode : undefined,
    chunkIndex: typeof source.chunkIndex === 'number' ? source.chunkIndex : undefined,
    totalChunks: typeof source.totalChunks === 'number' ? source.totalChunks : undefined,
  };
}

function attachmentFilenameTerms(query: string): string[] {
  const matches = query.match(/[^\s"'<>]+?\.(?:pptx|ppt|docx|doc|xlsx|xls|pdf|txt|odt|ods|odp|png|jpe?g|webp|zip|7z|mp3|wav|mpeg)/giu) ?? [];
  const byLower = new Map<string, string>();
  for (const match of matches) {
    const normalized = match.replace(/[),.;:!?]+$/u, '').trim();
    if (normalized) byLower.set(normalized.toLocaleLowerCase('ru'), normalized);
  }
  return Array.from(byLower.values()).slice(0, 5);
}

function searchBody(query: string, limit: number, config: EffectiveOpenSearchConfig): JsonRecord {
  const fields = [
    `title^${config.titleBoost}`,
    `text^${config.textBoost}`,
  ];
  const filenameTerms = attachmentFilenameTerms(query);
  return {
    size: limit,
    track_total_hits: true,
    _source: [
      'chunkId',
      'pageId',
      'title',
      'namespace',
      'text',
      'allowedGroups',
      'sourceType',
      'attachmentFilename',
      'attachmentMime',
      'attachmentProcessingMode',
      'contentType',
      'chunkIndex',
      'totalChunks',
      'lastModified',
    ],
    query: {
      bool: {
        should: [
          {
            multi_match: {
              query,
              fields,
              type: 'best_fields',
              operator: 'or',
              analyzer: config.analyzer,
            },
          },
          {
            match_phrase: {
              text: {
                query,
                boost: 1.5,
              },
            },
          },
          ...(config.fuzzyEnabled ? [{
            multi_match: {
              query,
              fields,
              fuzziness: 'AUTO',
              prefix_length: 1,
              operator: 'or',
              analyzer: config.analyzer,
            },
          }] : []),
          ...filenameTerms.map((filename) => ({
            term: {
              attachmentFilename: {
                value: filename,
                boost: 8,
                case_insensitive: true,
              },
            },
          })),
        ],
        minimum_should_match: 1,
      },
    },
    ...(config.highlightEnabled ? {
      highlight: {
        fields: {
          title: {},
          text: { fragment_size: 160, number_of_fragments: 2 },
        },
      },
    } : {}),
  };
}

function openSearchPageSetTopHit(bucket: Record<string, unknown>): JsonRecord {
  const topDoc = bucket.topDoc;
  if (!topDoc || typeof topDoc !== 'object' || Array.isArray(topDoc)) return {};
  const hits = (topDoc as { hits?: unknown }).hits;
  if (!hits || typeof hits !== 'object' || Array.isArray(hits)) return {};
  const items = (hits as { hits?: unknown }).hits;
  if (!Array.isArray(items) || items.length === 0) return {};
  return hitSource(items[0]);
}

function openSearchPageSetEntry(bucket: { key: unknown; doc_count?: unknown }): OpenSearchPageSetEntry | undefined {
  const pageId = readNumber(bucket.key, Number.NaN);
  if (!Number.isFinite(pageId)) return undefined;
  const source = openSearchPageSetTopHit(bucket as Record<string, unknown>);
  return {
    pageId,
    title: typeof source.title === 'string' ? source.title : '',
    docs: readNumber(bucket.doc_count),
    sourceType: typeof source.sourceType === 'string' ? source.sourceType : undefined,
    attachmentFilename: typeof source.attachmentFilename === 'string' ? source.attachmentFilename : undefined,
  };
}

export async function analyzeOpenSearchQuery(query: string): Promise<OpenSearchAnalyzeResult> {
  const startedAt = Date.now();
  const config = await getEffectiveOpenSearchConfig();
  if (!config.enabled) {
    return {
      status: 'disabled',
      query,
      analyzer: config.analyzer,
      tokens: localAnalyze(query),
      latencyMs: Date.now() - startedAt,
      error: 'OpenSearch is disabled',
    };
  }
  const configError = getEnabledConfigError(config);
  if (configError) {
    return {
      status: 'error',
      query,
      analyzer: config.analyzer,
      tokens: localAnalyze(query),
      latencyMs: Date.now() - startedAt,
      error: configError,
    };
  }
  try {
    const { response, body } = await requestJson<{ tokens?: Array<{ token?: unknown }> }>(config, `/${indexName(config)}/_analyze`, {
      method: 'POST',
      body: JSON.stringify({ analyzer: config.analyzer, text: query }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      status: 'ok',
      query,
      analyzer: config.analyzer,
      tokens: (body?.tokens ?? [])
        .map((item) => item.token)
        .filter((token): token is string => typeof token === 'string'),
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: 'error',
      query,
      analyzer: config.analyzer,
      tokens: localAnalyze(query),
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'Unknown OpenSearch analyze error',
    };
  }
}

export async function searchOpenSearchChunksWithDiagnostics(
  query: string,
  limit: number | undefined,
  ragConfig: RagAdminConfig
): Promise<OpenSearchSearchResult> {
  const startedAt = Date.now();
  const config = await getEffectiveOpenSearchConfig();
  const normalizedLimit = normalizeLimit(limit, Math.min(ragConfig.lexicalCandidateLimit, config.candidateLimit));
  const analyzedTerms = localAnalyze(query);
  if (!config.enabled) {
    return {
      chunks: [],
      diagnostics: {
        enabled: false,
        ready: false,
        indexName: config.indexName,
        analyzer: config.analyzer,
        rawHits: 0,
        candidates: 0,
        analyzedTerms,
        removedTerms: [],
        latencyMs: Date.now() - startedAt,
        highlightsAvailable: false,
        error: 'OpenSearch is disabled',
      },
    };
  }
  const configError = getEnabledConfigError(config);
  if (configError) {
    return {
      chunks: [],
      diagnostics: {
        enabled: true,
        ready: false,
        indexName: config.indexName,
        analyzer: config.analyzer,
        rawHits: 0,
        candidates: 0,
        analyzedTerms,
        removedTerms: [],
        latencyMs: Date.now() - startedAt,
        highlightsAvailable: false,
        error: configError,
      },
    };
  }

  try {
    const { response, body } = await requestJson<JsonRecord>(config, `/${indexName(config)}/_search`, {
      method: 'POST',
      body: JSON.stringify(searchBody(query, normalizedLimit, config)),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hits = hitArray(body);
    return {
      chunks: hits.map((hit, index) => hitToChunk(hit, index + 1, analyzedTerms)),
      diagnostics: {
        enabled: true,
        ready: true,
        indexName: config.indexName,
        analyzer: config.analyzer,
        rawHits: totalHits(body),
        candidates: hits.length,
        analyzedTerms,
        removedTerms: [],
        latencyMs: Date.now() - startedAt,
        highlightsAvailable: config.highlightEnabled && hits.some((hit) => (
          Boolean(hit && typeof hit === 'object' && !Array.isArray(hit) && (hit as { highlight?: unknown }).highlight)
        )),
      },
    };
  } catch (err) {
    logOperationalError('opensearch.search_error', err);
    return {
      chunks: [],
      diagnostics: {
        enabled: true,
        ready: false,
        indexName: config.indexName,
        analyzer: config.analyzer,
        rawHits: 0,
        candidates: 0,
        analyzedTerms,
        removedTerms: [],
        latencyMs: Date.now() - startedAt,
        highlightsAvailable: false,
        error: err instanceof Error ? err.message : 'Unknown OpenSearch search error',
      },
    };
  }
}

export async function getOpenSearchAttachmentDiagnostics(
  filename: string,
  limit = 5
): Promise<OpenSearchAttachmentDiagnostics> {
  const config = await getEffectiveOpenSearchConfig();
  const normalizedFilename = filename.trim();
  const normalizedLimit = normalizeLimit(limit, 5);
  const base = {
    enabled: config.enabled,
    indexName: config.indexName,
    filename: normalizedFilename,
    chunks: 0,
    found: false,
    samples: [],
  };
  if (!config.enabled) {
    return {
      ...base,
      status: 'disabled',
      ready: false,
      error: 'OpenSearch is disabled',
    };
  }
  const configError = getEnabledConfigError(config);
  if (configError) {
    return {
      ...base,
      status: 'error',
      ready: false,
      error: configError,
    };
  }

  try {
    const { response, body } = await requestJson<JsonRecord>(config, `/${indexName(config)}/_search`, {
      method: 'POST',
      body: JSON.stringify({
        size: normalizedLimit,
        track_total_hits: true,
        _source: [
          'chunkId',
          'pageId',
          'title',
          'sourceType',
          'attachmentFilename',
          'attachmentMime',
          'attachmentProcessingMode',
          'chunkIndex',
          'totalChunks',
        ],
        query: {
          term: {
            attachmentFilename: normalizedFilename,
          },
        },
        sort: [
          { pageId: 'asc' },
          { chunkIndex: 'asc' },
        ],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hits = hitArray(body);
    const chunks = totalHits(body);
    return {
      ...base,
      status: 'ok',
      ready: true,
      chunks,
      found: chunks > 0,
      samples: hits.map(openSearchAttachmentSample),
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      ready: false,
      error: err instanceof Error ? err.message : 'Unknown OpenSearch attachment diagnostics error',
    };
  }
}

export async function getOpenSearchPageSet(
  limit = 500,
  options: OpenSearchPageSetOptions = {}
): Promise<OpenSearchPageSet> {
  const config = await getEffectiveOpenSearchConfig();
  const normalizedLimit = normalizePageSetLimit(limit);
  const namespaces = normalizeNamespaceFilter(options.namespaces);
  const base = {
    enabled: config.enabled,
    indexName: config.indexName,
    pages: [],
    totalPages: 0,
    limit: normalizedLimit,
    truncated: false,
  };
  if (!config.enabled) {
    return {
      ...base,
      status: 'disabled',
      ready: false,
      error: 'OpenSearch is disabled',
    };
  }
  const configError = getEnabledConfigError(config);
  if (configError) {
    return {
      ...base,
      status: 'error',
      ready: false,
      error: configError,
    };
  }

  try {
    const namespaceQuery = namespaces.length > 0
      ? {
        query: {
          bool: {
            filter: [
              {
                terms: {
                  namespace: namespaces,
                },
              },
            ],
          },
        },
      }
      : {};
    const { response, body } = await requestJson<JsonRecord>(config, `/${indexName(config)}/_search`, {
      method: 'POST',
      body: JSON.stringify({
        ...namespaceQuery,
        size: 0,
        aggs: {
          pages: {
            terms: {
              field: 'pageId',
              size: normalizedLimit + 1,
              order: { _key: 'asc' },
            },
            aggs: {
              topDoc: {
                top_hits: {
                  size: 1,
                  _source: ['title', 'sourceType', 'attachmentFilename'],
                  sort: [{ chunkIndex: 'asc' }],
                },
              },
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`OpenSearch page set failed with HTTP ${response.status}`);
    const buckets = aggregationBuckets(body, 'pages');
    return {
      ...base,
      status: 'ok',
      ready: true,
      totalPages: buckets.length > normalizedLimit ? normalizedLimit : buckets.length,
      pages: buckets
        .slice(0, normalizedLimit)
        .map(openSearchPageSetEntry)
        .filter((entry): entry is OpenSearchPageSetEntry => Boolean(entry)),
      truncated: buckets.length > normalizedLimit,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      ready: false,
      error: err instanceof Error ? err.message : 'Unknown OpenSearch page diagnostics error',
    };
  }
}

export async function getOpenSearchStatus(): Promise<OpenSearchStatus> {
  const config = await getEffectiveOpenSearchConfig();
  const base = {
    enabled: config.enabled,
    url: redactUrlCredentials(config.baseUrl),
    indexName: config.indexName,
    authConfigured: config.authConfigured,
    analyzer: config.analyzer,
    candidateLimit: config.candidateLimit,
    timeoutMs: config.timeoutMs,
    tlsRejectUnauthorized: config.tlsRejectUnauthorized,
  };
  if (!config.enabled) {
    return {
      ...base,
      status: 'disabled',
      ready: false,
    };
  }
  const configError = getEnabledConfigError(config);
  if (configError) {
    return {
      ...base,
      status: 'error',
      ready: false,
      error: configError,
    };
  }
  try {
    const head = await fetchWithTimeout(buildUrl(config, `/${indexName(config)}`), {
      method: 'HEAD',
      headers: buildHeaders(config),
    }, config.timeoutMs);
    if (!head.ok) {
      return {
        ...base,
        status: 'error',
        ready: false,
        error: `OpenSearch index is not ready: HTTP ${head.status}`,
      };
    }
    const [count, aggregation] = await Promise.all([
      requestJson<{ count?: unknown }>(config, `/${indexName(config)}/_count`, { method: 'GET' }),
      requestJson<JsonRecord>(config, `/${indexName(config)}/_search`, {
        method: 'POST',
        body: JSON.stringify({
          size: 0,
          aggs: {
            sourceTypes: {
              terms: { field: 'sourceType', size: 20 },
            },
            attachmentDocs: {
              filter: {
                bool: {
                  should: [
                    { term: { sourceType: 'attachment' } },
                    { exists: { field: 'attachmentFilename' } },
                  ],
                  minimum_should_match: 1,
                },
              },
            },
            attachmentFilenames: {
              terms: { field: 'attachmentFilename', size: 20 },
            },
          },
        }),
      }),
    ]);
    if (!aggregation.response.ok) throw new Error(`OpenSearch aggregation failed with HTTP ${aggregation.response.status}`);
    return {
      ...base,
      status: 'ok',
      ready: true,
      documentCount: readNumber(count.body?.count),
      sourceTypeCounts: aggregationBuckets(aggregation.body, 'sourceTypes')
        .filter((bucket) => typeof bucket.key === 'string')
        .map((bucket) => ({ sourceType: String(bucket.key), count: readNumber(bucket.doc_count) })),
      attachmentDocumentCount: filterDocCount(aggregation.body, 'attachmentDocs'),
      attachmentFilenames: aggregationBuckets(aggregation.body, 'attachmentFilenames')
        .filter((bucket) => typeof bucket.key === 'string')
        .map((bucket) => ({ filename: String(bucket.key), count: readNumber(bucket.doc_count) })),
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      ready: false,
      error: err instanceof Error ? err.message : 'Unknown OpenSearch status error',
    };
  }
}
