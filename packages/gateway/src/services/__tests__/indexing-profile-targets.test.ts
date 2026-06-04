import { beforeEach, describe, expect, it } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import {
  applyIndexingProfileToReindexRequest,
  upsertIndexingProfile,
} from '../admin-platform-config.js';

describe('indexing profile targets', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
  });

  it('persists indexTargets and applies them to reindex requests', async () => {
    const profile = await upsertIndexingProfile({
      id: 'colbert-only',
      name: 'ColBERT only',
      namespaces: [0],
      indexTargets: ['colbert'],
      attachmentsEnabled: false,
      semanticFactsEnabled: false,
      chunkSize: 512,
      chunkOverlap: 50,
      chunkSeparators: ['\n\n'],
    });

    expect(profile.indexTargets).toEqual(['colbert']);
    await expect(applyIndexingProfileToReindexRequest({
      profileId: 'colbert-only',
      source: 'qdrant_payload',
    })).resolves.toMatchObject({
      profileId: 'colbert-only',
      indexTargets: ['colbert'],
      source: 'qdrant_payload',
      attachmentsEnabled: false,
      semanticFactsEnabled: false,
    });
  });
});
