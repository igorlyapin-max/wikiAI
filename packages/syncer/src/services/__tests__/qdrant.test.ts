import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteMock = vi.hoisted(() => vi.fn());
const upsertMock = vi.hoisted(() => vi.fn());
const getEmbedding = vi.hoisted(() => vi.fn());
const syncSearchIndexPage = vi.hoisted(() => vi.fn());

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn(function QdrantClient() {
    return {
      delete: deleteMock,
      upsert: upsertMock,
      scroll: vi.fn(),
    };
  }),
}));

vi.mock('../embedding.js', () => ({
  getEmbedding,
}));

vi.mock('../gateway.js', () => ({
  syncSearchIndexPage,
}));

describe('qdrant indexing payload', () => {
  beforeEach(() => {
    deleteMock.mockReset();
    upsertMock.mockReset();
    getEmbedding.mockReset();
    syncSearchIndexPage.mockReset();
    getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    syncSearchIndexPage.mockResolvedValue({ status: 'ok', url: 'gateway', chunks: 1 });
  });

  it('marks Mermaid page chunks and forwards content type to Gateway', async () => {
    const { upsertChunks } = await import('../qdrant.js');

    await upsertChunks(
      12,
      'Diagram',
      0,
      [{ text: '```mermaid\ngraph TD; A-->B;\n```', index: 0, total: 1 }],
      ['*'],
      '2026-06-01T10:00:00Z'
    );

    expect(upsertMock).toHaveBeenCalledWith('test_chunks', {
      points: [
        expect.objectContaining({
          payload: expect.objectContaining({
            content_type: 'mermaid',
          }),
        }),
      ],
    });
    expect(syncSearchIndexPage).toHaveBeenCalledWith(expect.objectContaining({
      chunks: [
        expect.objectContaining({
          contentType: 'mermaid',
        }),
      ],
    }));
  });

  it('normalizes page chunk text before writing Qdrant payloads and Gateway search index', async () => {
    const { upsertChunks } = await import('../qdrant.js');

    await upsertChunks(
      13,
      'RAG и Chunking',
      0,
      [{
        text: 'Запрос <code>древние цивилизации</code> найдет &lt;code&gt;Древний Египет&lt;/code&gt;.',
        index: 0,
        total: 1,
      }],
      ['*'],
      '2026-06-01T10:00:00Z'
    );

    expect(upsertMock).toHaveBeenCalledWith('test_chunks', {
      points: [
        expect.objectContaining({
          payload: expect.objectContaining({
            text: 'Запрос древние цивилизации найдет Древний Египет.',
          }),
        }),
      ],
    });
    expect(syncSearchIndexPage).toHaveBeenCalledWith(expect.objectContaining({
      chunks: [
        expect.objectContaining({
          text: 'Запрос древние цивилизации найдет Древний Египет.',
        }),
      ],
    }));
  });

  it('forwards attachment MIME and processing mode to Gateway', async () => {
    const { upsertAttachmentMetadata } = await import('../qdrant.js');

    await upsertAttachmentMetadata(
      12,
      'Page',
      'archive.zip',
      'application/zip',
      'Attachment metadata: archive.zip',
      ['*'],
      '2026-06-01T10:00:00Z',
      { mode: 'metadata' }
    );

    expect(upsertMock).toHaveBeenCalledWith('test_chunks', expect.objectContaining({
      points: [
        expect.objectContaining({
          payload: expect.objectContaining({
            attachment_mime: 'application/zip',
            attachment_processing_mode: 'metadata',
          }),
        }),
      ],
    }));
    expect(syncSearchIndexPage).toHaveBeenCalledWith(expect.objectContaining({
      chunks: [
        expect.objectContaining({
          mimeType: 'application/zip',
          processingMode: 'metadata',
        }),
      ],
    }));
  });

  it('writes cmdbdynamicpages static snapshot chunks as an additional page source', async () => {
    const { upsertCmdbDynamicSnapshotChunks } = await import('../qdrant.js');

    await upsertCmdbDynamicSnapshotChunks(
      12,
      'Page',
      0,
      [{
        text: 'CMDB dynamic snapshot: Assets\nsrv-01',
        source: {
          sourceId: 'source-1',
          markerType: 'parser_function',
          templateCode: 'Assets',
          params: { city: 'city49' },
          allowAnonymousSnapshot: true,
        },
        status: 'snapshot_hit',
        paramsHash: 'params-hash',
        snapshotFound: true,
        publishedBy: 'admin',
        publishedAt: '2026-06-04T10:00:00Z',
        specHash: 'spec-hash',
      }],
      ['*'],
      '2026-06-01T10:00:00Z'
    );

    expect(upsertMock).toHaveBeenCalledWith('test_chunks', {
      points: [
        expect.objectContaining({
          id: 1270000,
          payload: expect.objectContaining({
            source_type: 'cmdbdynamicpages',
            content_type: 'cmdbdynamicpages_static_snapshot',
            cmdbdynamic_template_code: 'Assets',
            cmdbdynamic_snapshot_status: 'snapshot_hit',
            cmdbdynamic_snapshot_found: true,
          }),
        }),
      ],
    });
    expect(syncSearchIndexPage).toHaveBeenCalledWith(expect.objectContaining({
      replacePage: false,
      chunks: [
        expect.objectContaining({
          sourceType: 'cmdbdynamicpages',
          contentType: 'cmdbdynamicpages_static_snapshot',
        }),
      ],
    }));
  });
});
