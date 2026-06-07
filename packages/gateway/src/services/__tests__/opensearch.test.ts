import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import {
  analyzeOpenSearchQuery,
  getOpenSearchAttachmentDiagnostics,
  getOpenSearchStatus,
  searchOpenSearchChunksWithDiagnostics,
  upsertOpenSearchPage,
} from '../opensearch.js';
import { getRagAdminConfig } from '../admin-platform-config.js';

const originalConfig = { ...config };

function response(input: {
  ok: boolean;
  status: number;
  text?: unknown;
  json?: unknown;
}): Response {
  return {
    ok: input.ok,
    status: input.status,
    text: vi.fn(async () => (
      typeof input.text === 'string'
        ? input.text
        : input.text === undefined ? '' : JSON.stringify(input.text)
    )),
    json: vi.fn(async () => input.json ?? input.text ?? {}),
  } as unknown as Response;
}

describe('OpenSearch service', () => {
  beforeEach(() => {
    Object.assign(config, originalConfig, {
      opensearchEnabled: false,
      opensearchBaseUrl: 'http://user:secret@opensearch:9200',
      opensearchIndexName: 'wikiai_test',
      opensearchAnalyzer: 'russian',
      opensearchTimeoutMs: 5000,
      opensearchCandidateLimit: 50,
      opensearchFuzzyEnabled: true,
      opensearchHighlightEnabled: true,
      opensearchTitleBoost: 2,
      opensearchTextBoost: 1,
      opensearchUsername: '',
      opensearchPassword: '',
      opensearchApiKey: '',
    });
    resetAdminStoreForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.assign(config, originalConfig);
  });

  it('returns local analyzer tokens when OpenSearch is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeOpenSearchQuery('как там цивилизации');

    expect(result).toMatchObject({
      status: 'disabled',
      analyzer: 'russian',
      tokens: ['как', 'там', 'цивилизации'],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts credentials in status output', async () => {
    config.opensearchEnabled = true;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ ok: true, status: 200 }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, text: { count: 7 } }))
      .mockResolvedValueOnce(response({
        ok: true,
        status: 200,
        text: {
          aggregations: {
            sourceTypes: { buckets: [{ key: 'attachment', doc_count: 2 }] },
            attachmentDocs: { doc_count: 2 },
            attachmentFilenames: { buckets: [{ key: 'Wikiai-architecture.pptx', doc_count: 2 }] },
          },
        },
      })));

    const status = await getOpenSearchStatus();

    expect(status).toMatchObject({
      status: 'ok',
      ready: true,
      documentCount: 7,
      attachmentDocumentCount: 2,
      attachmentFilenames: [{ filename: 'Wikiai-architecture.pptx', count: 2 }],
    });
    expect(status.url).toBe('http://***:***@opensearch:9200/');
  });

  it('uses the compose OpenSearch URL when enabled with an empty configured URL', async () => {
    config.opensearchEnabled = true;
    config.opensearchBaseUrl = '';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, status: 200 }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, text: { count: 3 } }))
      .mockResolvedValueOnce(response({
        ok: true,
        status: 200,
        text: {
          aggregations: {
            sourceTypes: { buckets: [] },
            attachmentDocs: { doc_count: 0 },
            attachmentFilenames: { buckets: [] },
          },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await getOpenSearchStatus();

    expect(status).toMatchObject({
      status: 'ok',
      ready: true,
      url: 'http://opensearch:9200/',
      documentCount: 3,
      attachmentDocumentCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://opensearch:9200/wikiai_test',
      expect.objectContaining({ method: 'HEAD' })
    );
  });

  it('surfaces the compose OpenSearch URL when disabled with an empty configured URL', async () => {
    config.opensearchEnabled = false;
    config.opensearchBaseUrl = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const status = await getOpenSearchStatus();

    expect(status).toMatchObject({
      status: 'disabled',
      ready: false,
      url: 'http://opensearch:9200/',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports invalid enabled OpenSearch URLs without calling fetch', async () => {
    config.opensearchEnabled = true;
    config.opensearchBaseUrl = 'not-a-url';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const status = await getOpenSearchStatus();
    const analyze = await analyzeOpenSearchQuery('как там цивилизации');
    const search = await searchOpenSearchChunksWithDiagnostics(
      'как там цивилизации',
      5,
      await getRagAdminConfig()
    );

    expect(status).toMatchObject({
      status: 'error',
      ready: false,
      error: 'OpenSearch URL must be a valid HTTP(S) URL when OpenSearch is enabled',
    });
    expect(analyze).toMatchObject({
      status: 'error',
      error: 'OpenSearch URL must be a valid HTTP(S) URL when OpenSearch is enabled',
      tokens: ['как', 'там', 'цивилизации'],
    });
    expect(search.diagnostics).toMatchObject({
      enabled: true,
      ready: false,
      error: 'OpenSearch URL must be a valid HTTP(S) URL when OpenSearch is enabled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the index and writes chunks through bulk upsert', async () => {
    config.opensearchEnabled = true;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, status: 404 }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, text: {} }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, text: {} }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, json: { errors: false } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertOpenSearchPage({
      pageId: 10,
      title: 'Древний Египет',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{ id: 100000, text: 'Одна из древнейших цивилизаций мира.', chunkIndex: 0, totalChunks: 1 }],
      replacePage: true,
    });

    expect(result).toMatchObject({ status: 'ok', pageId: 10, chunks: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://opensearch:9200/_bulk?refresh=true',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
        body: expect.stringContaining('Древний Египет'),
      })
    );
  });

  it('returns OpenSearch chunks and diagnostics for retrieval', async () => {
    config.opensearchEnabled = true;
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true,
      status: 200,
      text: {
        hits: {
          total: { value: 1 },
          hits: [
            {
              _source: {
                chunkId: 100000,
                pageId: 10,
                title: 'Древний Египет',
                namespace: 0,
                text: 'Одна из древнейших цивилизаций мира.',
                allowedGroups: ['*'],
                chunkIndex: 0,
                totalChunks: 1,
              },
              highlight: { text: ['цивилизаций'] },
            },
          ],
        },
      },
    })));

    const result = await searchOpenSearchChunksWithDiagnostics(
      'как там цивилизации',
      5,
      await getRagAdminConfig()
    );

    expect(result.diagnostics).toMatchObject({
      enabled: true,
      ready: true,
      rawHits: 1,
      candidates: 1,
      highlightsAvailable: true,
      analyzedTerms: ['как', 'там', 'цивилизации'],
    });
    expect(result.chunks[0]).toMatchObject({
      id: 100000,
      title: 'Древний Египет',
      lexicalRank: 1,
    });
  });

  it('boosts exact attachment filename terms during retrieval', async () => {
    config.opensearchEnabled = true;
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => response({
      ok: true,
      status: 200,
      text: { hits: { total: { value: 0 }, hits: [] } },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await searchOpenSearchChunksWithDiagnostics(
      'Wikiai-architecture.pptx',
      5,
      await getRagAdminConfig()
    );

    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('OpenSearch search request was not sent');
    const body = JSON.parse((firstCall[1] as RequestInit).body as string);
    expect(body.query.bool.should).toContainEqual({
      term: {
        attachmentFilename: {
          value: 'Wikiai-architecture.pptx',
          boost: 8,
          case_insensitive: true,
        },
      },
    });
  });

  it('looks up attachment documents by filename', async () => {
    config.opensearchEnabled = true;
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true,
      status: 200,
      text: {
        hits: {
          total: { value: 1 },
          hits: [
            {
              _source: {
                chunkId: 10450000,
                pageId: 104,
                title: 'CorpCommon:Приказы/Режим рабочего времени',
                sourceType: 'attachment',
                attachmentFilename: 'Wikiai-architecture.pptx',
                attachmentMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                attachmentProcessingMode: 'text',
                chunkIndex: 0,
                totalChunks: 32,
              },
            },
          ],
        },
      },
    })));

    const result = await getOpenSearchAttachmentDiagnostics('Wikiai-architecture.pptx');

    expect(result).toMatchObject({
      status: 'ok',
      ready: true,
      found: true,
      chunks: 1,
      samples: [expect.objectContaining({
        pageId: 104,
        attachmentFilename: 'Wikiai-architecture.pptx',
      })],
    });
  });
});
