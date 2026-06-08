import { fetchWikiPages, type WikiPage } from './mediawiki.js';
import {
  getOpenSearchPageSet,
  getOpenSearchStatus,
  type OpenSearchPageSetEntry,
} from './opensearch.js';
import {
  getSearchIndexPageSet,
  getSearchIndexStatus,
  type SearchIndexPageSetEntry,
} from './search-index.js';
import {
  getSyncerReindexSourceDiagnostics,
  getSyncerReindexStatus,
  type SyncerReindexSourceDiagnostics,
} from './syncer-admin.js';
import { testColbertReranker, type ColbertHealthResult } from './colbert-reranker.js';

export type IndexHealth = 'ok' | 'warning' | 'error' | 'disabled';

export interface IndexStatusPageSample {
  pageId: number;
  title?: string;
  chunks?: number;
  docs?: number;
  attachmentChunks?: number;
  attachmentFilename?: string;
}

export interface IndexStatusPageDiff {
  staleCount: number;
  missingCount: number;
  staleSamples: IndexStatusPageSample[];
  missingSamples: IndexStatusPageSample[];
  sourceTruncated: boolean;
  indexTruncated: boolean;
}

export interface IndexStatusSummary {
  status: Exclude<IndexHealth, 'disabled'>;
  source: {
    status: Exclude<IndexHealth, 'disabled'>;
    namespaces: number[];
    pages: number;
    fetchedPages: number;
    truncated: boolean;
    error?: string;
  };
  indexes: {
    dense: {
      status: IndexHealth;
      collection?: string;
      pages?: number;
      chunks?: number;
      points?: number;
      error?: string;
    };
    colbert: {
      status: IndexHealth;
      collection?: string;
      pages?: number;
      chunks?: number;
      points?: number;
      state?: string;
      source?: 'live_health' | 'last_colbert_reindex';
      lastReindexIncludedColbert?: boolean;
      error?: string;
    };
    bm25: {
      status: IndexHealth;
      pages?: number;
      chunks?: number;
      ftsChunks?: number;
      attachmentPages?: number;
      attachmentChunks?: number;
      latestUpdatedAt?: string;
      diff?: IndexStatusPageDiff;
      error?: string;
    };
    opensearch: {
      status: IndexHealth;
      ready?: boolean;
      enabled?: boolean;
      indexName?: string;
      pages?: number;
      docs?: number;
      diff?: IndexStatusPageDiff;
      error?: string;
    };
    trigram: {
      status: IndexHealth;
      chunks?: number;
      ftsChunks?: number;
      expectedChunks?: number;
      backfillRequired?: boolean;
      error?: string;
    };
  };
  lastReindex?: unknown;
  recommendations: string[];
}

interface IndexStatusSummaryOptions {
  namespaces?: number[];
  sessionCookie?: string;
  pageLimit?: number;
}

interface ProbeResult<T> {
  value?: T;
  error?: string;
}

interface ComparablePage {
  pageId: number;
  title?: string;
  chunks?: number;
  docs?: number;
  attachmentChunks?: number;
  attachmentFilename?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown index diagnostics error';
}

async function probe<T>(fn: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeNamespaces(namespaces: number[] | undefined): number[] {
  if (!Array.isArray(namespaces)) return [0];
  const values = Array.from(new Set(
    namespaces.filter((namespace) => Number.isInteger(namespace) && namespace >= 0)
  )).sort((left, right) => left - right);
  return values.length > 0 ? values : [0];
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function reindexStatusRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return isRecord(value.status) ? value.status : value;
}

function firstNestedNumber(value: unknown, keys: string[]): number | undefined {
  const status = reindexStatusRecord(value);
  const summary = nestedRecord(status, 'summary');
  const progress = nestedRecord(status, 'progress');
  for (const key of keys) {
    const numberValue = readNumber(summary?.[key]) ?? readNumber(progress?.[key]);
    if (numberValue !== undefined) return numberValue;
  }
  return undefined;
}

function firstNestedString(value: unknown, keys: string[]): string | undefined {
  const status = reindexStatusRecord(value);
  const summary = nestedRecord(status, 'summary');
  const progress = nestedRecord(status, 'progress');
  for (const key of keys) {
    const stringValue = readString(summary?.[key]) ?? readString(progress?.[key]);
    if (stringValue) return stringValue;
  }
  return undefined;
}

function firstNestedStringArray(value: unknown, keys: string[]): string[] | undefined {
  const status = reindexStatusRecord(value);
  const summary = nestedRecord(status, 'summary');
  const progress = nestedRecord(status, 'progress');
  for (const key of keys) {
    const raw = summary?.[key] ?? progress?.[key];
    if (!Array.isArray(raw)) continue;
    const values = raw
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    if (values.length > 0) return values;
  }
  return undefined;
}

function statusFromDiff(diff: IndexStatusPageDiff | undefined, sameCount: boolean, fallback: IndexHealth): IndexHealth {
  if (fallback === 'error' || fallback === 'disabled') return fallback;
  if (!sameCount || (diff && (diff.staleCount > 0 || diff.missingCount > 0))) return 'warning';
  return 'ok';
}

function wikiPageToComparable(page: WikiPage): ComparablePage | undefined {
  if (typeof page.pageId !== 'number' || !Number.isFinite(page.pageId)) return undefined;
  return {
    pageId: page.pageId,
    title: page.title,
  };
}

function searchPageToComparable(page: SearchIndexPageSetEntry): ComparablePage {
  return {
    pageId: page.pageId,
    title: page.title,
    chunks: page.chunks,
    attachmentChunks: page.attachmentChunks,
  };
}

function openSearchPageToComparable(page: OpenSearchPageSetEntry): ComparablePage {
  return {
    pageId: page.pageId,
    title: page.title,
    docs: page.docs,
    attachmentFilename: page.attachmentFilename,
  };
}

function pageSample(page: ComparablePage): IndexStatusPageSample {
  return {
    pageId: page.pageId,
    title: page.title,
    chunks: page.chunks,
    docs: page.docs,
    attachmentChunks: page.attachmentChunks,
    attachmentFilename: page.attachmentFilename,
  };
}

function diffPages(
  sourcePages: ComparablePage[],
  indexPages: ComparablePage[],
  options: { sourceTruncated: boolean; indexTruncated: boolean; sampleLimit?: number }
): IndexStatusPageDiff | undefined {
  if (sourcePages.length === 0) return undefined;
  const sampleLimit = options.sampleLimit ?? 10;
  const sourceById = new Map(sourcePages.map((page) => [page.pageId, page]));
  const indexById = new Map(indexPages.map((page) => [page.pageId, page]));
  const stale = indexPages.filter((page) => !sourceById.has(page.pageId));
  const missing = sourcePages.filter((page) => !indexById.has(page.pageId));
  return {
    staleCount: stale.length,
    missingCount: missing.length,
    staleSamples: stale.slice(0, sampleLimit).map(pageSample),
    missingSamples: missing.slice(0, sampleLimit).map(pageSample),
    sourceTruncated: options.sourceTruncated,
    indexTruncated: options.indexTruncated,
  };
}

function sourcePageCount(
  diagnostics: SyncerReindexSourceDiagnostics | undefined,
  wikiPages: WikiPage[]
): number {
  return diagnostics?.mediaWikiPages ?? wikiPages.length;
}

function buildColbertStatus(
  lastReindex: unknown,
  expectedPages: number,
  health: ProbeResult<ColbertHealthResult>,
  reindexError?: string
): IndexStatusSummary['indexes']['colbert'] {
  const statusRecord = reindexStatusRecord(lastReindex);
  const state = isRecord(statusRecord) ? readString(statusRecord.state) : undefined;
  const targets = firstNestedStringArray(lastReindex, ['indexTargets']);
  const lastReindexIncludedColbert = Boolean(targets?.includes('colbert'));
  const reindexPages = lastReindexIncludedColbert
    ? firstNestedNumber(lastReindex, ['colbertPagesIndexed'])
    : undefined;
  const reindexChunks = lastReindexIncludedColbert
    ? firstNestedNumber(lastReindex, ['colbertChunksIndexed'])
    : undefined;
  const livePoints = health.value?.collectionStatus?.points;
  const liveCollection = health.value?.collection;
  const reindexCollection = firstNestedString(lastReindex, ['colbertCollection']);
  const collection = liveCollection ?? reindexCollection;
  const base = {
    collection,
    pages: reindexPages,
    chunks: livePoints ?? reindexChunks,
    points: livePoints,
    state,
    source: livePoints !== undefined ? 'live_health' as const : 'last_colbert_reindex' as const,
    lastReindexIncludedColbert,
  };

  if (lastReindexIncludedColbert && state === 'failed') {
    return {
      ...base,
      status: 'error',
      error: readString(isRecord(statusRecord) ? statusRecord.error : undefined) ?? 'Last ColBERT reindex failed',
    };
  }
  if (lastReindexIncludedColbert && (state === 'running' || state === 'queued')) {
    return {
      ...base,
      status: 'warning',
    };
  }
  if (health.value?.status === 'ok' && livePoints !== undefined) {
    return {
      ...base,
      status: livePoints > 0 ? 'ok' : 'warning',
      error: livePoints > 0 ? undefined : 'ColBERT collection is empty',
    };
  }
  if (lastReindexIncludedColbert && reindexPages !== undefined) {
    return {
      ...base,
      status: reindexPages === expectedPages && Number(reindexChunks ?? 0) > 0 ? 'ok' : 'warning',
      error: reindexPages === expectedPages && Number(reindexChunks ?? 0) > 0
        ? health.error ?? health.value?.error
        : 'Last ColBERT reindex did not index expected pages',
    };
  }
  return {
    ...base,
    status: 'warning',
    error: health.error ?? health.value?.error ?? reindexError ?? 'ColBERT live status is unavailable',
  };
}

function overallStatus(statuses: IndexHealth[]): Exclude<IndexHealth, 'disabled'> {
  if (statuses.includes('error')) return 'error';
  if (statuses.some((status) => status === 'warning' || status === 'disabled')) return 'warning';
  return 'ok';
}

export async function getIndexStatusSummary(options: IndexStatusSummaryOptions = {}): Promise<IndexStatusSummary> {
  const namespaces = normalizeNamespaces(options.namespaces);
  const pageLimit = options.pageLimit ?? 500;

  const [sourceDiagnosticsProbe, wikiPagesProbe, searchStatusProbe, searchPageSetProbe, openSearchStatusProbe, openSearchPageSetProbe, reindexStatusProbe, colbertHealthProbe] =
    await Promise.all([
      probe(() => getSyncerReindexSourceDiagnostics(namespaces)),
      probe(() => fetchWikiPages({ namespaces, limit: pageLimit, sessionCookie: options.sessionCookie })),
      probe(() => getSearchIndexStatus()),
      probe(() => getSearchIndexPageSet(pageLimit, { namespaces })),
      probe(() => getOpenSearchStatus()),
      probe(() => getOpenSearchPageSet(pageLimit, { namespaces })),
      probe(() => getSyncerReindexStatus()),
      probe(() => testColbertReranker()),
    ]);

  const sourceDiagnostics = sourceDiagnosticsProbe.value?.values;
  const wikiPages = wikiPagesProbe.value ?? [];
  const sourcePages = wikiPages
    .map(wikiPageToComparable)
    .filter((page): page is ComparablePage => Boolean(page));
  const mediaWikiPages = sourcePageCount(sourceDiagnostics, wikiPages);
  const sourceTruncated = wikiPages.length >= pageLimit || (sourceDiagnostics?.mediaWikiPages ?? 0) > wikiPages.length;

  const recommendations: string[] = [];
  const addRecommendation = (value: string): void => {
    if (!recommendations.includes(value)) recommendations.push(value);
  };

  const sourceStatus: Exclude<IndexHealth, 'disabled'> = sourceDiagnosticsProbe.error && wikiPagesProbe.error
    ? 'error'
    : sourceDiagnosticsProbe.error || wikiPagesProbe.error || sourceTruncated
      ? 'warning'
      : 'ok';

  const densePages = sourceDiagnostics?.qdrantPayloadPages;
  const denseStatus: IndexHealth = sourceDiagnosticsProbe.error
    ? 'error'
    : densePages === mediaWikiPages
      ? 'ok'
      : 'warning';
  if (denseStatus !== 'ok') addRecommendation('Run dense + ColBERT reindex for MediaWiki source.');

  const colbert = buildColbertStatus(reindexStatusProbe.value, mediaWikiPages, colbertHealthProbe, reindexStatusProbe.error);
  if (colbert.status !== 'ok') addRecommendation('Run dense + ColBERT reindex for MediaWiki source.');

  const searchStatus = searchStatusProbe.value;
  const searchPageSet = searchPageSetProbe.value;
  const bm25Pages = searchPageSet?.pages.map(searchPageToComparable) ?? [];
  const bm25Diff = diffPages(sourcePages, bm25Pages, {
    sourceTruncated,
    indexTruncated: Boolean(searchPageSet?.truncated),
  });
  const bm25Status: IndexHealth = searchStatusProbe.error
    ? 'error'
    : statusFromDiff(bm25Diff, searchStatus?.pages === mediaWikiPages, 'ok');
  if (bm25Status !== 'ok') addRecommendation('Run BM25/OpenSearch rebuild or full all-index reindex.');

  const openSearchStatus = openSearchStatusProbe.value;
  const openSearchPageSet = openSearchPageSetProbe.value;
  const openSearchPages = openSearchPageSet?.pages.map(openSearchPageToComparable) ?? [];
  const openSearchDiff = diffPages(sourcePages, openSearchPages, {
    sourceTruncated,
    indexTruncated: Boolean(openSearchPageSet?.truncated),
  });
  const openSearchBaseStatus: IndexHealth = openSearchStatusProbe.error || openSearchPageSet?.status === 'error'
    ? 'error'
    : openSearchStatus?.status === 'disabled' || openSearchPageSet?.status === 'disabled'
      ? 'disabled'
      : 'ok';
  const openSearchPagesCount = openSearchPageSet?.pages.length;
  const openSearchStatusValue: IndexHealth = statusFromDiff(
    openSearchDiff,
    openSearchPagesCount === undefined || openSearchPagesCount === mediaWikiPages,
    openSearchBaseStatus
  );
  if (openSearchStatusValue === 'warning' || openSearchStatusValue === 'error') {
    addRecommendation('Run BM25/OpenSearch rebuild or full all-index reindex.');
  }

  const trigramStatus: IndexHealth = searchStatusProbe.error
    ? 'error'
    : searchStatus?.trigramBackfillRecommended
      ? 'warning'
      : 'ok';
  if (searchStatus?.trigramBackfillRecommended) addRecommendation('Run trigram backfill after BM25 is current.');

  const statuses: IndexHealth[] = [sourceStatus, denseStatus, colbert.status, bm25Status, openSearchStatusValue, trigramStatus];

  return {
    status: overallStatus(statuses),
    source: {
      status: sourceStatus,
      namespaces,
      pages: mediaWikiPages,
      fetchedPages: wikiPages.length,
      truncated: sourceTruncated,
      error: sourceDiagnosticsProbe.error ?? wikiPagesProbe.error,
    },
    indexes: {
      dense: {
        status: denseStatus,
        collection: sourceDiagnostics?.denseCollection,
        pages: densePages,
        chunks: sourceDiagnostics?.qdrantPayloadChunks,
        points: sourceDiagnostics?.qdrantPayloadPoints,
        error: sourceDiagnosticsProbe.error,
      },
      colbert,
      bm25: {
        status: bm25Status,
        pages: searchStatus?.pages,
        chunks: searchStatus?.chunks,
        ftsChunks: searchStatus?.ftsChunks,
        attachmentPages: searchStatus?.attachmentPages,
        attachmentChunks: searchStatus?.attachmentChunks,
        latestUpdatedAt: searchStatus?.latestUpdatedAt,
        diff: bm25Diff,
        error: searchStatusProbe.error ?? searchPageSetProbe.error,
      },
      opensearch: {
        status: openSearchStatusValue,
        ready: openSearchStatus?.ready ?? openSearchPageSet?.ready,
        enabled: openSearchStatus?.enabled ?? openSearchPageSet?.enabled,
        indexName: openSearchStatus?.indexName ?? openSearchPageSet?.indexName,
        pages: openSearchPageSet?.pages.length,
        docs: openSearchStatus?.documentCount,
        diff: openSearchDiff,
        error: openSearchStatusProbe.error ?? openSearchPageSetProbe.error ?? openSearchStatus?.error ?? openSearchPageSet?.error,
      },
      trigram: {
        status: trigramStatus,
        chunks: searchStatus?.trigramChunks,
        ftsChunks: searchStatus?.trigramFtsChunks,
        expectedChunks: searchStatus?.chunks,
        backfillRequired: searchStatus?.trigramBackfillRecommended,
        error: searchStatusProbe.error,
      },
    },
    lastReindex: reindexStatusProbe.value,
    recommendations,
  };
}
