import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { getEmbedding } from './embedding.js';
import { SearchIndexNotificationResult, syncSearchIndexPage } from './gateway.js';
import type { SemanticFacts } from './mediawiki.js';

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
  ai_summary?: string;
  ai_keywords?: string[];
  ai_enrichment_model?: string;
}

export interface PageLlmEnrichment {
  summary: string;
  keywords: string[];
  model?: string;
}

export async function upsertChunks(
  pageId: number,
  title: string,
  namespace: number,
  chunks: Array<{ text: string; index: number; total: number }>,
  allowedGroups: string[],
  lastModified: string,
  semanticFacts: SemanticFacts = {},
  llmEnrichment?: PageLlmEnrichment
): Promise<SearchIndexNotificationResult | undefined> {
  await qdrant.delete(config.qdrantCollection, {
    filter: { must: [{ key: 'page_id', match: { value: pageId } }] },
  });

  const points = [];
  for (const chunk of chunks) {
    const embedding = await getEmbedding(chunk.text);
    points.push({
      id: pageId * 10000 + chunk.index,
      vector: embedding,
      payload: {
        page_id: pageId, title, namespace, text: chunk.text,
        allowed_groups: allowedGroups, chunk_index: chunk.index,
        total_chunks: chunk.total, last_modified: lastModified,
        ...(Object.keys(semanticFacts).length > 0 ? { semantic_facts: semanticFacts } : {}),
        ...(llmEnrichment ? {
          ai_summary: llmEnrichment.summary,
          ai_keywords: llmEnrichment.keywords,
          ai_enrichment_model: llmEnrichment.model,
        } : {}),
      } as unknown as Record<string, unknown>,
    });
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
    chunks: chunks.map((chunk) => ({
      id: pageId * 10000 + chunk.index,
      text: chunk.text,
      chunkIndex: chunk.index,
      totalChunks: chunk.total,
      sourceType: 'page',
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
  metadata: Record<string, unknown>
): Promise<SearchIndexNotificationResult | undefined> {
  const points = [];
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
        attachment_metadata: metadata,
      } as unknown as Record<string, unknown>,
    });
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
    chunks: textChunks.map((chunk, index) => ({
      id: pageId * 100000 + 50000 + index,
      text: chunk,
      chunkIndex: index,
      totalChunks: textChunks.length,
      sourceType: 'attachment',
      attachmentFilename: filename,
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
  metadata: Record<string, unknown>
): Promise<void> {
  await upsertAttachmentChunks(
    pageId,
    pageTitle,
    filename,
    mimeType,
    [metadataText],
    allowedGroups,
    lastModified,
    { ...metadata, mode: metadata.mode ?? 'metadata' }
  );
}
