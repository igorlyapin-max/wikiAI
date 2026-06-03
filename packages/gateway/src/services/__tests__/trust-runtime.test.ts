import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { upsertTrustEntity, upsertTrustModel, upsertTrustRule } from '../admin-platform-config.js';
import { applyTrustPolicyToChunks } from '../trust-runtime.js';
import { SearchChunk } from '../../types/index.js';

const redisStore = vi.hoisted(() => new Map<string, string>());

vi.mock('../redis.js', () => ({
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    }),
  },
}));

describe('trust runtime filtering', () => {
  beforeEach(() => {
    redisStore.clear();
    resetAdminStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enriches trusted chunks and filters drafts from context', async () => {
    await upsertTrustModel({
      id: 'corp-default',
      name: 'Corporate default',
      active: true,
      baseScore: 0.6,
      minTrustScoreForContext: 0.5,
      includeDrafts: false,
      requireVerifiedForDirectAnswer: true,
      requireSources: true,
    });
    await upsertTrustEntity('corp-default', {
      id: 'approved-doc',
      entityType: 'smw_property',
      name: 'Approved document',
      value: 'Статус документа=Утвержден',
      weight: 0.2,
      enabled: true,
    });
    await upsertTrustRule('corp-default', 'approved-doc', {
      id: 'verified-flag',
      name: 'Verified flag',
      condition: {
        field: 'property',
        operator: 'equals',
        propertyName: 'Статус документа',
        value: 'Утвержден',
      },
      modifier: 0.1,
      flags: ['verified'],
    });

    const chunks: SearchChunk[] = [
      {
        id: 1,
        pageId: 1,
        title: 'CorpIT:Черновик VPN',
        text: 'draft',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.95,
        semanticFacts: { 'Статус документа': ['Черновик'] },
      },
      {
        id: 2,
        pageId: 2,
        title: 'CorpIT:Инструкция VPN',
        text: 'approved',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.9,
        semanticFacts: { 'Статус документа': ['Утвержден'] },
      },
    ];

    const result = await applyTrustPolicyToChunks(chunks, 5);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'CorpIT:Инструкция VPN',
      trust: {
        modelId: 'corp-default',
        score: 0.9,
        flags: ['verified'],
        appliedEntityIds: ['approved-doc'],
        appliedRuleIds: ['verified-flag'],
        decisions: {
          includeInContext: true,
          allowDirectAnswer: true,
          requireSources: true,
        },
      },
    });
  });

  it('reduces trust score by full years since last page edit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));

    await upsertTrustModel({
      id: 'age-aware',
      name: 'Age aware',
      active: true,
      baseScore: 0.7,
      minTrustScoreForContext: 0.4,
      includeDrafts: false,
      stalenessPenaltyPerYear: 0.1,
      requireVerifiedForDirectAnswer: true,
      requireSources: true,
    });

    const result = await applyTrustPolicyToChunks([
      {
        id: 3,
        pageId: 3,
        title: 'CorpIT:Старый регламент',
        text: 'approved but old',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.9,
        lastModified: '2023-01-15T00:00:00Z',
        semanticFacts: { 'Статус документа': ['Утвержден'] },
      },
    ], 5);

    expect(result).toHaveLength(1);
    expect(result[0].trust).toMatchObject({
      modelId: 'age-aware',
      score: 0.4,
      lastModified: '2023-01-15T00:00:00Z',
      ageYears: 3,
      stalenessPenalty: 0.3,
      decisions: {
        includeInContext: true,
        allowDirectAnswer: true,
      },
    });
  });
});
