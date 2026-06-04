import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAllPages = vi.hoisted(() => vi.fn());
const fetchPageContent = vi.hoisted(() => vi.fn());
const fetchPageCategories = vi.hoisted(() => vi.fn());
const fetchSemanticFacts = vi.hoisted(() => vi.fn());
const getMediaWikiServiceAuthStatus = vi.hoisted(() => vi.fn());
const upsertChunks = vi.hoisted(() => vi.fn());
const fetchEffectiveEmbeddingConfig = vi.hoisted(() => vi.fn());
const fetchIndexingProfiles = vi.hoisted(() => vi.fn());
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
  fetchIndexingProfiles,
  enrichPageForReindex,
}));

describe('runReindex profile Gateway storage', () => {
  beforeEach(() => {
    vi.resetModules();
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
    fetchIndexingProfiles.mockReset();
    fetchIndexingProfiles.mockResolvedValue([]);
    enrichPageForReindex.mockReset();
    enrichPageForReindex.mockResolvedValue({
      summary: 'Profile enrichment summary',
      keywords: ['profile'],
      model: 'profile-enricher',
      inputChars: 20,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads indexing profile defaults from Gateway admin storage', async () => {
    fetchIndexingProfiles.mockResolvedValueOnce([
      {
        id: 'sql-profile',
        enabled: true,
        namespaces: [3030],
        namespaceAcl: { '3030': ['ai-it', 'ai-exec'] },
        titleFilters: { include: ['CorpIT:'], exclude: ['Черновик'] },
        categoryFilters: { include: ['ИТ'], exclude: ['Архив'] },
        documentPolicyId: 'default',
        attachmentsEnabled: false,
        semanticFactsEnabled: false,
        chunkSize: 128,
        chunkOverlap: 0,
        chunkSeparators: [' '],
        dryRunDefault: false,
        maxPagesDefault: 10,
      },
    ]);

    fetchAllPages.mockResolvedValueOnce([
      { pageid: 1, ns: 3030, title: 'CorpIT:VPN FAQ' },
      { pageid: 2, ns: 3030, title: 'CorpIT:Черновик VPN' },
    ]);
    fetchPageCategories.mockResolvedValueOnce(['Категория:ИТ']);
    fetchPageContent.mockResolvedValueOnce({
      pageid: 1,
      ns: 3030,
      title: 'CorpIT:VPN FAQ',
      content: 'VPN instruction body',
    });

    const { runReindex } = await import('../reindex.js');
    const summary = await runReindex({
      profileId: 'sql-profile',
      llmEnrichmentEnabled: true,
      llmEnrichmentModel: 'profile-enricher',
      llmEnrichmentMaxChars: 2000,
    });

    expect(summary).toMatchObject({
      profileId: 'sql-profile',
      namespaces: [3030],
      totalPages: 1,
      processed: 1,
      failed: 0,
    });
    expect(fetchSemanticFacts).not.toHaveBeenCalled();
    expect(enrichPageForReindex).toHaveBeenCalledWith({
      title: 'CorpIT:VPN FAQ',
      text: 'VPN instruction body',
      model: 'profile-enricher',
      maxChars: 2000,
    });
    expect(upsertChunks.mock.calls[0][4]).toEqual(['ai-it', 'ai-exec']);
    expect(upsertChunks.mock.calls[0][7]).toEqual({
      summary: 'Profile enrichment summary',
      keywords: ['profile'],
      model: 'profile-enricher',
    });
  });
});
