import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateAIAdminTab,
  applyAIAdminTranslations,
  createAIAdminEndpoint,
  getDocumentCapabilitySummary,
} from './adminHelpers.js';

const adminAppSource = fs.readFileSync(path.resolve(process.cwd(), 'src/adminApp.js'), 'utf8');

describe('AI admin helpers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('builds direct Gateway admin endpoints when proxy is disabled', () => {
    const endpoint = createAIAdminEndpoint({
      apiBase: 'https://gateway.example/base',
      adminProxyEnabled: false,
    });

    expect(endpoint('/api/admin/health')).toBe('https://gateway.example/base/api/admin/health');
  });

  it('builds same-origin MediaWiki proxy endpoints when proxy is enabled', () => {
    const endpoint = createAIAdminEndpoint({
      apiBase: 'https://gateway.example',
      adminProxyEnabled: true,
      locationHref: 'https://wiki.example/index.php/Special:AIAdmin?uselang=ru',
    });

    const url = new URL(endpoint('/api/admin/service-config'));

    expect(url.origin).toBe('https://wiki.example');
    expect(url.searchParams.get('uselang')).toBe('ru');
    expect(url.searchParams.get('aiadmin-proxy')).toBe('1');
    expect(url.searchParams.get('path')).toBe('/api/admin/service-config');
  });

  it('activates exactly one tab and matching panel', () => {
    document.body.innerHTML = `
      <button class="ai-admin-tab active" data-ai-tab="overview">Overview</button>
      <button class="ai-admin-tab" data-ai-tab="services">Services</button>
      <section class="ai-admin-panel active" data-ai-panel="overview"></section>
      <section class="ai-admin-panel" data-ai-panel="services"></section>
    `;

    activateAIAdminTab('services');

    expect(document.querySelector('[data-ai-tab="overview"]')?.classList.contains('active')).toBe(false);
    expect(document.querySelector('[data-ai-panel="overview"]')?.classList.contains('active')).toBe(false);
    expect(document.querySelector('[data-ai-tab="services"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-ai-panel="services"]')?.classList.contains('active')).toBe(true);
  });

  it('applies translations by selector and falls back to the key', () => {
    document.body.innerHTML = `
      <button id="save"></button>
      <label for="field"></label>
    `;

    applyAIAdminTranslations(document, { 'aiadmin-save': 'Сохранить' }, [
      ['#save', 'aiadmin-save'],
      ['label[for="field"]', 'aiadmin-field-missing'],
    ]);

    expect(document.getElementById('save')?.textContent).toBe('Сохранить');
    expect(document.querySelector('label')?.textContent).toBe('aiadmin-field-missing');
  });

  it('keeps search history settings in the admin LLM config form', () => {
    expect(adminAppSource).toContain('cfg-searchHistoryEnabled');
    expect(adminAppSource).toContain('cfg-searchHistoryLimit');
    expect(adminAppSource).toContain('aiadmin-field-search-history-enabled');
    expect(adminAppSource).toContain('aiadmin-field-search-history-limit');
    expect(adminAppSource).toContain('data.searchHistoryEnabled');
    expect(adminAppSource).toContain('data.searchHistoryLimit');
  });

  it('builds document recognition capability summary from current MIME policy modes', () => {
    const summary = getDocumentCapabilitySummary({
      mimeTypes: {
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { mode: 'disabled' },
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { mode: 'text' },
        'application/zip': { mode: 'metadata' },
        'audio/mpeg': { mode: 'metadata' },
      },
    });

    const office = summary.find((item) => item.id === 'office');
    const archive = summary.find((item) => item.id === 'archive');
    const media = summary.find((item) => item.id === 'media');
    const base = summary.find((item) => item.id === 'base');

    expect(office?.items.find((item) => item.extension === 'docx')?.mode).toBe('disabled');
    expect(office?.items.find((item) => item.extension === 'xlsx')?.mode).toBe('text');
    expect(archive?.modes).toContain('metadata');
    expect(media?.modes).toContain('metadata');
    expect(base?.modes).toEqual(['missing']);
  });

  it('keeps document recognition capability summary wired into the admin app', () => {
    expect(adminAppSource).toContain('renderDocumentCapabilitySummary(root)');
    expect(adminAppSource).toContain('aiadmin-doc-capabilities-title');
    expect(adminAppSource).toContain('ai-admin-document-capability-grid');
    expect(adminAppSource).toContain('entry.extension}=${documentModeLabel(entry.mode)}');
  });

  it('keeps experimental lexical controls wired into the BM25 admin form', () => {
    expect(adminAppSource).toContain('rag-lexicalNormalizationMode');
    expect(adminAppSource).toContain('rag-lexicalSynonymsEnabled');
    expect(adminAppSource).toContain('parseLexicalSynonyms');
    expect(adminAppSource).toContain('rag-lexicalTransliterationEnabled');
    expect(adminAppSource).toContain('rag-lexicalEditDistanceEnabled');
    expect(adminAppSource).toContain('rag-trigramIndexEnabled');
    expect(adminAppSource).toContain('/api/admin/search-index/trigram/backfill');
    expect(adminAppSource).toContain('/api/admin/search-index/trigram/backfill/status');
    expect(adminAppSource).toContain('/api/admin/search-index/trigram/backfill/cancel');
    expect(adminAppSource).toContain('aiadmin-status-trigram-job');
    expect(adminAppSource).toContain('trigramBackfillPollTimer');
  });

  it('keeps OpenSearch controls wired into its admin panel and retrieval profile forms', () => {
    expect(adminAppSource).toContain('aiadmin-opensearch-config');
    expect(adminAppSource).toContain('aiadmin-save-opensearch-config');
    expect(adminAppSource).toContain('aiadmin-test-opensearch-status');
    expect(adminAppSource).toContain('aiadmin-analyze-opensearch-query');
    expect(adminAppSource).toContain('aiadmin-preview-opensearch-search');
    expect(adminAppSource).toContain('svc-opensearch-enabled');
    expect(adminAppSource).toContain('svc-opensearch-baseUrl');
    expect(adminAppSource).toContain('defaultOpenSearchBaseUrl = "http://opensearch:9200"');
    expect(adminAppSource).toContain('aiadmin-help-opensearch-base-url');
    expect(adminAppSource).toContain('baseUrl: enabled && !baseUrl ? defaultOpenSearchBaseUrl : baseUrl');
    expect(adminAppSource).toContain('collectOpenSearchConfig');
    expect(adminAppSource).toContain('renderOpenSearchConfig');
    expect(adminAppSource).toContain('/api/admin/opensearch/status');
    expect(adminAppSource).toContain('/api/admin/opensearch/analyze');
    expect(adminAppSource).toContain('/api/admin/opensearch/search-preview');
    expect(adminAppSource).toContain('retrieval-profile-lexical-backend');
    expect(adminAppSource).toContain('lexicalBackend');
  });

  it('keeps OpenSearch preview actions routed to the Gateway admin API', () => {
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-test-opensearch-status") return');
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-analyze-opensearch-query") return');
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-preview-opensearch-search") return');
    expect(adminAppSource).toContain('ensureOpenSearchBaseUrl();');
    expect(adminAppSource).toContain('renderOpenSearchPreview(`analyzer=');
    expect(adminAppSource).toContain('renderOpenSearchPreview(`hits=');
  });
});
