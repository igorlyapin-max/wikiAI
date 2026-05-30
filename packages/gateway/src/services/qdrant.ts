import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { SearchChunk } from '../types/index.js';

export const qdrant = new QdrantClient({ url: config.qdrantUrl });

export async function ensureCollection(): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === config.qdrantCollection);

  if (!exists) {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: {
        size: 768,
        distance: 'Cosine',
      },
    });

    await qdrant.createPayloadIndex(config.qdrantCollection, {
      field_name: 'allowed_groups',
      field_schema: 'keyword',
    });

    await qdrant.createPayloadIndex(config.qdrantCollection, {
      field_name: 'namespace',
      field_schema: 'integer',
    });

    console.log(`Created Qdrant collection: ${config.qdrantCollection}`);
  }
}

export async function searchChunks(
  vector: number[],
  userGroups: string[],
  topK: number = 5
): Promise<SearchChunk[]> {
  const groupsFilter = [...userGroups, '*'];

  const results = await qdrant.search(config.qdrantCollection, {
    vector,
    limit: topK * 2,
    filter: {
      must: [
        {
          key: 'allowed_groups',
          match: {
            any: groupsFilter,
          },
        },
      ],
    },
    with_payload: true,
  });

  return results.map((r) => ({
    id: r.id as number,
    pageId: (r.payload?.page_id as number) ?? 0,
    title: (r.payload?.title as string) ?? '',
    text: (r.payload?.text as string) ?? '',
    namespace: (r.payload?.namespace as number) ?? 0,
    allowedGroups: (r.payload?.allowed_groups as string[]) ?? ['*'],
    score: r.score,
  }));
}
