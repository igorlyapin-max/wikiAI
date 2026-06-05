import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { getEmbedding } from './embedding.js';
import { SearchIndexNotificationResult, syncSearchIndexPage } from './gateway.js';
import type { CmdbDynamicSnapshotChunk } from './cmdbdynamicpages.js';
import type { SemanticFacts } from './mediawiki.js';
import { toIndexPlainText } from './text-normalization.js';

export const qdrant = new QdrantClient({ url: config.qdrantUrl });

export interface ChunkPayload {
  page_id: number;
  title: string;
  namespace: number;
  text: string;
  allowed_groups: string[];
  chunk_index: number;
  total_chunks: number;
  last_modified: string;
  semantic_facts?: SemanticFacts;
  content_type?: string;
  ai_summary?: string;
  ai_keywords?: string[];
  ai_enrichment_model?: string;
  source_type?: string;
  cmdbdynamic_template_code?: string;
  cmdbdynamic_params_hash?: string;
  cmdbdynamic_snapshot_status?: string;
  cmdbdynamic_snapshot_found?: boolean;
  cmdbdynamic_published_by?: string;
  cmdbdynamic_published_at?: string;
  cmdbdynamic_spec_hash?: string;
}

export interface PageLlmEnrichment {
  summary: string;
  keywords: string[];
  model?: string;
}

export interface IndexWriteOptions {
  denseEnabled?: boolean;
  searchIndexTargets?: string[];
  colbertModel?: string;
  colbertCollection?: string;
}

export interface QdrantPayloadBackfillOptions {
  dryRun?: boolean;
  maxPages?: number;
  searchIndexTargets?: string[];
  colbertModel?: string;
  colbertCollection?: string;
}

export interface QdrantPayloadBackfillSummary {
  qdrantPoints: number;
  pages: number;
  groups: number;
  chunks: number;
  failed: number;
}

interface QdrantPayloadGroup {
  pageId: number;
  title: string;
  namespace: number;
  allowedGroups: string[];
  lastModified?: string;
  sourceType: string;
  attachmentFilename?: string;
  chunks: Array<{
    id: number;
    text: string;
    chunkIndex: number;
    totalChunks: number;
    sourceType?: string;
    attachmentFilename?: string;
    mimeType?: string;
    processingMode?: string;
    contentType?: string;
  }>;
}

function shouldWriteDense(options: IndexWriteOptions | undefined): boolean {
  return options?.denseEnabled !== false;
}

function searchIndexTargets(options: IndexWriteOptions | undefined): string[] | undefined {
  return options?.searchIndexTargets;
}

function detectContentType(text: string): string | undefined {
  return /```mermaid[\s\S]*?```/i.test(text) ? 'mermaid' : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return ['*'];
  const groups = Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  ));
  return groups.length > 0 ? groups : ['*'];
}

function groupQdrantPayloadPoints(points: Array<{ id?: unknown; payload?: unknown }>): QdrantPayloadGroup[][] {
  const byPage = new Map<number, Map<string, QdrantPayloadGroup>>();

  for (const point of points) {
    const payload = asRecord(point.payload);
    if (!payload) continue;
    const pageId = asPositiveInteger(payload.page_id);
    const id = asPositiveInteger(point.id);
    const title = asString(payload.title);
    const text = toIndexPlainText(asString(payload.text) ?? '');
    const namespace = asNonNegativeInteger(payload.namespace);
    if (!pageId || !id || !title || !text || namespace === undefined) continue;

    const sourceType = asString(payload.source_type) ?? 'page';
    const attachmentFilename = asString(payload.attachment_filename);
    const groupKey = [namespace, title, sourceType, attachmentFilename ?? ''].join('\u001f');
    const pageGroups = byPage.get(pageId) ?? new Map<string, QdrantPayloadGroup>();
    const group = pageGroups.get(groupKey) ?? {
      pageId,
      title,
      namespace,
      sourceType,
      attachmentFilename,
      allowedGroups: asStringArray(payload.allowed_groups),
      lastModified: asString(payload.last_modified),
      chunks: [],
    };

    group.chunks.push({
      id,
      text,
      chunkIndex: asNonNegativeInteger(payload.chunk_index) ?? group.chunks.length,
      totalChunks: asPositiveInteger(payload.total_chunks) ?? 1,
      sourceType,
      attachmentFilename,
      mimeType: asString(payload.attachment_mime),
      processingMode: asString(payload.attachment_processing_mode),
      contentType: asString(payload.content_type) ?? detectContentType(text),
    });
    pageGroups.set(groupKey, group);
    byPage.set(pageId, pageGroups);
  }

  return Array.from(byPage.values()).map((pageGroups) =>
    Array.from(pageGroups.values()).sort((a, b) => {
      if (a.sourceType === b.sourceType) return a.namespace - b.namespace;
      return a.sourceType === 'page' ? -1 : 1;
    })
  );
}

export async function syncSearchIndexFromQdrantPayload(
  options: QdrantPayloadBackfillOptions = {}
): Promise<QdrantPayloadBackfillSummary> {
  const points: Array<{ id?: unknown; payload?: unknown }> = [];
  let offset: string | number | Record<string, unknown> | null | undefined;

  do {
    const page = await qdrant.scroll(config.qdrantCollection, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });
    points.push(...(Array.isArray(page.points) ? page.points : []));
    offset = page.next_page_offset;
  } while (offset !== undefined && offset !== null);

  const pageGroups = groupQdrantPayloadPoints(points)
    .slice(0, options.maxPages && options.maxPages > 0 ? options.maxPages : undefined);
  let chunks = 0;
  let groups = 0;
  let failed = 0;

  for (const groupsForPage of pageGroups) {
    for (let index = 0; index < groupsForPage.length; index++) {
      const group = groupsForPage[index];
      chunks += group.chunks.length;
      groups++;
      if (options.dryRun) continue;
      try {
        const result = await syncSearchIndexPage({
          pageId: group.pageId,
          title: group.title,
          namespace: group.namespace,
          allowedGroups: group.allowedGroups,
          lastModified: group.lastModified ?? new Date().toISOString(),
          replacePage: index === 0,
          indexTargets: options.searchIndexTargets,
          colbertModel: options.colbertModel,
          colbertCollection: options.colbertCollection,
          chunks: group.chunks,
        });
        if (result.status !== 'ok') failed++;
      } catch {
        failed++;
      }
    }
  }

  return {
    qdrantPoints: points.length,
    pages: pageGroups.length,
    groups,
    chunks,
    failed,
  };
}

export async function upsertChunks(
  pageId: number,
  title: string,
  namespace: number,
  chunks: Array<{ text: string; index: number; total: number }>,
  allowedGroups: string[],
  lastModified: string,
  semanticFacts: SemanticFacts = {},
  llmEnrichment?: PageLlmEnrichment,
  options: IndexWriteOptions = {}
): Promise<SearchIndexNotificationResult | undefined> {
  const indexChunks = chunks
    .map((chunk) => ({ ...chunk, text: toIndexPlainText(chunk.text) }))
    .filter((chunk) => chunk.text.length > 0)
    .map((chunk, index, normalizedChunks) => ({ ...chunk, index, total: normalizedChunks.length }));

  if (shouldWriteDense(options)) {
    await qdrant.delete(config.qdrantCollection, {
      filter: { must: [{ key: 'page_id', match: { value: pageId } }] },
    });
  }

  const points = [];
  if (shouldWriteDense(options)) {
    for (const chunk of indexChunks) {
      const embedding = await getEmbedding(chunk.text);
      const contentType = detectContentType(chunk.text);
      points.push({
        id: pageId * 10000 + chunk.index,
        vector: embedding,
        payload: {
          page_id: pageId, title, namespace, text: chunk.text,
          allowed_groups: allowedGroups, chunk_index: chunk.index,
          total_chunks: chunk.total, last_modified: lastModified,
          ...(contentType ? { content_type: contentType } : {}),
          ...(Object.keys(semanticFacts).length > 0 ? { semantic_facts: semanticFacts } : {}),
          ...(llmEnrichment ? {
            ai_summary: llmEnrichment.summary,
            ai_keywords: llmEnrichment.keywords,
            ai_enrichment_model: llmEnrichment.model,
          } : {}),
        } as unknown as Record<string, unknown>,
      });
    }
  }

  if (points.length > 0) {
    await qdrant.upsert(config.qdrantCollection, { points });
  }

  return syncSearchIndexPage({
    pageId,
    title,
    namespace,
    allowedGroups,
    lastModified,
    replacePage: true,
    indexTargets: searchIndexTargets(options),
    colbertModel: options.colbertModel,
    colbertCollection: options.colbertCollection,
    chunks: indexChunks.map((chunk) => ({
      id: pageId * 10000 + chunk.index,
      text: chunk.text,
      chunkIndex: chunk.index,
      totalChunks: chunk.total,
      sourceType: 'page',
      contentType: detectContentType(chunk.text),
    })),
  });
}

export async function upsertAttachmentChunks(
  pageId: number,
  pageTitle: string,
  filename: string,
  mimeType: string,
  textChunks: string[],
  allowedGroups: string[],
  lastModified: string,
  metadata: Record<string, unknown>,
  options: IndexWriteOptions = {}
): Promise<SearchIndexNotificationResult | undefined> {
  const points = [];
  if (shouldWriteDense(options)) {
    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      const embedding = await getEmbedding(chunk);
      points.push({
        id: pageId * 100000 + 50000 + i,
        vector: embedding,
        payload: {
          page_id: pageId,
          title: pageTitle,
          namespace: 6, // File namespace
          text: chunk,
          allowed_groups: allowedGroups,
          chunk_index: i,
          total_chunks: textChunks.length,
          last_modified: lastModified,
          source_type: 'attachment',
          attachment_filename: filename,
          attachment_mime: mimeType,
          attachment_processing_mode: metadata.mode,
          attachment_metadata: metadata,
        } as unknown as Record<string, unknown>,
      });
    }
  }

  if (points.length > 0) {
    await qdrant.upsert(config.qdrantCollection, { points });
  }

  return syncSearchIndexPage({
    pageId,
    title: pageTitle,
    namespace: 6,
    allowedGroups,
    lastModified,
    replacePage: false,
    indexTargets: searchIndexTargets(options),
    colbertModel: options.colbertModel,
    colbertCollection: options.colbertCollection,
    chunks: textChunks.map((chunk, index) => ({
      id: pageId * 100000 + 50000 + index,
      text: chunk,
      chunkIndex: index,
      totalChunks: textChunks.length,
      sourceType: 'attachment',
      attachmentFilename: filename,
      mimeType,
      processingMode: typeof metadata.mode === 'string' ? metadata.mode : undefined,
    })),
  });
}

export async function upsertAttachmentMetadata(
  pageId: number,
  pageTitle: string,
  filename: string,
  mimeType: string,
  metadataText: string,
  allowedGroups: string[],
  lastModified: string,
  metadata: Record<string, unknown>,
  options: IndexWriteOptions = {}
): Promise<void> {
  await upsertAttachmentChunks(
    pageId,
    pageTitle,
    filename,
    mimeType,
    [metadataText],
    allowedGroups,
    lastModified,
    { ...metadata, mode: metadata.mode ?? 'metadata' },
    options
  );
}

export async function upsertCmdbDynamicSnapshotChunks(
  pageId: number,
  pageTitle: string,
  namespace: number,
  snapshotChunks: CmdbDynamicSnapshotChunk[],
  allowedGroups: string[],
  lastModified: string,
  options: IndexWriteOptions = {}
): Promise<SearchIndexNotificationResult | undefined> {
  const textChunks = snapshotChunks.map((chunk, index) => ({
    id: pageId * 100000 + 70000 + index,
    text: chunk.text,
    chunkIndex: index,
    totalChunks: snapshotChunks.length,
    snapshot: chunk,
  }));
  const points = [];

  if (shouldWriteDense(options)) {
    for (const chunk of textChunks) {
      const embedding = await getEmbedding(chunk.text);
      points.push({
        id: chunk.id,
        vector: embedding,
        payload: {
          page_id: pageId,
          title: pageTitle,
          namespace,
          text: chunk.text,
          allowed_groups: allowedGroups,
          chunk_index: chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          last_modified: lastModified,
          source_type: 'cmdbdynamicpages',
          content_type: chunk.snapshot.snapshotFound
            ? 'cmdbdynamicpages_static_snapshot'
            : 'cmdbdynamicpages_snapshot_status',
          cmdbdynamic_template_code: chunk.snapshot.source.templateCode,
          cmdbdynamic_params_hash: chunk.snapshot.paramsHash,
          cmdbdynamic_snapshot_status: chunk.snapshot.status,
          cmdbdynamic_snapshot_found: chunk.snapshot.snapshotFound,
          cmdbdynamic_published_by: chunk.snapshot.publishedBy,
          cmdbdynamic_published_at: chunk.snapshot.publishedAt,
          cmdbdynamic_spec_hash: chunk.snapshot.specHash,
        } as unknown as Record<string, unknown>,
      });
    }
  }

  if (points.length > 0) {
    await qdrant.upsert(config.qdrantCollection, { points });
  }

  return syncSearchIndexPage({
    pageId,
    title: pageTitle,
    namespace,
    allowedGroups,
    lastModified,
    replacePage: false,
    indexTargets: searchIndexTargets(options),
    colbertModel: options.colbertModel,
    colbertCollection: options.colbertCollection,
    chunks: textChunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      sourceType: 'cmdbdynamicpages',
      contentType: chunk.snapshot.snapshotFound
        ? 'cmdbdynamicpages_static_snapshot'
        : 'cmdbdynamicpages_snapshot_status',
    })),
  });
}
