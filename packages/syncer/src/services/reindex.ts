import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getAllowedGroups } from './acl.js';
import { buildAttachmentSearchableChunks, getMetadataText, processAttachment } from './attachment.js';
import { splitText } from './chunker.js';
import { getDocumentProcessingConfig, getMimeProcessingRule } from './document-policy.js';
import {
  downloadFile,
  fetchAllPages,
  fetchFileInfo,
  fetchPageCategories,
  fetchPageContent,
  fetchPageFiles,
  fetchSemanticFacts,
  getMediaWikiServiceAuthStatus,
  semanticFactsToText,
} from './mediawiki.js';
import {
  syncSearchIndexFromQdrantPayload,
  upsertCmdbDynamicSnapshotChunks,
  upsertAttachmentChunks,
  upsertAttachmentMetadata,
  upsertChunks,
} from './qdrant.js';
import { getNamespacesToReindex } from './reindex-scope.js';
import { applyIndexingProfileDefaults, getIndexingProfileFromAdminStorage } from './indexing-profile-store.js';
import {
  enrichPageForReindex,
  fetchEffectiveEmbeddingConfig,
  getGatewaySearchIndexStatus,
  ReindexLlmEnrichmentResult,
} from './gateway.js';
import { extractCmdbDynamicSources, fetchCmdbDynamicSnapshotChunks } from './cmdbdynamicpages.js';
import { toIndexPlainText } from './text-normalization.js';
import {
  chunkingPolicySummary,
  legacyChunkingRule,
  normalizeChunkingPolicy,
  resolveChunkingOptions,
  type ChunkingPolicy,
  type ChunkingSourceType,
} from './chunking-policy.js';
import { logOperationalEvent } from './logging.js';

export interface ReindexOptions {
  runId?: string;
  profileId?: string;
  indexTargets?: string[];
  source?: 'mediawiki' | 'qdrant_payload';
  colbertModel?: string;
  colbertCollection?: string;
  attachmentsEnabled?: boolean;
  semanticFactsEnabled?: boolean;
  smwProperties?: string[];
  namespaces?: number[];
  namespaceAcl?: Record<string, string[]>;
  titleFilters?: ReindexTextFilters;
  categoryFilters?: ReindexTextFilters;
  documentPolicyId?: string;
  maxPages?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
  chunkingPolicy?: ChunkingPolicy;
  dryRun?: boolean;
  llmEnrichmentEnabled?: boolean;
  llmEnrichmentModel?: string;
  llmEnrichmentMaxChars?: number;
  cmdbDynamicPagesEnabled?: boolean;
}

export interface ReindexTextFilters {
  include: string[];
  exclude: string[];
}

export interface ReindexSummary {
  runId: string;
  profileId?: string;
  source: 'mediawiki' | 'qdrant_payload';
  dryRun: boolean;
  namespaces: number[];
  matchedPages: number;
  limitApplied?: number;
  totalPages: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
  indexTargets: string[];
  embeddingCalls: number;
  llmEnrichmentCalls: number;
  estimatedPaidCalls: number;
  chunkSourceCounts: Record<string, number>;
  targetWrites: Record<string, number>;
  colbertPagesIndexed: number;
  colbertChunksIndexed: number;
  colbertFailures: number;
  colbertModel?: string;
  colbertCollection?: string;
  denseCollection?: string;
  qdrantPayloadPoints?: number;
  qdrantPayloadPages?: number;
  qdrantPayloadChunks?: number;
  attachmentsRequested: boolean;
  attachmentsActive: boolean;
  documentPolicyEnabled: boolean;
  attachmentsFound: number;
  attachmentsProcessed: number;
  attachmentsFailed: number;
  attachmentsSkippedDisabled: number;
  attachmentsSkippedNoInfo: number;
  attachmentsSkippedNoDownload: number;
  attachmentsSkippedEmpty: number;
  attachmentTargetWrites: Record<string, number>;
  dynamicBlocksMatched: number;
  dynamicSnapshotsIndexed: number;
  dynamicSnapshotsMissed: number;
  dynamicSnapshotsFailed: number;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
}

export interface ReindexProgress {
  phase: 'started' | 'page' | 'complete';
  runId?: string;
  profileId?: string;
  source?: 'mediawiki' | 'qdrant_payload';
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  dryRun?: boolean;
  namespaces?: number[];
  matchedPages?: number;
  limitApplied?: number;
  totalPages: number;
  processed: number;
  skipped?: number;
  failed: number;
  totalChunks: number;
  indexTargets?: string[];
  embeddingCalls?: number;
  llmEnrichmentCalls?: number;
  estimatedPaidCalls?: number;
  chunkSourceCounts?: Record<string, number>;
  targetWrites?: Record<string, number>;
  colbertPagesIndexed?: number;
  colbertChunksIndexed?: number;
  colbertFailures?: number;
  colbertModel?: string;
  colbertCollection?: string;
  denseCollection?: string;
  qdrantPayloadPoints?: number;
  qdrantPayloadPages?: number;
  qdrantPayloadChunks?: number;
  attachmentsRequested?: boolean;
  attachmentsActive?: boolean;
  documentPolicyEnabled?: boolean;
  attachmentsFound?: number;
  attachmentsProcessed?: number;
  attachmentsFailed?: number;
  attachmentsSkippedDisabled?: number;
  attachmentsSkippedNoInfo?: number;
  attachmentsSkippedNoDownload?: number;
  attachmentsSkippedEmpty?: number;
  attachmentTargetWrites?: Record<string, number>;
  currentAttachmentFilename?: string;
  currentAttachmentMime?: string;
  currentAttachmentMode?: string;
  currentTitle?: string;
}

export type ReindexProgressHandler = (progress: ReindexProgress) => void;

function hasResolvedProfileOptions(options: ReindexOptions): boolean {
  return options.attachmentsEnabled !== undefined
    && options.semanticFactsEnabled !== undefined
    && options.smwProperties !== undefined
    && options.namespaces !== undefined
    && options.titleFilters !== undefined
    && options.categoryFilters !== undefined
    && options.documentPolicyId !== undefined
    && options.chunkSize !== undefined
    && options.chunkOverlap !== undefined
    && options.chunkSeparators !== undefined
    && options.dryRun !== undefined;
}

function getRequestedNamespaces(requested: number[] | undefined, namespaceAcl: Record<string, string[]>): number[] {
  const configured = getNamespacesToReindex(namespaceAcl);
  if (!requested || requested.length === 0) return configured;

  const configuredSet = new Set(configured);
  const filtered = requested
    .filter((namespace) => Number.isInteger(namespace) && namespace >= 0 && configuredSet.has(namespace));

  return filtered.length > 0 ? Array.from(new Set(filtered)).sort((a, b) => a - b) : configured;
}

function getMaxPages(maxPages: number | undefined): number | undefined {
  if (maxPages === undefined) return undefined;
  if (!Number.isInteger(maxPages) || maxPages <= 0) return undefined;
  return Math.min(maxPages, 10_000);
}

function namespaceIsPublic(groups: string[]): boolean {
  return groups.length === 1 && groups[0]?.trim() === '*';
}

export function normalizeIndexTargets(
  options: ReindexOptions,
  defaults: { attachmentsEnabled: boolean; semanticFactsEnabled: boolean }
): string[] {
  const input = options.indexTargets && options.indexTargets.length > 0
    ? options.indexTargets
    : [
      'dense',
      'bm25',
      'colbert',
      ...(defaults.attachmentsEnabled ? ['attachments'] : []),
      ...(defaults.semanticFactsEnabled ? ['semanticFacts'] : []),
    ];
  return Array.from(new Set(
    input
      .map((item) => item.trim())
      .filter((item) => [
        'dense',
        'bm25',
        'colbert',
        'opensearch',
        'attachments',
        'semanticFacts',
        'ontologyVectors',
      ].includes(item))
  ));
}

function createChunkSourceCounts(): Record<string, number> {
  return {
    wiki_page: 0,
    attachment_text: 0,
    attachment_metadata: 0,
    cmdb_dynamic_snapshot: 0,
  };
}

function recordChunkSourceCount(
  counts: Record<string, number>,
  sourceType: ChunkingSourceType,
  chunks: number
): void {
  counts[sourceType] = (counts[sourceType] ?? 0) + Math.max(0, chunks);
}

export function getProtectedReindexNamespaces(
  namespaces: number[],
  namespaceAcl: Record<string, string[]>
): number[] {
  return namespaces.filter((namespace) => !namespaceIsPublic(getAllowedGroups(namespace, namespaceAcl)));
}

export async function validateReindexPreflight(options: ReindexOptions = {}): Promise<void> {
  const effectiveOptions = options.profileId
    ? applyIndexingProfileDefaults(
      options,
      hasResolvedProfileOptions(options)
        ? undefined
        : await getIndexingProfileFromAdminStorage(options.profileId)
    )
    : options;
  if (effectiveOptions.source === 'qdrant_payload') return;

  const effectiveNamespaceAcl = effectiveOptions.namespaceAcl ?? config.namespaceAcl;
  const namespaces = getRequestedNamespaces(effectiveOptions.namespaces, effectiveNamespaceAcl);
  const protectedNamespaces = getProtectedReindexNamespaces(namespaces, effectiveNamespaceAcl);
  const auth = getMediaWikiServiceAuthStatus();
  if (protectedNamespaces.length > 0 && auth.source === 'none') {
    throw new Error(
      `MediaWiki service auth is required before protected reindex. `
      + `Configure MW_SERVICE_USERNAME with MW_SERVICE_PASSWORD or MW_SERVICE_PASSWORD_SECRET, `
      + `then rerun auth test. Protected namespaces: ${protectedNamespaces.join(', ')}.`
    );
  }
}

function normalizeFilterValues(filters: ReindexTextFilters | undefined): ReindexTextFilters {
  return {
    include: filters?.include ?? [],
    exclude: filters?.exclude ?? [],
  };
}

export function textMatchesFilters(value: string, filters: ReindexTextFilters | undefined): boolean {
  const normalized = value.toLowerCase();
  const effective = normalizeFilterValues(filters);
  const includeMatches = effective.include.length === 0
    || effective.include.some((filter) => normalized.includes(filter.toLowerCase()));
  const excludeMatches = effective.exclude.some((filter) => normalized.includes(filter.toLowerCase()));
  return includeMatches && !excludeMatches;
}

function normalizeCategoryName(value: string): string {
  return value
    .replace(/^(category|категория):/i, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

export function categoriesMatchFilters(categories: string[], filters: ReindexTextFilters | undefined): boolean {
  const effective = normalizeFilterValues(filters);
  if (effective.include.length === 0 && effective.exclude.length === 0) return true;
  const values = new Set(categories.map(normalizeCategoryName));
  const includeMatches = effective.include.length === 0
    || effective.include.some((filter) => values.has(normalizeCategoryName(filter)));
  const excludeMatches = effective.exclude.some((filter) => values.has(normalizeCategoryName(filter)));
  return includeMatches && !excludeMatches;
}

function enrichmentToText(enrichment: ReindexLlmEnrichmentResult | undefined): string {
  if (!enrichment) return '';
  const keywords = enrichment.keywords.length > 0 ? `AI keywords: ${enrichment.keywords.join(', ')}` : '';
  return [`AI summary: ${enrichment.summary}`, keywords].filter(Boolean).join('\n');
}

interface AttachmentCounters {
  attachmentsRequested: boolean;
  attachmentsActive: boolean;
  documentPolicyEnabled: boolean;
  attachmentsFound: number;
  attachmentsProcessed: number;
  attachmentsFailed: number;
  attachmentsSkippedDisabled: number;
  attachmentsSkippedNoInfo: number;
  attachmentsSkippedNoDownload: number;
  attachmentsSkippedEmpty: number;
  attachmentTargetWrites: Record<string, number>;
}

interface ColbertCounters {
  colbertPagesIndexed: number;
  colbertChunksIndexed: number;
  colbertFailures: number;
  colbertModel?: string;
  colbertCollection?: string;
}

function createColbertCounters(options: ReindexOptions): ColbertCounters {
  return {
    colbertPagesIndexed: 0,
    colbertChunksIndexed: 0,
    colbertFailures: 0,
    colbertModel: options.colbertModel,
    colbertCollection: options.colbertCollection,
  };
}

function recordColbertWrite(
  counters: ColbertCounters,
  result: { status?: string; targetWrites?: Record<string, number | undefined> } | undefined,
  expected: boolean,
  countPage: boolean
): void {
  const chunks = result?.targetWrites?.colbert;
  if (typeof chunks === 'number' && chunks > 0) {
    counters.colbertChunksIndexed += chunks;
    if (countPage) counters.colbertPagesIndexed++;
    return;
  }
  if (expected && result?.status === 'error') {
    counters.colbertFailures++;
  }
}

function recordTargetWrites(
  counters: Record<string, number>,
  result: { targetWrites?: Record<string, number | undefined> } | undefined
): void {
  if (!result?.targetWrites) return;
  for (const [target, chunks] of Object.entries(result.targetWrites)) {
    if (typeof chunks !== 'number' || chunks <= 0) continue;
    counters[target] = (counters[target] ?? 0) + chunks;
  }
}

function recordAttachmentTargetWrites(
  counters: AttachmentCounters,
  result: { targetWrites?: Record<string, number | undefined> } | undefined
): void {
  if (!result?.targetWrites) return;
  for (const [target, chunks] of Object.entries(result.targetWrites)) {
    if (typeof chunks !== 'number' || chunks <= 0) continue;
    counters.attachmentTargetWrites[target] = (counters.attachmentTargetWrites[target] ?? 0) + chunks;
  }
}

function attachmentProgressFields(
  counters: AttachmentCounters,
  current?: { filename: string; mime?: string; mode?: string }
): Pick<
  ReindexProgress,
  | 'attachmentsRequested'
  | 'attachmentsActive'
  | 'documentPolicyEnabled'
  | 'attachmentsFound'
  | 'attachmentsProcessed'
  | 'attachmentsFailed'
  | 'attachmentsSkippedDisabled'
  | 'attachmentsSkippedNoInfo'
  | 'attachmentsSkippedNoDownload'
  | 'attachmentsSkippedEmpty'
  | 'attachmentTargetWrites'
  | 'currentAttachmentFilename'
  | 'currentAttachmentMime'
  | 'currentAttachmentMode'
> {
  return {
    ...counters,
    currentAttachmentFilename: current?.filename,
    currentAttachmentMime: current?.mime,
    currentAttachmentMode: current?.mode,
  };
}

function colbertProgressFields(counters: ColbertCounters): Pick<
  ReindexProgress,
  | 'colbertPagesIndexed'
  | 'colbertChunksIndexed'
  | 'colbertFailures'
  | 'colbertModel'
  | 'colbertCollection'
> {
  return {
    ...counters,
  };
}

async function validateGatewayAttachmentSchemaIfNeeded(
  counters: AttachmentCounters,
  searchIndexTargets: string[]
): Promise<void> {
  if (!counters.attachmentsActive || !searchIndexTargets.includes('bm25')) return;

  const status = await getGatewaySearchIndexStatus();
  if (status.status !== 'ok') {
    throw new Error(`Gateway attachment index schema status is unavailable: ${status.error ?? status.httpStatus ?? 'unknown error'}`);
  }
  if (status.values?.attachmentColumnsReady === false) {
    throw new Error('Gateway attachment index schema is not ready: attachment_mime, attachment_processing_mode and content_type columns are required before attachment reindex.');
  }
}

function assertAttachmentWriteOk(
  result: { status?: string; error?: string; httpStatus?: number } | undefined,
  filename: string
): void {
  if (!result || result.status === 'ok') return;
  throw new Error(`Attachment ${filename} was processed but Gateway index write failed: ${result.error ?? result.httpStatus ?? 'unknown error'}`);
}

async function applyCategoryFilters<T extends { title: string }>(
  pages: T[],
  filters: ReindexTextFilters | undefined
): Promise<T[]> {
  const effective = normalizeFilterValues(filters);
  if (effective.include.length === 0 && effective.exclude.length === 0) return pages;

  const result: T[] = [];
  for (const page of pages) {
    const categories = await fetchPageCategories(page.title);
    if (categoriesMatchFilters(categories, effective)) {
      result.push(page);
    }
  }
  return result;
}

export async function runReindex(
  options: ReindexOptions = {},
  onProgress?: ReindexProgressHandler
): Promise<ReindexSummary> {
  const effectiveOptions = options.profileId
    ? applyIndexingProfileDefaults(
      options,
      hasResolvedProfileOptions(options)
        ? undefined
        : await getIndexingProfileFromAdminStorage(options.profileId)
    )
    : options;
  const runId = effectiveOptions.runId ?? randomUUID();
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const targetWrites: Record<string, number> = {};
  const runtimeProgressFields = (finishedAt?: Date): Pick<
    ReindexProgress,
    'runId' | 'startedAt' | 'finishedAt' | 'elapsedMs' | 'targetWrites'
  > => {
    const fields: Pick<ReindexProgress, 'runId' | 'startedAt' | 'finishedAt' | 'elapsedMs' | 'targetWrites'> = {
      runId,
      startedAt: startedAtIso,
      elapsedMs: finishedAt ? finishedAt.getTime() - startedAt.getTime() : Date.now() - startedAt.getTime(),
      targetWrites: { ...targetWrites },
    };
    if (finishedAt) fields.finishedAt = finishedAt.toISOString();
    return fields;
  };
  const documentPolicy = await getDocumentProcessingConfig();
  const requestedAttachmentsEnabled = effectiveOptions.attachmentsEnabled ?? false;
  const requestedSemanticFactsEnabled = effectiveOptions.semanticFactsEnabled ?? config.smwSyncEnabled;
  const indexTargets = normalizeIndexTargets(effectiveOptions, {
    attachmentsEnabled: requestedAttachmentsEnabled,
    semanticFactsEnabled: requestedSemanticFactsEnabled,
  });
  const denseEnabled = indexTargets.includes('dense');
  const attachmentsEnabled = requestedAttachmentsEnabled && indexTargets.includes('attachments');
  const semanticFactsEnabled = requestedSemanticFactsEnabled && indexTargets.includes('semanticFacts');
  const searchIndexTargets = indexTargets.filter((target) => (
    target === 'bm25' || target === 'colbert' || target === 'opensearch'
  ));
  const smwProperties = effectiveOptions.smwProperties ?? config.smwSyncProperties;
  const dryRun = effectiveOptions.dryRun ?? false;
  const source = effectiveOptions.source ?? 'mediawiki';
  const llmEnrichmentEnabled = effectiveOptions.llmEnrichmentEnabled ?? false;
  const cmdbDynamicPagesEnabled = effectiveOptions.cmdbDynamicPagesEnabled ?? config.cmdbDynamicPagesEnabled;
  const legacyRule = legacyChunkingRule({
    chunkSize: effectiveOptions.chunkSize,
    chunkOverlap: effectiveOptions.chunkOverlap,
    chunkSeparators: effectiveOptions.chunkSeparators,
  });
  const chunkingPolicy = normalizeChunkingPolicy(effectiveOptions.chunkingPolicy, legacyRule);
  if (effectiveOptions.chunkingPolicy) {
    logOperationalEvent('info', 'syncer.chunking_policy.selected', {
      profileId: effectiveOptions.profileId,
      ...chunkingPolicySummary(chunkingPolicy),
    });
  }
  const maxPages = getMaxPages(effectiveOptions.maxPages);
  const chunkSourceCounts = createChunkSourceCounts();
  const attachmentCounters: AttachmentCounters = {
    attachmentsRequested: requestedAttachmentsEnabled,
    attachmentsActive: !dryRun && attachmentsEnabled && documentPolicy.attachmentsEnabled,
    documentPolicyEnabled: documentPolicy.attachmentsEnabled,
    attachmentsFound: 0,
    attachmentsProcessed: 0,
    attachmentsFailed: 0,
    attachmentsSkippedDisabled: 0,
    attachmentsSkippedNoInfo: 0,
    attachmentsSkippedNoDownload: 0,
    attachmentsSkippedEmpty: 0,
    attachmentTargetWrites: {},
  };
  const colbertCounters = createColbertCounters(effectiveOptions);
  const colbertTargetEnabled = searchIndexTargets.includes('colbert');
  await validateGatewayAttachmentSchemaIfNeeded(attachmentCounters, searchIndexTargets);
  if (effectiveOptions.source === 'qdrant_payload') {
    onProgress?.({
      phase: 'started',
      ...runtimeProgressFields(),
      profileId: effectiveOptions.profileId,
      source,
      dryRun,
      namespaces: [],
      matchedPages: 0,
      limitApplied: maxPages,
      totalPages: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      totalChunks: 0,
      indexTargets,
      embeddingCalls: 0,
      llmEnrichmentCalls: 0,
      estimatedPaidCalls: 0,
      chunkSourceCounts: { ...chunkSourceCounts },
      denseCollection: config.qdrantCollection,
      ...colbertProgressFields(colbertCounters),
      ...attachmentProgressFields(attachmentCounters),
    });
    const payloadSummary = await syncSearchIndexFromQdrantPayload({
      dryRun,
      maxPages,
      searchIndexTargets,
      colbertModel: effectiveOptions.colbertModel,
      colbertCollection: effectiveOptions.colbertCollection,
    });
    recordTargetWrites(targetWrites, { targetWrites: payloadSummary.targetWrites });
    if (!dryRun && colbertTargetEnabled) {
      colbertCounters.colbertPagesIndexed = payloadSummary.pages;
      colbertCounters.colbertChunksIndexed = payloadSummary.chunks;
      colbertCounters.colbertFailures = payloadSummary.failed;
    }
    const finishedAt = new Date();
    const summary: ReindexSummary = {
      runId,
      profileId: effectiveOptions.profileId,
      source,
      dryRun,
      namespaces: [],
      matchedPages: payloadSummary.pages,
      limitApplied: maxPages,
      totalPages: payloadSummary.pages,
      processed: payloadSummary.pages,
      skipped: 0,
      failed: payloadSummary.failed,
      totalChunks: payloadSummary.chunks,
      indexTargets,
      embeddingCalls: 0,
      llmEnrichmentCalls: 0,
      estimatedPaidCalls: 0,
      chunkSourceCounts: { ...chunkSourceCounts },
      targetWrites: { ...targetWrites },
      denseCollection: config.qdrantCollection,
      qdrantPayloadPoints: payloadSummary.qdrantPoints,
      qdrantPayloadPages: payloadSummary.pages,
      qdrantPayloadChunks: payloadSummary.chunks,
      ...colbertCounters,
      ...attachmentCounters,
      dynamicBlocksMatched: 0,
      dynamicSnapshotsIndexed: 0,
      dynamicSnapshotsMissed: 0,
      dynamicSnapshotsFailed: 0,
      startedAt: startedAtIso,
      finishedAt: finishedAt.toISOString(),
      elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    };
    onProgress?.({
      phase: 'complete',
      ...runtimeProgressFields(finishedAt),
      profileId: summary.profileId,
      source,
      dryRun,
      namespaces: [],
      matchedPages: summary.matchedPages,
      limitApplied: summary.limitApplied,
      totalPages: summary.totalPages,
      processed: summary.processed,
      skipped: summary.skipped,
      failed: summary.failed,
      totalChunks: summary.totalChunks,
      indexTargets,
      embeddingCalls: 0,
      llmEnrichmentCalls: 0,
      estimatedPaidCalls: 0,
      chunkSourceCounts: { ...chunkSourceCounts },
      denseCollection: summary.denseCollection,
      qdrantPayloadPoints: summary.qdrantPayloadPoints,
      qdrantPayloadPages: summary.qdrantPayloadPages,
      qdrantPayloadChunks: summary.qdrantPayloadChunks,
      ...colbertProgressFields(colbertCounters),
      ...attachmentProgressFields(attachmentCounters),
    });
    return summary;
  }
  const embeddingConfig = await fetchEffectiveEmbeddingConfig().catch(() => undefined);
  const effectiveNamespaceAcl = effectiveOptions.namespaceAcl ?? config.namespaceAcl;
  const namespaces = getRequestedNamespaces(effectiveOptions.namespaces, effectiveNamespaceAcl);
  const protectedNamespaces = getProtectedReindexNamespaces(namespaces, effectiveNamespaceAcl);
  const auth = getMediaWikiServiceAuthStatus();
  if (protectedNamespaces.length > 0 && auth.source === 'none') {
    throw new Error(
      `MediaWiki service auth is required before protected reindex. `
      + `Configure MW_SERVICE_USERNAME with MW_SERVICE_PASSWORD or MW_SERVICE_PASSWORD_SECRET, `
      + `then rerun auth test. Protected namespaces: ${protectedNamespaces.join(', ')}.`
    );
  }
  onProgress?.({
    phase: 'started',
    ...runtimeProgressFields(),
    profileId: effectiveOptions.profileId,
    source,
    dryRun,
    namespaces,
    limitApplied: maxPages,
    matchedPages: 0,
    totalPages: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    totalChunks: 0,
    indexTargets,
    embeddingCalls: 0,
    llmEnrichmentCalls: 0,
    estimatedPaidCalls: 0,
    chunkSourceCounts: { ...chunkSourceCounts },
    ...colbertProgressFields(colbertCounters),
    ...attachmentProgressFields(attachmentCounters),
  });
  const allPages = (
    await Promise.all(namespaces.map((namespace) => fetchAllPages(namespace)))
  ).flat().filter((page) => textMatchesFilters(page.title, effectiveOptions.titleFilters));
  const filteredPages = await applyCategoryFilters(allPages, effectiveOptions.categoryFilters);
  const matchedPages = filteredPages.length;
  const pages = maxPages === undefined ? filteredPages : filteredPages.slice(0, maxPages);
  const limitApplied = maxPages;

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let totalChunks = 0;
  let embeddingCalls = 0;
  let llmEnrichmentCalls = 0;
  let estimatedPaidCalls = 0;
  let dynamicBlocksMatched = 0;
  let dynamicSnapshotsIndexed = 0;
  let dynamicSnapshotsMissed = 0;
  let dynamicSnapshotsFailed = 0;

  onProgress?.({
    phase: 'started',
    ...runtimeProgressFields(),
    profileId: effectiveOptions.profileId,
    source,
    dryRun,
    namespaces,
    matchedPages,
    limitApplied,
    totalPages: pages.length,
    processed,
    skipped,
    failed,
    totalChunks,
    indexTargets,
    embeddingCalls,
    llmEnrichmentCalls,
    estimatedPaidCalls,
    chunkSourceCounts: { ...chunkSourceCounts },
    ...colbertProgressFields(colbertCounters),
    ...attachmentProgressFields(attachmentCounters),
  });

  for (const page of pages) {
    try {
      const content = await fetchPageContent(page.title, page.pageid);
      if (!content || !content.content) {
        skipped++;
        onProgress?.({
          phase: 'page',
          ...runtimeProgressFields(),
          profileId: effectiveOptions.profileId,
          source,
          dryRun,
          namespaces,
          matchedPages,
          limitApplied,
          totalPages: pages.length,
          processed,
          skipped,
          failed,
          totalChunks,
          indexTargets,
          embeddingCalls,
          llmEnrichmentCalls,
          estimatedPaidCalls,
          chunkSourceCounts: { ...chunkSourceCounts },
          ...colbertProgressFields(colbertCounters),
          ...attachmentProgressFields(attachmentCounters),
          currentTitle: page.title,
        });
        continue;
      }

      const rawContent = content.content;
      const pageIndexText = toIndexPlainText(rawContent);
      const semanticFacts = semanticFactsEnabled ? await fetchSemanticFacts(page.title, smwProperties) : {};
      const semanticText = semanticFactsToText(semanticFacts);
      let enrichment: ReindexLlmEnrichmentResult | undefined;
      if (!dryRun && llmEnrichmentEnabled) {
        enrichment = await enrichPageForReindex({
          title: page.title,
          text: pageIndexText,
          model: effectiveOptions.llmEnrichmentModel,
          maxChars: effectiveOptions.llmEnrichmentMaxChars,
        });
        llmEnrichmentCalls++;
      }
      const enrichmentText = enrichmentToText(enrichment);
      const indexText = [semanticText, enrichmentText, pageIndexText].filter(Boolean).join('\n\n');
      const chunks = splitText(indexText, resolveChunkingOptions({
        policy: chunkingPolicy,
        sourceType: 'wiki_page',
        namespace: page.ns,
      }));
      recordChunkSourceCount(chunkSourceCounts, 'wiki_page', chunks.length);
      const allowedGroups = getAllowedGroups(page.ns, effectiveNamespaceAcl);
      const lastModified = content.lastModified ?? new Date().toISOString();
      const estimatedPagePaidCalls = (denseEnabled && embeddingConfig?.provider === 'openai_compatible' ? chunks.length : 0)
        + (llmEnrichmentEnabled ? 1 : 0);
      estimatedPaidCalls += estimatedPagePaidCalls;
      if (!dryRun && denseEnabled) {
        embeddingCalls += chunks.length;
      }

      if (!dryRun) {
        const writeResult = await upsertChunks(
          page.pageid,
          page.title,
          page.ns,
          chunks,
          allowedGroups,
          lastModified,
          semanticFacts,
          enrichment ? {
            summary: enrichment.summary,
            keywords: enrichment.keywords,
            model: enrichment.model,
          } : undefined,
          {
            denseEnabled,
            searchIndexTargets,
            colbertModel: effectiveOptions.colbertModel,
            colbertCollection: effectiveOptions.colbertCollection,
          }
        );
        recordColbertWrite(colbertCounters, writeResult, colbertTargetEnabled, true);
        recordTargetWrites(targetWrites, writeResult);
      }

      processed++;
      totalChunks += chunks.length;

      if (cmdbDynamicPagesEnabled) {
        const dynamicSources = extractCmdbDynamicSources(rawContent, content.title);
        dynamicBlocksMatched += dynamicSources.length;
        const snapshotChunks = await fetchCmdbDynamicSnapshotChunks(dynamicSources);
        dynamicSnapshotsIndexed += snapshotChunks.filter((chunk) => chunk.snapshotFound).length;
        dynamicSnapshotsMissed += snapshotChunks.filter((chunk) => !chunk.snapshotFound && chunk.status !== 'error').length;
        dynamicSnapshotsFailed += snapshotChunks.filter((chunk) => chunk.status === 'error').length;

        if (snapshotChunks.length > 0) {
          const expandedSnapshotChunks = snapshotChunks.flatMap((snapshot) =>
            splitText(snapshot.text, resolveChunkingOptions({
              policy: chunkingPolicy,
              sourceType: 'cmdb_dynamic_snapshot',
              namespace: page.ns,
            })).map((chunk) => ({ ...snapshot, text: chunk.text }))
          );
          recordChunkSourceCount(chunkSourceCounts, 'cmdb_dynamic_snapshot', expandedSnapshotChunks.length);
          totalChunks += expandedSnapshotChunks.length;
          if (denseEnabled && embeddingConfig?.provider === 'openai_compatible') {
            estimatedPaidCalls += expandedSnapshotChunks.length;
          }
          if (!dryRun && denseEnabled) {
            embeddingCalls += expandedSnapshotChunks.length;
          }

          if (!dryRun) {
            const writeResult = await upsertCmdbDynamicSnapshotChunks(
              page.pageid,
              page.title,
              page.ns,
              expandedSnapshotChunks,
              allowedGroups,
              lastModified,
              {
                denseEnabled,
                searchIndexTargets,
                colbertModel: effectiveOptions.colbertModel,
                colbertCollection: effectiveOptions.colbertCollection,
              }
            );
            recordColbertWrite(colbertCounters, writeResult, colbertTargetEnabled, false);
            recordTargetWrites(targetWrites, writeResult);
          }
        }
      }

      if (attachmentCounters.attachmentsActive) {
        const files = await fetchPageFiles(page.title);
        attachmentCounters.attachmentsFound += files.length;
        for (const filename of files) {
          try {
            let currentAttachment: { filename: string; mime?: string; mode?: string } = { filename };
            const fileInfo = await fetchFileInfo(filename);
            if (!fileInfo) {
              attachmentCounters.attachmentsSkippedNoInfo++;
              continue;
            }

            const rule = getMimeProcessingRule(fileInfo.mime, documentPolicy);
            currentAttachment = { filename, mime: fileInfo.mime, mode: rule.mode };
            const metadata = {
              filename,
              mimeType: fileInfo.mime,
              size: fileInfo.size,
              mode: rule.mode,
            };

            if (rule.mode === 'disabled') {
              attachmentCounters.attachmentsSkippedDisabled++;
              continue;
            }

            if (rule.mode === 'metadata') {
              if (denseEnabled && embeddingConfig?.provider === 'openai_compatible') estimatedPaidCalls++;
              if (denseEnabled) embeddingCalls++;
              const writeResult = await upsertAttachmentMetadata(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                getMetadataText(filename, fileInfo.mime, metadata, page.title),
                allowedGroups,
                lastModified,
                metadata,
                {
                  denseEnabled,
                  searchIndexTargets,
                  colbertModel: effectiveOptions.colbertModel,
                  colbertCollection: effectiveOptions.colbertCollection,
                }
              );
              recordColbertWrite(colbertCounters, writeResult, colbertTargetEnabled, false);
              recordTargetWrites(targetWrites, writeResult);
              assertAttachmentWriteOk(writeResult, filename);
              recordAttachmentTargetWrites(attachmentCounters, writeResult);
              totalChunks += 1;
              recordChunkSourceCount(chunkSourceCounts, 'attachment_metadata', 1);
              attachmentCounters.attachmentsProcessed++;
              onProgress?.({
                phase: 'page',
                ...runtimeProgressFields(),
                profileId: effectiveOptions.profileId,
                source,
                dryRun,
                namespaces,
                matchedPages,
                limitApplied,
                totalPages: pages.length,
                processed,
                skipped,
                failed,
                totalChunks,
                indexTargets,
                embeddingCalls,
                llmEnrichmentCalls,
                estimatedPaidCalls,
                chunkSourceCounts: { ...chunkSourceCounts },
                ...colbertProgressFields(colbertCounters),
                ...attachmentProgressFields(attachmentCounters, currentAttachment),
                currentTitle: page.title,
              });
              continue;
            }

            const buffer = await downloadFile(fileInfo.url);
            if (!buffer) {
              attachmentCounters.attachmentsSkippedNoDownload++;
              continue;
            }

            const result = await processAttachment(buffer, fileInfo.mime, filename, documentPolicy);
            if (result.text && result.text.trim().length > 0) {
              const rawAttachmentChunks = splitText(result.text, resolveChunkingOptions({
                policy: chunkingPolicy,
                sourceType: 'attachment_text',
                namespace: page.ns,
              }));
              const attachmentChunkTexts = buildAttachmentSearchableChunks({
                filename,
                mimeType: fileInfo.mime,
                pageTitle: page.title,
                chunks: rawAttachmentChunks.map((chunk) => chunk.text),
              });
              if (denseEnabled && embeddingConfig?.provider === 'openai_compatible') estimatedPaidCalls += attachmentChunkTexts.length;
              if (denseEnabled) embeddingCalls += attachmentChunkTexts.length;
              const writeResult = await upsertAttachmentChunks(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                attachmentChunkTexts,
                allowedGroups,
                lastModified,
                result.metadata,
                {
                  denseEnabled,
                  searchIndexTargets,
                  colbertModel: effectiveOptions.colbertModel,
                  colbertCollection: effectiveOptions.colbertCollection,
                }
              );
              recordColbertWrite(colbertCounters, writeResult, colbertTargetEnabled, false);
              recordTargetWrites(targetWrites, writeResult);
              assertAttachmentWriteOk(writeResult, filename);
              recordAttachmentTargetWrites(attachmentCounters, writeResult);
              totalChunks += attachmentChunkTexts.length;
              recordChunkSourceCount(chunkSourceCounts, 'attachment_text', attachmentChunkTexts.length);
            } else {
              attachmentCounters.attachmentsSkippedEmpty++;
              if (denseEnabled && embeddingConfig?.provider === 'openai_compatible') estimatedPaidCalls++;
              if (denseEnabled) embeddingCalls++;
              const writeResult = await upsertAttachmentMetadata(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                getMetadataText(filename, fileInfo.mime, result.metadata, page.title),
                allowedGroups,
                lastModified,
                result.metadata,
                {
                  denseEnabled,
                  searchIndexTargets,
                  colbertModel: effectiveOptions.colbertModel,
                  colbertCollection: effectiveOptions.colbertCollection,
                }
              );
              recordColbertWrite(colbertCounters, writeResult, colbertTargetEnabled, false);
              recordTargetWrites(targetWrites, writeResult);
              assertAttachmentWriteOk(writeResult, filename);
              recordAttachmentTargetWrites(attachmentCounters, writeResult);
              totalChunks += 1;
              recordChunkSourceCount(chunkSourceCounts, 'attachment_metadata', 1);
            }
            attachmentCounters.attachmentsProcessed++;
            onProgress?.({
              phase: 'page',
              ...runtimeProgressFields(),
              profileId: effectiveOptions.profileId,
              source,
              dryRun,
              namespaces,
              matchedPages,
              limitApplied,
              totalPages: pages.length,
              processed,
              skipped,
              failed,
              totalChunks,
              indexTargets,
              embeddingCalls,
              llmEnrichmentCalls,
              estimatedPaidCalls,
              chunkSourceCounts: { ...chunkSourceCounts },
              ...colbertProgressFields(colbertCounters),
              ...attachmentProgressFields(attachmentCounters, currentAttachment),
              currentTitle: page.title,
            });
          } catch {
            attachmentCounters.attachmentsFailed++;
          }
        }
      }

      onProgress?.({
        phase: 'page',
        ...runtimeProgressFields(),
        profileId: effectiveOptions.profileId,
        source,
        dryRun,
        namespaces,
        matchedPages,
        limitApplied,
        totalPages: pages.length,
        processed,
        skipped,
        failed,
        totalChunks,
        indexTargets,
        embeddingCalls,
        llmEnrichmentCalls,
        estimatedPaidCalls,
        chunkSourceCounts: { ...chunkSourceCounts },
        ...colbertProgressFields(colbertCounters),
        ...attachmentProgressFields(attachmentCounters),
        currentTitle: page.title,
      });
    } catch {
      failed++;
      onProgress?.({
        phase: 'page',
        ...runtimeProgressFields(),
        profileId: effectiveOptions.profileId,
        source,
        dryRun,
        namespaces,
        matchedPages,
        limitApplied,
        totalPages: pages.length,
        processed,
        skipped,
        failed,
        totalChunks,
        indexTargets,
        embeddingCalls,
        llmEnrichmentCalls,
        estimatedPaidCalls,
        chunkSourceCounts: { ...chunkSourceCounts },
        ...colbertProgressFields(colbertCounters),
        ...attachmentProgressFields(attachmentCounters),
        currentTitle: page.title,
      });
    }
  }

  const finishedAt = new Date();
  const summary: ReindexSummary = {
    runId,
    profileId: effectiveOptions.profileId,
    source,
    dryRun,
    namespaces,
    matchedPages,
    limitApplied,
    totalPages: pages.length,
    processed,
    skipped,
    failed,
    totalChunks,
    indexTargets,
    embeddingCalls,
    llmEnrichmentCalls,
    estimatedPaidCalls,
    chunkSourceCounts: { ...chunkSourceCounts },
    targetWrites: { ...targetWrites },
    ...colbertCounters,
    ...attachmentCounters,
    dynamicBlocksMatched,
    dynamicSnapshotsIndexed,
    dynamicSnapshotsMissed,
    dynamicSnapshotsFailed,
    startedAt: startedAtIso,
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
  };

  onProgress?.({
    phase: 'complete',
    ...runtimeProgressFields(finishedAt),
    profileId: effectiveOptions.profileId,
    source,
    dryRun,
    namespaces,
    matchedPages,
    limitApplied,
    totalPages: pages.length,
    processed,
    skipped,
    failed,
    totalChunks,
    indexTargets,
    embeddingCalls,
    llmEnrichmentCalls,
    estimatedPaidCalls,
    chunkSourceCounts: { ...chunkSourceCounts },
    ...colbertProgressFields(colbertCounters),
    ...attachmentProgressFields(attachmentCounters),
  });

  return summary;
}
