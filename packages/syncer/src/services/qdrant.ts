import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { getEmbedding } from './embedding.js';

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
}

export async function upsertChunks(
  pageId: number,
  title: string,
  namespace: number,
  chunks: Array<{ text: string; index: number; total: number }>,
  allowedGroups: string[],
  lastModified: string
): Promise<void> {
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
      } as unknown as Record<string, unknown>,
    });
  }

  if (points.length > 0) {
    await qdrant.upsert(config.qdrantCollection, { points });
  }
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
): Promise<void> {
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
}
