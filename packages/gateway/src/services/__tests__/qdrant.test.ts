import { beforeEach, describe, expect, it, vi } from 'vitest';

const qdrantClient = vi.hoisted(() => ({
  getCollections: vi.fn(),
  createCollection: vi.fn(),
  getCollection: vi.fn(),
  createPayloadIndex: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn(function QdrantClient() {
    return qdrantClient;
  }),
}));

import {
  ensureCollection,
  ensurePayloadIndexes,
  normalizeTopK,
  REQUIRED_QDRANT_PAYLOAD_INDEXES,
  searchChunks,
} from '../qdrant.js';

describe('qdrant collection bootstrap', () => {
  beforeEach(() => {
    qdrantClient.getCollections.mockReset();
    qdrantClient.createCollection.mockReset();
    qdrantClient.getCollection.mockReset();
    qdrantClient.createPayloadIndex.mockReset();
    qdrantClient.search.mockReset();
    qdrantClient.createCollection.mockResolvedValue({ operation_id: 1, status: 'completed' });
    qdrantClient.createPayloadIndex.mockResolvedValue({ operation_id: 1, status: 'completed' });
  });

  it('creates collection and all required payload indexes', async () => {
    qdrantClient.getCollections.mockResolvedValue({ collections: [] });
    qdrantClient.getCollection.mockResolvedValue({ payload_schema: {} });

    await ensureCollection();

    expect(qdrantClient.createCollection).toHaveBeenCalledWith('test_chunks', {
      vectors: {
        size: 768,
        distance: 'Cosine',
      },
    });
    expect(qdrantClient.createPayloadIndex).toHaveBeenCalledTimes(
      REQUIRED_QDRANT_PAYLOAD_INDEXES.length
    );
    expect(qdrantClient.createPayloadIndex.mock.calls.map((call) => call[1])).toEqual(
      REQUIRED_QDRANT_PAYLOAD_INDEXES.map((index) => ({
        field_name: index.fieldName,
        field_schema: index.schema,
      }))
    );
  });

  it('creates missing payload indexes for an existing collection', async () => {
    qdrantClient.getCollections.mockResolvedValue({ collections: [{ name: 'test_chunks' }] });
    qdrantClient.getCollection.mockResolvedValue({
      payload_schema: {
        allowed_groups: { data_type: 'keyword', points: 10 },
        namespace: { data_type: 'integer', points: 10 },
        trust_score: { data_type: 'float', points: 0 },
      },
    });

    await ensureCollection();

    const createdFieldNames = qdrantClient.createPayloadIndex.mock.calls.map(
      (call) => call[1].field_name
    );
    expect(qdrantClient.createCollection).not.toHaveBeenCalled();
    expect(createdFieldNames).not.toContain('allowed_groups');
    expect(createdFieldNames).not.toContain('namespace');
    expect(createdFieldNames).not.toContain('trust_score');
    expect(createdFieldNames).toContain('trust_flags');
    expect(createdFieldNames).toContain('trust_include_in_context');
    expect(createdFieldNames).toContain('trust_calculated_at');
  });

  it('fails on incompatible payload index types', async () => {
    qdrantClient.getCollection.mockResolvedValue({
      payload_schema: {
        allowed_groups: { data_type: 'keyword', points: 10 },
        namespace: { data_type: 'integer', points: 10 },
        trust_score: { data_type: 'keyword', points: 1 },
      },
    });

    await expect(ensurePayloadIndexes()).rejects.toThrow(
      'Qdrant payload index "trust_score" has type "keyword", expected "float"'
    );
  });

  it('searches candidate chunks without using allowed_groups as a security filter', async () => {
    qdrantClient.search.mockResolvedValue([{
      id: 100,
      score: 0.8,
      payload: {
        page_id: 10,
        title: 'CorpHR:Policy',
        text: 'policy',
        namespace: 3010,
        allowed_groups: ['ai-hr'],
      },
    }]);

    const chunks = await searchChunks([0.1, 0.2], 3);

    expect(qdrantClient.search).toHaveBeenCalledWith('test_chunks', {
      vector: [0.1, 0.2],
      limit: 15,
      with_payload: true,
    });
    expect(chunks[0]).toMatchObject({
      title: 'CorpHR:Policy',
      allowedGroups: ['ai-hr'],
    });
  });

  it('normalizes topK before expanding the candidate pool', () => {
    expect(normalizeTopK(0)).toBe(1);
    expect(normalizeTopK(3.8)).toBe(3);
    expect(normalizeTopK(1000)).toBe(20);
    expect(normalizeTopK(undefined, 7)).toBe(7);
  });
});
