import { QdrantClient, type Schemas } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { SearchChunk, SemanticFacts } from '../types/index.js';

export const qdrant = new QdrantClient({ url: config.qdrantUrl });
export const QDRANT_VECTOR_SIZE = 768;
export const MAX_SEARCH_TOP_K = 20;
export const MAX_VECTOR_CANDIDATE_LIMIT = 200;

type PayloadSchemaType = Schemas['PayloadSchemaType'];
type QdrantSearchResult = {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
};

export interface QdrantPayloadIndexDefinition {
  fieldName: string;
  schema: PayloadSchemaType;
}

export const REQUIRED_QDRANT_PAYLOAD_INDEXES: readonly QdrantPayloadIndexDefinition[] = [
  { fieldName: 'allowed_groups', schema: 'keyword' },
  { fieldName: 'namespace', schema: 'integer' },
  { fieldName: 'trust_score', schema: 'float' },
  { fieldName: 'trust_flags', schema: 'keyword' },
  { fieldName: 'applied_rules', schema: 'keyword' },
  { fieldName: 'applied_entities', schema: 'keyword' },
  { fieldName: 'trust_model_id', schema: 'keyword' },
  { fieldName: 'trust_include_in_context', schema: 'bool' },
  { fieldName: 'trust_allow_direct_answer', schema: 'bool' },
  { fieldName: 'trust_exclude_from_index', schema: 'bool' },
  { fieldName: 'trust_require_manual_approval', schema: 'bool' },
  { fieldName: 'trust_notify_author', schema: 'bool' },
  { fieldName: 'trust_require_sources', schema: 'bool' },
  { fieldName: 'trust_calculated_at', schema: 'datetime' },
];

function isPayloadIndexAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && /already exists|already indexed|exists/i.test(err.message);
}

export async function ensurePayloadIndexes(): Promise<void> {
  const collection = await qdrant.getCollection(config.qdrantCollection);
  const payloadSchema = collection.payload_schema ?? {};
  const createdIndexes: string[] = [];

  for (const index of REQUIRED_QDRANT_PAYLOAD_INDEXES) {
    const existingIndex = payloadSchema[index.fieldName];
    if (existingIndex) {
      if (existingIndex.data_type !== index.schema) {
        throw new Error(
          `Qdrant payload index "${index.fieldName}" has type "${existingIndex.data_type}", expected "${index.schema}"`
        );
      }
      continue;
    }

    try {
      await qdrant.createPayloadIndex(config.qdrantCollection, {
        field_name: index.fieldName,
        field_schema: index.schema,
      });
      createdIndexes.push(index.fieldName);
    } catch (err) {
      if (!isPayloadIndexAlreadyExistsError(err)) throw err;
    }
  }

  if (createdIndexes.length > 0) {
    console.log(`Ensured Qdrant payload indexes: ${createdIndexes.join(', ')}`);
  }
}

export async function ensureCollection(): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === config.qdrantCollection);

  if (!exists) {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: {
        size: QDRANT_VECTOR_SIZE,
        distance: 'Cosine',
      },
    });

    console.log(`Created Qdrant collection: ${config.qdrantCollection}`);
  }

  await ensurePayloadIndexes();
}

function mapQdrantSearchResults(results: QdrantSearchResult[]): SearchChunk[] {
  const readSemanticFacts = (value: unknown): SemanticFacts | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const facts: SemanticFacts = {};
    for (const [property, rawValues] of Object.entries(value as Record<string, unknown>)) {
      const values = Array.isArray(rawValues)
        ? rawValues.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (values.length > 0) facts[property] = values;
    }

    return Object.keys(facts).length > 0 ? facts : undefined;
  };

  const readString = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim().length > 0 ? value : undefined
  );

  return results.map((r) => ({
    id: typeof r.id === 'number' ? r.id : Number(r.id),
    pageId: (r.payload?.page_id as number) ?? 0,
    title: (r.payload?.title as string) ?? '',
    text: (r.payload?.text as string) ?? '',
    namespace: (r.payload?.namespace as number) ?? 0,
    allowedGroups: (r.payload?.allowed_groups as string[]) ?? ['*'],
    score: r.score,
    sourceType: readString(r.payload?.source_type),
    attachmentFilename: readString(r.payload?.attachment_filename),
    chunkIndex: typeof r.payload?.chunk_index === 'number' ? r.payload.chunk_index : undefined,
    totalChunks: typeof r.payload?.total_chunks === 'number' ? r.payload.total_chunks : undefined,
    lastModified: readString(r.payload?.last_modified),
    semanticFacts: readSemanticFacts(r.payload?.semantic_facts),
  }));
}

export async function searchChunkCandidates(
  vector: number[],
  candidateLimit: number
): Promise<SearchChunk[]> {
  const normalizedLimit = normalizeCandidateLimit(candidateLimit);

  const results = await qdrant.search(config.qdrantCollection, {
    vector,
    limit: normalizedLimit,
    with_payload: true,
  });

  return mapQdrantSearchResults(results);
}

export async function searchChunks(
  vector: number[],
  topK: number = 5
): Promise<SearchChunk[]> {
  const normalizedTopK = normalizeTopK(topK);
  return searchChunkCandidates(vector, normalizedTopK * 5);
}

export function normalizeTopK(topK: number | undefined, fallback = 5): number {
  const value = topK ?? fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_SEARCH_TOP_K);
}

export function normalizeCandidateLimit(limit: number | undefined, fallback = 50): number {
  const value = limit ?? fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_VECTOR_CANDIDATE_LIMIT);
}
