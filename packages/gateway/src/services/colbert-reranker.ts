import {
  buildServiceUrl,
  getRagAdminConfig,
  HttpTestResult,
  RagAdminConfig,
} from './admin-platform-config.js';
import type { SearchIndexPageInput } from './search-index.js';
import { SearchChunk } from '../types/index.js';
import { measureDependency } from './metrics.js';
import { currentTraceHeaders } from './tracing.js';

export interface ColbertRerankDiagnostics {
  rerankMode: RagAdminConfig['rerankMode'];
  colbertApplied: boolean;
  colbertCandidates: number;
  colbertScores?: Array<{ id: number; score: number }>;
  tailSourcesBelowThreshold?: number;
  colbertTailDropEnabled?: boolean;
  colbertTailDropped?: number;
  colbertTailDropReasons?: {
    belowTailMinScore: number;
    scoreGap: number;
  };
  colbertTailBestScore?: number;
  colbertTailMinAcceptedScore?: number;
  colbertTailThresholds?: {
    minScore: number;
    maxGap: number;
    minKeep: number;
  };
  colbertLatencyMs?: number;
  colbertFallbackUsed: boolean;
  colbertError?: string;
}

export interface ColbertRerankResult {
  chunks: SearchChunk[];
  diagnostics: ColbertRerankDiagnostics;
}

interface ColbertRerankInput {
  query: string;
  chunks: SearchChunk[];
  topK: number;
  config: RagAdminConfig;
}

interface ColbertResponseResult {
  id: number;
  score: number;
  pageId?: number;
  page_id?: number;
  title?: string;
  text?: string;
  namespace?: number;
  allowedGroups?: string[];
  allowed_groups?: string[];
  chunkIndex?: number;
  chunk_index?: number;
  totalChunks?: number;
  total_chunks?: number;
  lastModified?: string;
  last_modified?: string;
  sourceType?: string;
  source_type?: string;
  attachmentFilename?: string;
  attachment_filename?: string;
  attachmentMime?: string;
  attachment_mime?: string;
  attachmentProcessingMode?: string;
  attachment_processing_mode?: string;
  contentType?: string;
  content_type?: string;
  payload?: Record<string, unknown>;
}

export interface ColbertIndexDiagnostics {
  searchMode: RagAdminConfig['searchMode'];
  colbertIndexApplied: boolean;
  colbertCandidates: number;
  colbertScores?: Array<{ id: number; score: number }>;
  tailSourcesBelowThreshold?: number;
  colbertTailDropEnabled?: boolean;
  colbertTailDropped?: number;
  colbertTailDropReasons?: {
    belowTailMinScore: number;
    scoreGap: number;
  };
  colbertTailBestScore?: number;
  colbertTailMinAcceptedScore?: number;
  colbertTailThresholds?: {
    minScore: number;
    maxGap: number;
    minKeep: number;
  };
  colbertLatencyMs?: number;
  colbertFallbackUsed: boolean;
  colbertError?: string;
}

export interface ColbertIndexSearchResult {
  chunks: SearchChunk[];
  limit: number;
  aclCandidateLimit: number;
  showRawScores: boolean;
  mode: RagAdminConfig['searchMode'];
  diagnostics: ColbertIndexDiagnostics;
}

export interface ColbertIndexWriteResult {
  status: 'ok' | 'disabled' | 'error';
  url: string;
  chunks: number;
  httpStatus?: number;
  error?: string;
}

export interface ColbertHealthCollectionStatus {
  exists?: boolean;
  points?: number;
  vectors?: number;
  error?: string;
}

export interface ColbertHealthResult extends HttpTestResult {
  model?: string;
  collection?: string;
  collectionStatus?: ColbertHealthCollectionStatus;
}

interface ColbertTailDiagnostics {
  colbertTailDropEnabled: boolean;
  colbertTailDropped: number;
  colbertTailDropReasons: {
    belowTailMinScore: number;
    scoreGap: number;
  };
  colbertTailBestScore?: number;
  colbertTailMinAcceptedScore?: number;
  colbertTailThresholds: {
    minScore: number;
    maxGap: number;
    minKeep: number;
  };
}

interface ColbertRankCandidate {
  id: number;
  score: number;
  chunk: SearchChunk;
}

interface ColbertRankedChunks {
  chunks: SearchChunk[];
  diagnostics: ColbertTailDiagnostics;
}

const disabledDiagnostics = (config: RagAdminConfig): ColbertRerankDiagnostics => ({
  rerankMode: config.rerankMode,
  colbertApplied: false,
  colbertCandidates: 0,
  colbertFallbackUsed: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeTopK(topK: number): number {
  if (!Number.isFinite(topK)) return 1;
  return Math.min(Math.max(Math.trunc(topK), 1), 20);
}

export function isColbertRerankEnabled(config: RagAdminConfig): boolean {
  return (
    (config.rerankMode === 'colbert_v2' || config.searchMode === 'hybrid_colbert') &&
    config.colbertEnabled &&
    config.colbertBaseUrl.trim().length > 0
  );
}

export function isColbertFullSearchEnabled(config: RagAdminConfig): boolean {
  return (
    config.searchMode === 'colbert_full' &&
    config.colbertEnabled &&
    config.colbertBaseUrl.trim().length > 0
  );
}

export function getColbertCandidateLimit(config: RagAdminConfig, fallbackLimit: number): number {
  if (!isColbertRerankEnabled(config) && !isColbertFullSearchEnabled(config)) return fallbackLimit;
  return Math.max(fallbackLimit, config.colbertCandidateLimit);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(currentTraceHeaders())) {
    headers.set(key, value);
  }
  try {
    return await measureDependency(
      { dependency: 'colbert', operation: 'http' },
      async () => fetch(url, { ...init, headers, signal: controller.signal })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`ColBERT request timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseColbertResults(payload: unknown): ColbertResponseResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error('ColBERT response does not contain results array');
  }

  return payload.results
    .map((item): ColbertResponseResult | null => {
      if (!isRecord(item)) return null;
      const id = Number(item.id);
      const score = Number(item.score);
      if (!Number.isFinite(id) || !Number.isFinite(score)) return null;
      return { ...item, id, score };
    })
    .filter((item): item is ColbertResponseResult => item !== null);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function colbertResultToChunk(result: ColbertResponseResult): SearchChunk | null {
  const payload = isRecord(result.payload) ? result.payload : {};
  const pageId = readNumber(result.pageId) ?? readNumber(result.page_id) ?? readNumber(payload.page_id);
  const title = readString(result.title) ?? readString(payload.title);
  const text = readString(result.text) ?? readString(payload.text);
  const namespace = readNumber(result.namespace) ?? readNumber(payload.namespace);
  if (!pageId || !title || !text || namespace === undefined) return null;

  const allowedGroups = readStringArray(result.allowedGroups)
    ?? readStringArray(result.allowed_groups)
    ?? readStringArray(payload.allowed_groups)
    ?? ['*'];

  return {
    id: result.id,
    pageId,
    title,
    text,
    namespace,
    allowedGroups,
    score: result.score,
    scores: {
      colbert: result.score,
      final: result.score,
    },
    chunkIndex: readNumber(result.chunkIndex) ?? readNumber(result.chunk_index) ?? readNumber(payload.chunk_index),
    totalChunks: readNumber(result.totalChunks) ?? readNumber(result.total_chunks) ?? readNumber(payload.total_chunks),
    lastModified: readString(result.lastModified) ?? readString(result.last_modified) ?? readString(payload.last_modified),
    sourceType: readString(result.sourceType) ?? readString(result.source_type) ?? readString(payload.source_type),
    attachmentFilename: readString(result.attachmentFilename)
      ?? readString(result.attachment_filename)
      ?? readString(payload.attachment_filename),
    attachmentMime: readString(result.attachmentMime)
      ?? readString(result.attachment_mime)
      ?? readString(payload.attachment_mime),
    attachmentProcessingMode: readString(result.attachmentProcessingMode)
      ?? readString(result.attachment_processing_mode)
      ?? readString(payload.attachment_processing_mode),
    contentType: readString(result.contentType)
      ?? readString(result.content_type)
      ?? readString(payload.content_type),
  };
}

function normalizeTailMinKeep(value: number, topK: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), normalizeTopK(topK));
}

function tailDiagnostics(config: RagAdminConfig, topK: number): ColbertTailDiagnostics {
  return {
    colbertTailDropEnabled: config.colbertTailDropEnabled,
    colbertTailDropped: 0,
    colbertTailDropReasons: {
      belowTailMinScore: 0,
      scoreGap: 0,
    },
    colbertTailThresholds: {
      minScore: config.colbertTailMinScore,
      maxGap: config.colbertTailMaxGap,
      minKeep: normalizeTailMinKeep(config.colbertTailMinKeep, topK),
    },
  };
}

function applyColbertTailCutoff(
  candidates: ColbertRankCandidate[],
  config: RagAdminConfig,
  topK: number
): ColbertRankedChunks {
  const limit = normalizeTopK(topK);
  const minKeep = normalizeTailMinKeep(config.colbertTailMinKeep, topK);
  const diagnostics = tailDiagnostics(config, topK);
  const ranked: SearchChunk[] = [];
  const eligibleScores = candidates
    .map((candidate) => candidate.score)
    .filter((score) => score >= config.colbertMinScore);
  const bestScore = eligibleScores.length > 0 ? Math.max(...eligibleScores) : undefined;

  for (const candidate of candidates) {
    if (candidate.score < config.colbertMinScore) continue;

    if (config.colbertTailDropEnabled && ranked.length >= minKeep) {
      if (candidate.score < config.colbertTailMinScore) {
        diagnostics.colbertTailDropped += 1;
        diagnostics.colbertTailDropReasons.belowTailMinScore += 1;
        continue;
      }

      if (bestScore !== undefined && bestScore - candidate.score > config.colbertTailMaxGap) {
        diagnostics.colbertTailDropped += 1;
        diagnostics.colbertTailDropReasons.scoreGap += 1;
        continue;
      }
    }

    ranked.push({
      ...candidate.chunk,
      score: candidate.score,
      scores: {
        ...candidate.chunk.scores,
        colbert: candidate.score,
        final: candidate.score,
      },
    });

    if (ranked.length >= limit) break;
  }

  if (bestScore !== undefined) {
    diagnostics.colbertTailBestScore = bestScore;
  }
  if (ranked.length > 0) {
    diagnostics.colbertTailMinAcceptedScore = Math.min(...ranked.map((chunk) => chunk.score));
  }

  return { chunks: ranked, diagnostics };
}

function applyColbertScores(
  chunks: SearchChunk[],
  results: ColbertResponseResult[],
  config: RagAdminConfig,
  topK: number
): ColbertRankedChunks {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const seen = new Set<number>();
  const candidates: ColbertRankCandidate[] = [];

  for (const result of results) {
    const chunk = chunksById.get(result.id);
    if (!chunk || seen.has(result.id)) continue;
    seen.add(result.id);
    candidates.push({
      id: result.id,
      score: result.score,
      chunk,
    });
  }

  return applyColbertTailCutoff(candidates, config, topK);
}

function colbertScoreDiagnostics(results: ColbertResponseResult[], minScore: number): {
  colbertScores: Array<{ id: number; score: number }>;
  tailSourcesBelowThreshold: number;
} {
  return {
    colbertScores: results.map((result) => ({ id: result.id, score: result.score })),
    tailSourcesBelowThreshold: results.filter((result) => result.score < minScore).length,
  };
}

export async function rerankChunksWithColbert(input: ColbertRerankInput): Promise<ColbertRerankResult> {
  const { query, chunks, topK, config } = input;
  if (!isColbertRerankEnabled(config) || chunks.length === 0) {
    return {
      chunks: chunks.slice(0, normalizeTopK(topK)),
      diagnostics: disabledDiagnostics(config),
    };
  }

  const startedAt = Date.now();
  const candidates = chunks.slice(0, config.colbertCandidateLimit);
  const url = buildServiceUrl(config.colbertBaseUrl, 'rerank');

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        model: config.colbertModel,
        topK: candidates.length,
        candidates: candidates.map((chunk) => ({
          id: chunk.id,
          title: chunk.title,
          text: chunk.text,
        })),
      }),
    }, config.colbertTimeoutMs);

    if (!response.ok) {
      throw new Error(`ColBERT rerank error: ${response.status} ${response.statusText}`);
    }

    const results = parseColbertResults(await response.json() as unknown);
    const scoreDiagnostics = colbertScoreDiagnostics(results, config.colbertMinScore);
    const ranked = applyColbertScores(
      chunks,
      results,
      config,
      topK
    );

    if (ranked.chunks.length === 0 && chunks.length > 0 && config.colbertFailMode === 'fallback_current') {
      return {
        chunks: chunks.slice(0, normalizeTopK(topK)),
        diagnostics: {
          rerankMode: config.rerankMode,
          colbertApplied: false,
          colbertCandidates: candidates.length,
          ...scoreDiagnostics,
          ...ranked.diagnostics,
          colbertLatencyMs: Date.now() - startedAt,
          colbertFallbackUsed: true,
          colbertError: 'ColBERT response did not rank any candidate above threshold',
        },
      };
    }

    return {
      chunks: ranked.chunks,
      diagnostics: {
        rerankMode: config.rerankMode,
        colbertApplied: true,
        colbertCandidates: candidates.length,
        ...scoreDiagnostics,
        ...ranked.diagnostics,
        colbertLatencyMs: Date.now() - startedAt,
        colbertFallbackUsed: false,
      },
    };
  } catch (err) {
    if (config.colbertFailMode === 'fail_search') {
      throw err;
    }

    return {
      chunks: chunks.slice(0, normalizeTopK(topK)),
      diagnostics: {
        rerankMode: config.rerankMode,
        colbertApplied: false,
        colbertCandidates: candidates.length,
        colbertLatencyMs: Date.now() - startedAt,
        colbertFallbackUsed: true,
        colbertError: errorMessage(err),
      },
    };
  }
}

function colbertDisabledWriteResult(path: string): ColbertIndexWriteResult {
  return {
    status: 'disabled',
    url: path,
    chunks: 0,
    error: 'ColBERT index is not configured or not enabled',
  };
}

export async function searchColbertIndex(input: {
  query: string;
  topK?: number;
  fallbackTopK: number;
  config: RagAdminConfig;
}): Promise<ColbertIndexSearchResult> {
  const { query, config } = input;
  const limit = normalizeTopK(input.topK ?? input.fallbackTopK);
  const candidateLimit = Math.max(limit, config.colbertCandidateLimit);
  const startedAt = Date.now();

  if (!isColbertFullSearchEnabled(config)) {
    return {
      chunks: [],
      limit,
      aclCandidateLimit: candidateLimit,
      showRawScores: config.showRawScores,
      mode: config.searchMode,
      diagnostics: {
        searchMode: config.searchMode,
        colbertIndexApplied: false,
        colbertCandidates: 0,
        colbertFallbackUsed: false,
        colbertError: 'ColBERT full index search is disabled',
      },
    };
  }

  const url = buildServiceUrl(config.colbertBaseUrl, 'search');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      model: config.colbertModel,
      collection: config.colbertCollection,
      topK: candidateLimit,
    }),
  }, config.colbertTimeoutMs);

  if (!response.ok) {
    throw new Error(`ColBERT search error: ${response.status} ${response.statusText}`);
  }

  const results = parseColbertResults(await response.json() as unknown);
  const scoreDiagnostics = colbertScoreDiagnostics(results, config.colbertMinScore);
  const seen = new Set<number>();
  const candidates = results
    .map(colbertResultToChunk)
    .filter((chunk): chunk is SearchChunk => chunk !== null)
    .filter((chunk) => {
      if (seen.has(chunk.id)) return false;
      seen.add(chunk.id);
      return true;
    })
    .map((chunk) => ({
      id: chunk.id,
      score: chunk.score,
      chunk,
    }));
  const ranked = applyColbertTailCutoff(candidates, config, candidateLimit);

  return {
    chunks: ranked.chunks,
    limit,
    aclCandidateLimit: Math.max(limit * 5, Math.min(ranked.chunks.length, 100)),
    showRawScores: config.showRawScores,
    mode: config.searchMode,
    diagnostics: {
      searchMode: config.searchMode,
      colbertIndexApplied: true,
      colbertCandidates: ranked.chunks.length,
      ...scoreDiagnostics,
      ...ranked.diagnostics,
      colbertLatencyMs: Date.now() - startedAt,
      colbertFallbackUsed: false,
    },
  };
}

export async function syncColbertIndexPage(
  input: SearchIndexPageInput,
  configOverride?: RagAdminConfig
): Promise<ColbertIndexWriteResult> {
  const baseConfig = configOverride ?? await getRagAdminConfig();
  const config: RagAdminConfig = {
    ...baseConfig,
    colbertModel: input.colbertModel?.trim() || baseConfig.colbertModel,
    colbertCollection: input.colbertCollection?.trim() || baseConfig.colbertCollection,
  };
  if (!config.colbertEnabled || config.colbertBaseUrl.trim().length === 0) {
    return colbertDisabledWriteResult('/index/page');
  }

  const url = buildServiceUrl(config.colbertBaseUrl, 'index/page');
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.colbertModel,
        collection: config.colbertCollection,
        pageId: input.pageId,
        title: input.title,
        namespace: input.namespace,
        allowedGroups: input.allowedGroups,
        lastModified: input.lastModified,
        replacePage: input.replacePage ?? true,
        chunks: input.chunks,
      }),
    }, config.colbertTimeoutMs);

    return {
      status: response.ok ? 'ok' : 'error',
      url,
      chunks: input.chunks.length,
      httpStatus: response.status,
      error: response.ok ? undefined : await response.text().catch(() => response.statusText),
    };
  } catch (err) {
    return {
      status: 'error',
      url,
      chunks: input.chunks.length,
      error: errorMessage(err),
    };
  }
}

export async function deleteColbertIndexPage(
  pageId: number,
  configOverride?: RagAdminConfig
): Promise<ColbertIndexWriteResult> {
  const config = configOverride ?? await getRagAdminConfig();
  if (!config.colbertEnabled || config.colbertBaseUrl.trim().length === 0) {
    return colbertDisabledWriteResult('/index/delete-page');
  }

  const url = buildServiceUrl(config.colbertBaseUrl, 'index/delete-page');
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: config.colbertCollection,
        pageId,
      }),
    }, config.colbertTimeoutMs);

    return {
      status: response.ok ? 'ok' : 'error',
      url,
      chunks: 0,
      httpStatus: response.status,
      error: response.ok ? undefined : await response.text().catch(() => response.statusText),
    };
  } catch (err) {
    return {
      status: 'error',
      url,
      chunks: 0,
      error: errorMessage(err),
    };
  }
}

export async function testColbertReranker(configOverride?: RagAdminConfig): Promise<ColbertHealthResult> {
  const config = configOverride ?? await getRagAdminConfig();
  const url = config.colbertBaseUrl.trim().length > 0
    ? buildServiceUrl(config.colbertBaseUrl, 'health')
    : '';
  const startedAt = Date.now();

  if (!url) {
    return {
      status: 'error',
      url,
      latencyMs: 0,
      error: 'ColBERT Base URL is not configured',
    };
  }

  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, config.colbertTimeoutMs);
    const body = response.ok
      ? await response.json().catch(() => undefined) as unknown
      : undefined;
    const collectionStatus = isRecord(body) && isRecord(body.collectionStatus)
      ? {
        exists: readBoolean(body.collectionStatus.exists),
        points: readNumber(body.collectionStatus.points),
        vectors: readNumber(body.collectionStatus.vectors),
        error: readString(body.collectionStatus.error),
      }
      : undefined;
    return {
      status: response.ok ? 'ok' : 'error',
      url,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      model: isRecord(body) ? readString(body.model) : undefined,
      collection: isRecord(body) ? readString(body.collection) : undefined,
      collectionStatus,
      error: response.ok ? undefined : response.statusText,
    } satisfies ColbertHealthResult;
  } catch (err) {
    return {
      status: 'error',
      url,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(err),
    };
  }
}
