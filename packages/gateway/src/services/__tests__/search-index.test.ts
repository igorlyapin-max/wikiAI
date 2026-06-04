import { beforeEach, describe, expect, it } from 'vitest';
import { getAdminSqliteDatabase, resetAdminStoreForTests } from '../../db/admin-store.js';
import {
  getSearchIndexStatus,
  getTrigramBackfillJobStatus,
  searchLexicalChunks,
  searchLexicalChunksWithDiagnostics,
  searchTrigramChunksWithDiagnostics,
  upsertSearchIndexPage,
} from '../search-index.js';

describe('search index metadata', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
  });

  it('stores attachment and Mermaid metadata for lexical search results', async () => {
    await upsertSearchIndexPage({
      pageId: 7,
      title: 'Docs',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [
        {
          id: 70000,
          text: 'Attachment metadata archive zip',
          chunkIndex: 0,
          totalChunks: 2,
          sourceType: 'attachment',
          attachmentFilename: 'archive.zip',
          mimeType: 'application/zip',
          processingMode: 'metadata',
        },
        {
          id: 70001,
          text: '```mermaid\ngraph TD; A-->B;\n```',
          chunkIndex: 1,
          totalChunks: 2,
          contentType: 'mermaid',
        },
      ],
    });

    const attachment = await searchLexicalChunks('archive', 5);
    expect(attachment[0]).toMatchObject({
      sourceType: 'attachment',
      attachmentFilename: 'archive.zip',
      attachmentMime: 'application/zip',
      attachmentProcessingMode: 'metadata',
    });

    const mermaid = await searchLexicalChunks('graph', 5);
    expect(mermaid[0]).toMatchObject({
      contentType: 'mermaid',
    });
  });

  it('expands BM25 queries with administrator synonyms only when enabled', async () => {
    await upsertSearchIndexPage({
      pageId: 8,
      title: 'ServiceDesk',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{
        id: 80000,
        text: 'Заявка на доступ к серверу передается в первую линию поддержки.',
      }],
    });

    const disabled = await searchLexicalChunksWithDiagnostics('тикет', 5, 1, {
      synonymsEnabled: false,
      synonyms: [{ term: 'тикет', synonyms: ['заявка'] }],
    });
    const enabled = await searchLexicalChunksWithDiagnostics('тикет', 5, 1, {
      synonymsEnabled: true,
      synonyms: [{ term: 'тикет', synonyms: ['заявка'] }],
    });

    expect(disabled.chunks).toEqual([]);
    expect(enabled.synonymTerms).toContain('заявк');
    expect(enabled.chunks[0]).toMatchObject({ id: 80000 });
  });

  it('expands Latin and Cyrillic technical terms without Soundex', async () => {
    await upsertSearchIndexPage({
      pageId: 9,
      title: 'Infra',
      namespace: 0,
      allowedGroups: ['*'],
      chunks: [{
        id: 90000,
        text: 'Server gateway policy and router diagnostics.',
      }],
    });

    const result = await searchLexicalChunksWithDiagnostics('сервер роутер', 5, 2, {
      transliterationEnabled: true,
    });

    expect(result.transliterationTerms).toEqual(expect.arrayContaining(['serve', 'route']));
    expect(result.chunks[0]).toMatchObject({ id: 90000 });
  });

  it('keeps a trigram index and finds typo candidates from it', async () => {
    await upsertSearchIndexPage({
      pageId: 10,
      title: 'CorpIT:Администрирование систем',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      chunks: [{
        id: 100000,
        text: 'Регламент администрирования информационных систем.',
      }],
    });

    const status = await getSearchIndexStatus();
    expect(status).toMatchObject({
      trigramChunks: 1,
      trigramFtsChunks: 1,
      trigramPopulated: true,
      trigramBackfillRecommended: false,
    });

    const result = await searchTrigramChunksWithDiagnostics('адмиристрирование систем', 5, 4);
    expect(result.chunks[0]).toMatchObject({
      id: 100000,
      title: 'CorpIT:Администрирование систем',
    });
  });

  it('does not mark a fresh running trigram backfill job stale without a local owner', async () => {
    const now = new Date().toISOString();
    getAdminSqliteDatabase()
      .prepare(
        `INSERT INTO ai_search_backfill_jobs
          (id, type, status, total_chunks, processed_chunks, written_chunks, grams, started_at, updated_at)
         VALUES (?, 'trigram', 'running', 1000, 250, 250, 1500, ?, ?)`
      )
      .run('fresh-running-job', now, now);

    const status = await getTrigramBackfillJobStatus();

    expect(status).toMatchObject({
      id: 'fresh-running-job',
      status: 'running',
      processedChunks: 250,
    });
  });
});
