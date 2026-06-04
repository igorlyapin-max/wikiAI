import { beforeEach, describe, expect, it } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { getRagAdminConfig } from '../admin-platform-config.js';
import {
  createColbertIndexSpec,
  getColbertIndexSpecs,
  promoteColbertIndexSpec,
  updateColbertIndexSpecStatus,
} from '../colbert-indexes.js';

describe('ColBERT index specs', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
  });

  it('creates candidate indexes without changing active RAG config', async () => {
    const before = await getRagAdminConfig();
    const spec = await createColbertIndexSpec({
      model: 'candidate-model',
      collection: 'wiki_colbert_candidate',
      source: 'qdrant_payload',
    });

    expect(spec).toMatchObject({
      model: 'candidate-model',
      collection: 'wiki_colbert_candidate',
      status: 'building',
      active: false,
    });
    await expect(promoteColbertIndexSpec(spec.id)).rejects.toThrow('must be complete');
    await expect(getRagAdminConfig()).resolves.toMatchObject({
      colbertModel: before.colbertModel,
      colbertCollection: before.colbertCollection,
    });
  });

  it('promotes complete candidate indexes into active RAG config', async () => {
    const spec = await createColbertIndexSpec({
      model: 'candidate-model',
      collection: 'wiki_colbert_candidate',
    });
    await updateColbertIndexSpecStatus(spec.id, {
      status: 'complete',
      pagesProcessed: 10,
      chunksIndexed: 50,
      failures: 0,
    });

    const promoted = await promoteColbertIndexSpec(spec.id);
    const indexes = await getColbertIndexSpecs();

    expect(promoted.active).toBe(true);
    expect(indexes.find((item) => item.id === spec.id)).toMatchObject({
      active: true,
      status: 'complete',
    });
    await expect(getRagAdminConfig()).resolves.toMatchObject({
      colbertEnabled: true,
      colbertModel: 'candidate-model',
      colbertCollection: 'wiki_colbert_candidate',
      colbertFailMode: 'fail_search',
    });
  });
});
