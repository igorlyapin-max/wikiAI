import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { runReindex } from '../reindex.js';

const fetchAllPages = vi.hoisted(() => vi.fn());
const fetchPageContent = vi.hoisted(() => vi.fn());
const fetchPageCategories = vi.hoisted(() => vi.fn());
const fetchSemanticFacts = vi.hoisted(() => vi.fn());
const getMediaWikiServiceAuthStatus = vi.hoisted(() => vi.fn());
const upsertChunks = vi.hoisted(() => vi.fn());
const fetchEffectiveEmbeddingConfig = vi.hoisted(() => vi.fn());
const enrichPageForReindex = vi.hoisted(() => vi.fn());

vi.mock('../mediawiki.js', () => ({
  fetchAllPages,
  fetchPageContent,
  fetchPageCategories,
  fetchPageFiles: vi.fn(),
  fetchFileInfo: vi.fn(),
  downloadFile: vi.fn(),
  fetchSemanticFacts,
  getMediaWikiServiceAuthStatus,
  semanticFactsToText: (facts: Record<string, string[]>) => Object.entries(facts)
    .map(([property, values]) => `${property}: ${values.join(', ')}`)
    .join('\n'),
}));

vi.mock('../qdrant.js', () => ({
  upsertChunks,
  upsertAttachmentChunks: vi.fn(),
  upsertAttachmentMetadata: vi.fn(),
}));

vi.mock('../document-policy.js', () => ({
  getDocumentProcessingConfig: vi.fn(async () => ({ attachmentsEnabled: true, mimeTypes: {} })),
  getMimeProcessingRule: vi.fn(() => ({ mode: 'metadata' })),
}));

vi.mock('../gateway.js', () => ({
  fetchEffectiveEmbeddingConfig,
  enrichPageForReindex,
}));

describe('runReindex', () => {
  let previousDatabaseUrl: string;

  beforeEach(() => {
    previousDatabaseUrl = config.databaseUrl;
    fetchAllPages.mockReset();
    fetchPageContent.mockReset();
    fetchPageCategories.mockReset();
    fetchSemanticFacts.mockReset();
    getMediaWikiServiceAuthStatus.mockReset();
    getMediaWikiServiceAuthStatus.mockReturnValue({
      configured: true,
      source: 'service_credentials',
      usernameConfigured: true,
      passwordConfigured: true,
      passwordUsesSecretReference: false,
      pamProviderConfigured: false,
      deprecatedCookieConfigured: false,
    });
    upsertChunks.mockReset();
    fetchEffectiveEmbeddingConfig.mockReset();
    fetchEffectiveEmbeddingConfig.mockResolvedValue({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
      apiKeyConfigured: false,
    });
    enrichPageForReindex.mockReset();
  });

  afterEach(() => {
    config.databaseUrl = previousDatabaseUrl;
  });

  it('reindexes requested pages with semantic facts and without attachments by default', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Public' },
      { pageid: 2, ns: 0, title: 'Skipped by maxPages' },
    ]);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 0,
      title: 'Public',
      content: 'Page body',
      lastModified: '2024-01-15T10:00:00Z',
    });
    fetchSemanticFacts.mockResolvedValueOnce({ 'Тип документа': ['FAQ'] });

    const summary = await runReindex({ maxPages: 1 });

    expect(summary).toMatchObject({
      namespaces: [0],
      matchedPages: 2,
      limitApplied: 1,
      totalPages: 1,
      processed: 1,
      skipped: 0,
      failed: 0,
      attachmentsProcessed: 0,
      attachmentsFailed: 0,
    });
    expect(upsertChunks).toHaveBeenCalledTimes(1);
    expect(upsertChunks.mock.calls[0][5]).toBe('2024-01-15T10:00:00Z');
    expect(upsertChunks.mock.calls[0][6]).toEqual({ 'Тип документа': ['FAQ'] });
  });

  it('reindexes all matched pages when maxPages is not set', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'First' },
      { pageid: 2, ns: 0, title: 'Second' },
    ]);
    fetchPageContent
      .mockResolvedValueOnce({ pageid: 1, ns: 0, title: 'First', content: 'First page body' })
      .mockResolvedValueOnce({ pageid: 2, ns: 0, title: 'Second', content: 'Second page body' });

    const summary = await runReindex({ semanticFactsEnabled: false });

    expect(summary).toMatchObject({
      matchedPages: 2,
      totalPages: 2,
      processed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(summary.limitApplied).toBeUndefined();
    expect(upsertChunks).toHaveBeenCalledTimes(2);
  });

  it('records page failures and continues', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Broken' },
    ]);
    fetchPageContent.mockRejectedValueOnce(new Error('MediaWiki unavailable'));

    const summary = await runReindex();

    expect(summary.processed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(upsertChunks).not.toHaveBeenCalled();
  });

  it('counts empty or unreadable pages as skipped', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Empty' },
      { pageid: 2, ns: 0, title: 'Readable' },
    ]);
    fetchPageContent
      .mockResolvedValueOnce({ pageid: 1, ns: 0, title: 'Empty', content: '' })
      .mockResolvedValueOnce({ pageid: 2, ns: 0, title: 'Readable', content: 'Readable body' });

    const summary = await runReindex({ semanticFactsEnabled: false });

    expect(summary).toMatchObject({
      matchedPages: 2,
      totalPages: 2,
      processed: 1,
      skipped: 1,
      failed: 0,
    });
    expect(upsertChunks).toHaveBeenCalledTimes(1);
  });

  it('passes explicit SMW properties to semantic fact fetch', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Public' },
    ]);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 0,
      title: 'Public',
      content: 'Page body',
    });
    fetchSemanticFacts.mockResolvedValueOnce({ Департамент: ['ИТ'] });

    await runReindex({
      maxPages: 1,
      semanticFactsEnabled: true,
      smwProperties: ['Департамент', 'Тип документа'],
    });

    expect(fetchSemanticFacts).toHaveBeenCalledWith(
      'Public',
      ['Департамент', 'Тип документа']
    );
  });

  it('supports dry-run profile reindex without writing chunks', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Dry Run Page' },
    ]);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 0,
      title: 'Dry Run Page',
      content: 'A long enough page body for dry run chunking',
    });

    const summary = await runReindex({
      profileId: 'profile-test',
      maxPages: 1,
      dryRun: true,
      semanticFactsEnabled: false,
      chunkSize: 128,
      chunkOverlap: 0,
    });

    expect(summary).toMatchObject({
      profileId: 'profile-test',
      dryRun: true,
      processed: 1,
      failed: 0,
    });
    expect(summary.totalChunks).toBeGreaterThan(0);
    expect(upsertChunks).not.toHaveBeenCalled();
  });

  it('adds optional LLM enrichment to indexed text and payload', async () => {
    fetchEffectiveEmbeddingConfig.mockResolvedValueOnce({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:4000/v1',
      model: 'text-embedding-3-small',
      dimensions: 768,
      apiKeyConfigured: true,
    });
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Enriched Page' },
    ]);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 0,
      title: 'Enriched Page',
      content: 'Long policy body',
      lastModified: '2026-06-01T10:00:00Z',
    });
    fetchSemanticFacts.mockResolvedValueOnce({ 'Тип документа': ['Регламент'] });
    enrichPageForReindex.mockResolvedValueOnce({
      summary: 'Short AI summary',
      keywords: ['policy', 'vpn'],
      model: 'gpt-4.1-mini',
      inputChars: 16,
    });

    const summary = await runReindex({
      maxPages: 1,
      llmEnrichmentEnabled: true,
      llmEnrichmentModel: 'gpt-4.1-mini',
      llmEnrichmentMaxChars: 1200,
    });

    expect(enrichPageForReindex).toHaveBeenCalledWith({
      title: 'Enriched Page',
      text: 'Long policy body',
      model: 'gpt-4.1-mini',
      maxChars: 1200,
    });
    expect(upsertChunks).toHaveBeenCalledTimes(1);
    expect(upsertChunks.mock.calls[0][3][0].text).toContain('AI summary: Short AI summary');
    expect(upsertChunks.mock.calls[0][7]).toEqual({
      summary: 'Short AI summary',
      keywords: ['policy', 'vpn'],
      model: 'gpt-4.1-mini',
    });
    expect(summary.llmEnrichmentCalls).toBe(1);
    expect(summary.embeddingCalls).toBe(summary.totalChunks);
    expect(summary.estimatedPaidCalls).toBe(summary.totalChunks + 1);
  });

  it('does not require SQLite profile storage when Gateway sends resolved profile options', async () => {
    config.databaseUrl = 'sqlite:///tmp/wikiai-missing-profile-store/wiki-ai.sqlite';
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 0, title: 'Resolved Profile Page' },
    ]);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 0,
      title: 'Resolved Profile Page',
      content: 'Resolved profile body',
    });

    const summary = await runReindex({
      profileId: 'default',
      attachmentsEnabled: false,
      semanticFactsEnabled: false,
      smwProperties: [],
      namespaces: [0],
      namespaceAcl: { '0': ['*'] },
      titleFilters: { include: [], exclude: [] },
      categoryFilters: { include: [], exclude: [] },
      documentPolicyId: 'default',
      chunkSize: 512,
      chunkOverlap: 50,
      chunkSeparators: ['\n\n', '\n', ' '],
      dryRun: true,
    });

    expect(summary).toMatchObject({
      profileId: 'default',
      matchedPages: 1,
      totalPages: 1,
      processed: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('applies profile title/category filters and namespace ACL overrides', async () => {
    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 3030, title: 'CorpIT:VPN FAQ' },
      { pageid: 2, ns: 3030, title: 'CorpIT:Черновик VPN' },
      { pageid: 3, ns: 3030, title: 'CorpIT:Archive Policy' },
      { pageid: 4, ns: 3030, title: 'CorpIT:Audit Policy' },
    ]);
    fetchPageCategories.mockResolvedValueOnce(['Категория:ИТ'])
      .mockResolvedValueOnce(['Категория:Архив'])
      .mockResolvedValueOnce(['Категория:Аудит']);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 3030,
      title: 'CorpIT:VPN FAQ',
      content: 'VPN instruction body',
    });

    const summary = await runReindex({
      namespaces: [3030],
      namespaceAcl: { '3030': ['ai-it', 'ai-exec'] },
      titleFilters: { include: ['CorpIT:'], exclude: ['Черновик'] },
      categoryFilters: { include: ['ИТ'], exclude: ['Архив'] },
      semanticFactsEnabled: false,
    });

    expect(summary).toMatchObject({
      namespaces: [3030],
      matchedPages: 1,
      totalPages: 1,
      processed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(fetchPageContent).toHaveBeenCalledWith('CorpIT:VPN FAQ');
    expect(fetchPageContent).not.toHaveBeenCalledWith('CorpIT:Audit Policy');
    expect(upsertChunks.mock.calls[0][4]).toEqual(['ai-it', 'ai-exec']);
  });

  it('rejects protected namespace reindex before fetching pages when MediaWiki service auth is missing', async () => {
    getMediaWikiServiceAuthStatus.mockReturnValueOnce({
      configured: false,
      source: 'none',
      usernameConfigured: false,
      passwordConfigured: false,
      passwordUsesSecretReference: false,
      pamProviderConfigured: false,
      deprecatedCookieConfigured: false,
    });

    await expect(runReindex({
      namespaces: [3030],
      namespaceAcl: { '3030': ['ai-it', 'ai-exec'] },
      semanticFactsEnabled: false,
    })).rejects.toThrow('MediaWiki service auth is required before protected reindex');
    expect(fetchAllPages).not.toHaveBeenCalled();
    expect(upsertChunks).not.toHaveBeenCalled();
  });
});
