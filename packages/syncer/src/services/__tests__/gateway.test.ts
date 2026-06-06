import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSearchIndexPage,
  enrichPageForReindex,
  fetchEffectiveEmbeddingConfig,
  fetchGatewayEmbedding,
  fetchIndexingAutomationConfig,
  fetchIndexedSmwProperties,
  notifyTrustRecalculation,
  syncSearchIndexPage,
} from '../gateway.js';

describe('gateway notifications', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('notifies Gateway to recalculate trust for a webhook page', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyTrustRecalculation({
      pageId: 42,
      reason: 'webhook-edit',
    });

    expect(result).toMatchObject({
      status: 'ok',
      url: 'http://localhost:3000/api/internal/trust/recalculate-page',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/trust/recalculate-page',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ pageId: 42, reason: 'webhook-edit' }),
      })
    );
  });

  it('returns error status without throwing when Gateway notification fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'Gateway unavailable',
    })));

    await expect(
      notifyTrustRecalculation({ pageId: 42, reason: 'webhook-protect' })
    ).resolves.toMatchObject({
      status: 'error',
      httpStatus: 503,
      error: 'Gateway unavailable',
    });
  });

  it('loads indexed SMW properties from Gateway for webhook indexing', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ values: ['Департамент', 'Статус документа', 'Департамент'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchIndexedSmwProperties()).resolves.toEqual({
      properties: ['Департамент', 'Статус документа'],
      source: 'gateway',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/smw/indexed-properties',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('keeps an empty Gateway indexed properties list as an admin choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ values: [] }),
    })));

    await expect(fetchIndexedSmwProperties()).resolves.toEqual({
      properties: [],
      source: 'gateway',
    });
  });

  it('loads indexing automation config from Gateway', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        values: {
          changeIndexingProfileId: 'change-profile',
          scheduledReindexProfileId: 'nightly-profile',
          scheduleEnabled: true,
          scheduleIntervalMinutes: 60,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchIndexingAutomationConfig()).resolves.toMatchObject({
      changeIndexingProfileId: 'change-profile',
      scheduledReindexProfileId: 'nightly-profile',
      scheduleEnabled: true,
      scheduleIntervalMinutes: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/indexing-automation',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('falls back to Syncer config when Gateway indexed properties are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })));

    await expect(fetchIndexedSmwProperties()).resolves.toMatchObject({
      source: 'config',
      error: 'Gateway HTTP 503',
    });
  });

  it('syncs page chunks to the Gateway lexical search index', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        values: {
          chunks: 3,
          chunksByTarget: { bm25: 1, opensearch: 1, colbert: 1 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(syncSearchIndexPage({
      pageId: 42,
      title: 'CorpIT:FAQ VPN',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      lastModified: '2026-06-01T10:00:00Z',
      replacePage: true,
      chunks: [
        {
          id: 420000,
          text: 'VPN access requires MFA.',
          chunkIndex: 0,
          totalChunks: 1,
        },
      ],
    })).resolves.toMatchObject({
      status: 'ok',
      url: 'http://localhost:3000/api/internal/search-index/page',
      httpStatus: 200,
      chunks: 3,
      targetWrites: { bm25: 1, opensearch: 1, colbert: 1 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/search-index/page',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"pageId":42'),
      })
    );
  });

  it('notifies Gateway to delete lexical chunks for a deleted page', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ values: { chunks: 0 } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteSearchIndexPage(42)).resolves.toMatchObject({
      status: 'ok',
      url: 'http://localhost:3000/api/internal/search-index/delete-page',
      httpStatus: 200,
      chunks: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/search-index/delete-page',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ pageId: 42 }),
      })
    );
  });

  it('loads effective embedding config from Gateway', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        values: {
          provider: 'openai_compatible',
          baseUrl: 'http://litellm:4000/v1',
          model: 'text-embedding-3-small',
          dimensions: 768,
          apiKeyConfigured: true,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchEffectiveEmbeddingConfig()).resolves.toEqual({
      provider: 'openai_compatible',
      baseUrl: 'http://litellm:4000/v1',
      model: 'text-embedding-3-small',
      dimensions: 768,
      apiKeyConfigured: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/embedding/config',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('requests embedding vectors from Gateway', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        values: {
          vector: [0.1, 0.2, 0.3],
          provider: 'ollama',
          model: 'nomic-embed-text',
          dimensions: 3,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGatewayEmbedding('Page text')).resolves.toEqual({
      vector: [0.1, 0.2, 0.3],
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/embedding/vector',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Page text' }),
      })
    );
  });

  it('rejects empty Gateway embedding config responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })));

    await expect(fetchEffectiveEmbeddingConfig()).rejects.toThrow('Gateway embedding config response is empty');
  });

  it('surfaces Gateway embedding vector errors with response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => 'embedding unavailable',
    })));

    await expect(fetchGatewayEmbedding('Page text')).rejects.toThrow(
      'Gateway embedding error 502: embedding unavailable'
    );
  });

  it('requests LLM enrichment from Gateway for reindex', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        values: {
          summary: 'Short summary',
          keywords: ['vpn', 'mfa'],
          model: 'gpt-4.1-mini',
          inputChars: 120,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichPageForReindex({
      title: 'CorpIT:VPN',
      text: 'VPN page body',
      model: 'gpt-4.1-mini',
      maxChars: 1200,
    })).resolves.toEqual({
      summary: 'Short summary',
      keywords: ['vpn', 'mfa'],
      model: 'gpt-4.1-mini',
      inputChars: 120,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/internal/reindex/llm-enrich',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'CorpIT:VPN',
          text: 'VPN page body',
          model: 'gpt-4.1-mini',
          maxChars: 1200,
        }),
      })
    );
  });

  it('rejects malformed Gateway LLM enrichment responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ values: { keywords: ['vpn'] } }),
    })));

    await expect(enrichPageForReindex({
      title: 'CorpIT:VPN',
      text: 'VPN page body',
    })).rejects.toThrow('Gateway LLM enrichment response is empty');
  });
});
