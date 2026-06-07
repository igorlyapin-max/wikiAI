import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateAIAdminTab,
  applyAIAdminTranslations,
  collectMediaWikiProfileConfig,
  createAIAdminEndpoint,
  getDocumentCapabilitySummary,
  loadMediaWikiProfilePayload,
  renderMediaWikiProfileSelector,
} from './adminHelpers.js';

const adminAppSource = fs.readFileSync(path.resolve(process.cwd(), 'src/adminApp.js'), 'utf8');
const adminHelpersSource = fs.readFileSync(path.resolve(process.cwd(), 'src/adminHelpers.js'), 'utf8');
const specialAdminSource = fs.readFileSync(path.resolve(process.cwd(), '../../src/SpecialAIAdmin.php'), 'utf8');
const ruMessages = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../../i18n/ru.json'), 'utf8'));
const enMessages = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../../i18n/en.json'), 'utf8'));

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
    expect(adminAppSource).toContain('aiadmin-field-show-sources-default');
    expect(adminAppSource).toContain('sourceInput.disabled = true');
  });

  it('does not render legacy cached chat owners as real users', () => {
    expect(adminAppSource).toContain('displayChatSessionUser');
    expect(adminAppSource).toContain('username !== "cached"');
    expect(adminAppSource).toContain('aiadmin-value-chat-user-legacy');
    expect(adminAppSource).toContain('displayChatSessionUser(session)');
    expect(ruMessages['aiadmin-value-chat-user-legacy']).toContain('legacy');
    expect(enMessages['aiadmin-value-chat-user-legacy']).toContain('legacy');
  });

  it('keeps the conflict detection system prompt visible and saved in the admin UI', () => {
    expect(adminAppSource).toContain('conflict-system-prompt');
    expect(adminAppSource).toContain('aiadmin-field-conflict-system-prompt');
    expect(adminAppSource).toContain('aiadmin-help-conflict-system-prompt');
    expect(adminAppSource).toContain('systemPrompt: document.getElementById("conflict-system-prompt").value.trim()');
    expect(specialAdminSource).toContain('aiadmin-field-conflict-system-prompt');
    expect(specialAdminSource).toContain('aiadmin-help-conflict-system-prompt');
    expect(ruMessages['aiadmin-field-conflict-system-prompt']).toBe('System prompt проверки противоречий');
    expect(enMessages['aiadmin-field-conflict-system-prompt']).toBe('Conflict detection system prompt');
  });

  it('keeps attachment reindex status visible in the admin UI', () => {
    expect(adminAppSource).toContain('aiadmin-status-attachment-index');
    expect(adminAppSource).toContain('attachmentColumnsReady');
    expect(adminAppSource).toContain('aiadmin-reindex-attachment-counters');
    expect(adminAppSource).toContain('aiadmin-reindex-preflight');
    expect(adminAppSource).toContain('attachmentTargetWrites');
    expect(adminAppSource).toContain('aiadmin-reindex-attachment-target-writes');
    expect(adminAppSource).toContain('currentAttachmentFilename');
    expect(adminAppSource).toContain('aiadmin-field-reindex-attachments');
    expect(adminAppSource).toContain('aiadmin-warning-reindex-attachments-policy-disabled');
    expect(specialAdminSource).toContain('aiadmin-reindex-preflight');
    expect(specialAdminSource).toContain('aiadmin-reindex-attachment-counters');
    expect(specialAdminSource).toContain('aiadmin-field-reindex-attachments');
    expect(ruMessages['aiadmin-reindex-preflight']).toContain('Preflight');
    expect(ruMessages['aiadmin-reindex-attachment-counters']).toContain('Вложения');
    expect(ruMessages['aiadmin-reindex-attachment-target-writes']).toContain('target');
    expect(ruMessages['aiadmin-field-reindex-attachments']).toContain('этом запуске');
    expect(enMessages['aiadmin-reindex-attachment-counters']).toContain('Attachments');
    expect(enMessages['aiadmin-reindex-attachment-target-writes']).toContain('target');
    expect(enMessages['aiadmin-field-reindex-attachments']).toContain('this run');
  });

  it('keeps indexing profile attachment checkbox and target synchronized', () => {
    expect(adminAppSource).toContain('normalizeAttachmentTarget');
    expect(adminAppSource).toContain('syncIndexingAttachmentControls');
    expect(adminAppSource).toContain('attachmentTargetMismatch');
    expect(adminAppSource).toContain('aiadmin-warning-index-profile-attachments-target-mismatch');
    expect(adminAppSource).toContain('document.querySelector(".idx-profile-target[value=\\\"attachments\\\"]")');
    expect(specialAdminSource).toContain('aiadmin-warning-index-profile-attachments-target-mismatch');
    expect(ruMessages['aiadmin-warning-index-profile-attachments-target-mismatch']).toContain('attachments');
    expect(enMessages['aiadmin-warning-index-profile-attachments-target-mismatch']).toContain('Attachment target');
  });

  it('separates indexing profile content from automation assignments', () => {
    expect(specialAdminSource).toContain('aiadmin-indexing-profiles-section');
    expect(specialAdminSource).toContain('aiadmin-indexing-automation-section');
    expect(specialAdminSource).toContain('aiadmin-indexing-profile-editor-section');
    expect(specialAdminSource).toContain('aiadmin-indexing-manual-run-section');
    expect(specialAdminSource).toContain('idx-automation-change-profile');
    expect(specialAdminSource).toContain('idx-automation-scheduled-profile');
    expect(specialAdminSource).not.toContain('idx-profile-runmode');
    expect(specialAdminSource).not.toContain('idx-profile-schedule');
    expect(adminAppSource).toContain('/api/admin/indexing-automation');
    expect(adminAppSource).toContain('collectIndexingAutomation');
    expect(adminAppSource).toContain('changeIndexingProfileId');
    expect(adminAppSource).toContain('scheduledReindexProfileId');
    expect(adminAppSource).not.toContain('runMode: document.getElementById("idx-profile-runmode").value');
    expect(ruMessages['aiadmin-section-indexing-automation']).toBe('Автоматизация');
    expect(enMessages['aiadmin-section-indexing-automation']).toBe('Automation');
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
    expect(adminAppSource).toContain('aiadmin-check-opensearch-attachment');
    expect(adminAppSource).toContain('svc-opensearch-attachment-filename');
    expect(adminAppSource).toContain('svc-opensearch-enabled');
    expect(adminAppSource).toContain('aiadmin-help-opensearch-enabled');
    expect(adminAppSource).toContain('svc-opensearch-baseUrl');
    expect(adminAppSource).toContain('defaultOpenSearchBaseUrl = "http://opensearch:9200"');
    expect(adminAppSource).toContain('aiadmin-help-opensearch-base-url');
    expect(adminAppSource).toContain('aiadmin-section-opensearch-effective');
    expect(adminAppSource).toContain('aiadmin-section-opensearch-index-state');
    expect(adminAppSource).toContain('aiadmin-help-opensearch-analyzer');
    expect(adminAppSource).toContain('openSearchOverrideSource');
    expect(adminAppSource).toContain('serviceConfigOverrides = data.overrides || {}');
    expect(adminAppSource).toContain('rag.lexicalBackend');
    expect(adminAppSource).toContain('openSearch.baseUrl || defaultOpenSearchBaseUrl');
    expect(adminAppSource).toContain('if (!baseUrlInput.value.trim())');
    expect(adminAppSource).toContain('baseUrl: enabled && !baseUrl ? defaultOpenSearchBaseUrl : baseUrl');
    expect(adminAppSource).toContain('collectOpenSearchConfig');
    expect(adminAppSource).toContain('renderOpenSearchConfig');
    expect(adminAppSource).toContain('/api/admin/opensearch/status');
    expect(adminAppSource).toContain('/api/admin/opensearch/analyze');
    expect(adminAppSource).toContain('/api/admin/opensearch/search-preview');
    expect(adminAppSource).toContain('/api/admin/opensearch/attachment-diagnostics');
    expect(adminAppSource).toContain('attachmentDocumentCount');
    expect(adminAppSource).toContain('attachmentFilenames');
    expect(adminAppSource).toContain('aiadmin-rebuild-opensearch-index');
    expect(adminAppSource).toContain('openSearchIndexingProfile');
    expect(adminAppSource).toContain('indexTargets || []).includes("opensearch")');
    expect(adminAppSource).toContain('aiadmin-error-opensearch-profile-missing');
    expect(adminAppSource).toContain('/api/admin/reindex');
    expect(adminAppSource).toContain('rag-lexicalBackend');
    expect(adminAppSource).toContain('readFormValue("rag-lexicalBackend"');
    expect(adminAppSource).toContain('retrieval-profile-lexical-backend');
    expect(adminAppSource).toContain('retrieval-profile-retrieval-top-k');
    expect(adminAppSource).toContain('retrieval-profile-context-top-k');
    expect(adminAppSource).toContain('retrieval-profile-context-max-chars');
    expect(adminAppSource).toContain('retrieval-profile-chat-profile');
    expect(adminAppSource).toContain('retrieval-profile-llm-model');
    expect(adminAppSource).toContain('retrieval-profile-llm-temperature');
    expect(adminAppSource).toContain('retrieval-profile-llm-max-tokens');
    expect(adminAppSource).toContain('retrieval-profile-llm-timeout-ms');
    expect(adminAppSource).toContain('retrieval-profile-show-sources');
    expect(adminAppSource).toContain('retrieval-profile-assistant-ui-mode');
    expect(adminAppSource).toContain('aiadmin-retrieval-profile-limits-marker');
    expect(adminAppSource).toContain('aiadmin-section-retrieval-profile-response');
    expect(adminAppSource).toContain('aiadmin-section-chat-runtime-defaults');
    expect(adminAppSource).toContain('"aiadmin-field-retrieval-top-k"');
    expect(adminAppSource).toContain('"aiadmin-field-context-top-k"');
    expect(adminAppSource).toContain('"aiadmin-field-context-max-chars"');
    expect(adminAppSource).toContain('"aiadmin-field-chat-profile"');
    expect(adminAppSource).toContain('"aiadmin-table-llm"');
    expect(adminAppSource).toContain('chatProfileId = document.getElementById("retrieval-profile-chat-profile").value');
    expect(adminAppSource).toContain('chatProfileId,');
    expect(adminAppSource).toContain('chatRetrievalQueryMode: legacyChatRetrievalModeForChatProfileId(chatProfileId)');
    expect(adminAppSource).toContain('llmModel: optionalText("retrieval-profile-llm-model")');
    expect(adminAppSource).toContain('assistantUiMode: document.getElementById("retrieval-profile-assistant-ui-mode").value');
    expect(adminAppSource).toContain('appendTableCell(row, limits.retrievalTopK)');
    expect(adminAppSource).toContain('appendTableCell(row, limits.contextTopK)');
    expect(adminAppSource).toContain('appendTableCell(row, limits.contextMaxChars)');
    expect(adminAppSource).toContain('retrievalProfileChatProfileId(profile)');
    expect(adminAppSource).toContain('aiadmin-section-retrieval-profile-limits');
    expect(adminHelpersSource).toContain('aiadmin-field-retrieval-top-k');
    expect(adminHelpersSource).toContain('config.retrievalTopK ?? config.topK');
    expect(adminAppSource).not.toContain('appendInputRow(form, "rag-topK"');
    expect(adminAppSource).not.toContain('appendInputRow(form, "rag-maxContextChunks"');
    expect(adminAppSource).not.toContain('appendInputRow(form, "rag-maxContextChars"');
    expect(adminAppSource).toContain('lexicalBackend');
    expect(ruMessages['aiadmin-section-retrieval-profile-response']).toBe('Поведение ответа');
    expect(ruMessages['aiadmin-section-chat-runtime-defaults']).toBe('Fallback-настройки выполнения чата');
    expect(enMessages['aiadmin-section-chat-runtime-defaults']).toBe('Chat runtime fallbacks');
    expect(enMessages['aiadmin-field-llm-model-override']).toContain('Profile LLM');
    expect(ruMessages['aiadmin-field-opensearch-enabled']).toContain('backend');
    expect(enMessages['aiadmin-field-opensearch-enabled']).toContain('backend');
  });

  it('wires chat management profiles into the admin UI', () => {
    expect(specialAdminSource).toContain('aiadmin-chat-management-config');
    expect(specialAdminSource).toContain('aiadmin-chat-profiles');
    expect(adminAppSource).toContain('/api/admin/chat-management/config');
    expect(adminAppSource).toContain('/api/admin/chat-profiles');
    expect(adminAppSource).toContain('/api/admin/chat-profiles/restore-defaults');
    expect(adminAppSource).toContain('collectChatProfile');
    expect(adminAppSource).toContain('promptHistoryScopeOptions');
    expect(adminAppSource).toContain('retrievalHistoryModeOptions');
    expect(adminAppSource).toContain('chat-profile-prompt-scope');
    expect(adminAppSource).toContain('chat-profile-retrieval-mode');
    expect(adminAppSource).toContain('chat-management-default-profile');
    expect(adminAppSource).toContain('aiadmin-save-chat-management-config');
    expect(adminAppSource).toContain('aiadmin-save-chat-profile');
    expect(adminAppSource).toContain('aiadmin-restore-chat-profiles');
    expect(ruMessages['aiadmin-tab-chat-retention']).toBe('Управление чатами');
    expect(enMessages['aiadmin-tab-chat-retention']).toBe('Chat management');
    expect(ruMessages['aiadmin-chat-profile-name-chat_followup_questions']).toContain('Уточняющие');
    expect(enMessages['aiadmin-chat-profile-name-chat_followup_questions']).toContain('Follow-up');
  });

  it('wires chain debug trace into a dedicated admin tab', () => {
    expect(specialAdminSource).toContain('aiadmin-chat-debug-form');
    expect(specialAdminSource).toContain('aiadmin-run-chat-debug');
    expect(specialAdminSource).toContain('aiadmin-chat-debug-result');
    expect(specialAdminSource).toContain('data-ai-tab="debug-chain"');
    expect(specialAdminSource).toContain('data-ai-panel="debug-chain"');
    const ragPanel = specialAdminSource.match(/data-ai-panel="rag"[\s\S]*?data-ai-panel="debug-chain"/)?.[0] || '';
    expect(ragPanel).not.toContain('aiadmin-chat-debug-form');
    const debugPanel = specialAdminSource.match(/data-ai-panel="debug-chain"[\s\S]*?data-ai-panel="bm25"/)?.[0] || '';
    expect(debugPanel).toContain('aiadmin-chat-debug-form');
    expect(debugPanel).toContain('aiadmin-debug-chain-links');
    expect(adminAppSource).toContain('/api/admin/chat/debug-trace');
    expect(adminAppSource).toContain('collectChatDebugTrace');
    expect(adminAppSource).toContain('renderChatDebugTrace');
    expect(adminAppSource).toContain('renderDebugChainConfig');
    expect(adminAppSource).toContain('renderDebugChainNavigation');
    expect(adminAppSource).toContain('chat-debug-verbosity');
    expect(adminAppSource).toContain('Prompt stack');
    expect(adminAppSource).toContain('Final LLM HTTP trace');
    expect(adminAppSource).toContain('Final LLM request');
    expect(adminAppSource).toContain('Final LLM response');
    expect(adminAppSource).toContain('Attachment index coverage');
    expect(adminAppSource).toContain('Copy prompt');
    expect(adminAppSource).toContain('chunks raw/readable/trusted/context');
    expect(ruMessages['aiadmin-tab-debug-chain']).toBe('Debug цепочки');
    expect(enMessages['aiadmin-tab-debug-chain']).toBe('Chain debug');
    expect(ruMessages['aiadmin-section-chat-debug']).toBe('Debug пользовательского запроса');
    expect(enMessages['aiadmin-section-chat-debug']).toBe('User request debug');
    expect(ruMessages['aiadmin-help-debug-chain']).toContain('весь путь ответа');
    expect(enMessages['aiadmin-help-debug-chain']).toContain('full answer path');
  });

  it('replaces search composition with the MediaWiki retrieval profile selector', () => {
    expect(adminAppSource).toContain('/api/admin/knowledge-source-profile/config');
    expect(adminHelpersSource).toContain('/api/admin/mediawiki-profile/config');
    expect(adminAppSource).toContain('loadMediaWikiProfilePayload(request)');
    expect(adminAppSource).toContain('renderMediaWikiProfileSelector(form, data');
    expect(adminHelpersSource).toContain('mediawiki-default-retrieval-profile');
    expect(adminAppSource).toContain('aiadmin-save-mediawiki-profile-config');
    expect(adminAppSource).toContain('aiadmin-restore-mediawiki-retrieval-profiles');
    expect(adminHelpersSource).toContain('aiadmin-status-mediawiki-profile-readiness');
    expect(adminHelpersSource).toContain('aiadmin-status-mediawiki-opensearch-profiles-missing');
    expect(adminAppSource).toContain('activateTab("retrieval-profiles")');
    expect(adminAppSource).not.toContain('aiadmin-composition-config');
    expect(adminAppSource).not.toContain('aiadmin-save-composition-config');
    expect(adminAppSource).not.toContain('appendSelectRow(compositionForm, "rag-searchMode"');
    expect(adminAppSource).not.toContain('appendSelectRow(compositionForm, "rag-lexicalBackend"');
    expect(specialAdminSource).toContain('aiadmin-mediawiki-profile-config');
    expect(specialAdminSource).toContain('aiadmin-save-mediawiki-profile-config');
    expect(ruMessages['aiadmin-tab-composition']).toBe('Источники знаний');
    expect(enMessages['aiadmin-tab-composition']).toBe('Knowledge sources');
  });

  it('renders the MediaWiki profile selector with real profile options and readiness details', () => {
    const root = document.createElement('form');

    renderMediaWikiProfileSelector(root, {
      values: {
        id: 'default',
        sourceIds: ['mediawiki'],
        retrievalProfileId: 'opensearch_hybrid_colbert',
      },
      selectedProfile: {
        id: 'opensearch_hybrid_colbert',
        name: 'OpenSearch hybrid + ColBERT',
        readiness: {
          status: 'prod_ready',
          reasons: ['ready'],
          requiredIndexTargets: ['dense', 'opensearch', 'colbert'],
          missingIndexTargets: [],
        },
        config: {
          searchMode: 'hybrid_colbert',
          lexicalBackend: 'opensearch',
          rerankMode: 'colbert_v2',
          colbertEnabled: true,
          lexicalEditDistanceEnabled: true,
          trigramIndexEnabled: false,
          retrievalTopK: 8,
          contextTopK: 3,
          contextMaxChars: 9000,
          chatRetrievalQueryMode: 'history_augmented',
          semanticFactsInContext: true,
          includeAttachments: true,
          includeSemanticHeader: true,
        },
      },
      retrievalProfiles: [
        {
          id: 'opensearch_hybrid_colbert',
          name: 'OpenSearch hybrid + ColBERT',
          readiness: { status: 'prod_ready' },
          config: {
            searchMode: 'hybrid_colbert',
            lexicalBackend: 'opensearch',
            rerankMode: 'colbert_v2',
          },
        },
        {
          id: 'opensearch_hybrid',
          name: 'OpenSearch hybrid stack',
          readiness: { status: 'not_ready', reasons: ['OpenSearch index is not ready'] },
          config: {
            searchMode: 'hybrid',
            lexicalBackend: 'opensearch',
            rerankMode: 'none',
          },
        },
        {
          id: 'semantic_broad',
          name: 'Broad semantic hybrid',
          readiness: { status: 'limited_ready' },
          config: {
            searchMode: 'hybrid',
            lexicalBackend: 'sqlite_fts',
            rerankMode: 'none',
          },
        },
      ],
    }, { i18n: ruMessages });

    const select = root.querySelector('#mediawiki-default-retrieval-profile');
    expect(select).not.toBeNull();
    expect(select.value).toBe('opensearch_hybrid_colbert');
    expect([...select.options].map((option) => option.value)).toEqual([
      'opensearch_hybrid_colbert',
      'opensearch_hybrid',
      'semantic_broad',
    ]);
    expect(select.options[0].textContent).toContain('OpenSearch');
    expect(select.options[0].textContent).toContain('Hybrid + ColBERT');
    expect(select.options[1].textContent).toContain('not_ready');
    expect(root.textContent).toContain('Готовность профиля источников знаний: prod_ready');
    expect(root.textContent).toContain('OpenSearch hybrid + ColBERT (opensearch_hybrid_colbert)');
    expect(root.textContent).toContain('mediawiki');
    expect(root.textContent).toContain('hybrid_colbert');
    expect(root.textContent).toContain('OpenSearch');
    expect(root.textContent).toContain('colbert_v2');
    expect(root.textContent).toContain('8');
    expect(root.textContent).toContain('3');
    expect(root.textContent).toContain('9000');
    expect(root.textContent).toContain('Текущий запрос + история');
    expect(root.textContent).toContain('dense, opensearch, colbert');
    expect(root.querySelector('#aiadmin-refresh-mediawiki-profile')).not.toBeNull();
    expect(root.querySelector('#aiadmin-open-retrieval-profiles')).not.toBeNull();
    expect(root.querySelector('#aiadmin-restore-mediawiki-retrieval-profiles')).toBeNull();
  });

  it('collects the selected MediaWiki profile for save payloads', () => {
    const root = document.createElement('form');
    renderMediaWikiProfileSelector(root, {
      values: { defaultRetrievalProfileId: 'opensearch_hybrid_colbert' },
      retrievalProfiles: [
        {
          id: 'opensearch_hybrid_colbert',
          name: 'OpenSearch hybrid + ColBERT',
          readiness: { status: 'prod_ready' },
          config: { searchMode: 'hybrid_colbert', lexicalBackend: 'opensearch', rerankMode: 'colbert_v2' },
        },
        {
          id: 'semantic_broad',
          name: 'Broad semantic hybrid',
          readiness: { status: 'limited_ready' },
          config: { searchMode: 'hybrid', lexicalBackend: 'sqlite_fts', rerankMode: 'none' },
        },
      ],
    }, { i18n: ruMessages });

    root.querySelector('#mediawiki-default-retrieval-profile').value = 'semantic_broad';

    expect(collectMediaWikiProfileConfig(root)).toEqual({
      id: 'default',
      sourceIds: ['mediawiki'],
      retrievalProfileId: 'semantic_broad',
      failurePolicy: 'partial_with_warning',
      mergePolicy: 'normalize_rerank',
    });
  });

  it('falls back to /api/admin/retrieval-profiles when the knowledge source profile response has no profile list', async () => {
    const request = vi.fn(async (path) => {
      if (path === '/api/admin/knowledge-source-profile/config') {
        return {
          values: { retrievalProfileId: 'opensearch_hybrid_colbert', sourceIds: ['mediawiki'] },
          retrievalProfiles: [],
        };
      }
      if (path === '/api/admin/retrieval-profiles') {
        return {
          values: [
            { id: 'opensearch_hybrid_colbert', name: 'OpenSearch hybrid + ColBERT', readiness: { status: 'prod_ready' } },
          ],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const payload = await loadMediaWikiProfilePayload(request);

    expect(request).toHaveBeenCalledWith('/api/admin/knowledge-source-profile/config');
    expect(request).toHaveBeenCalledWith('/api/admin/retrieval-profiles');
    expect(payload.retrievalProfiles).toEqual([
      expect.objectContaining({ id: 'opensearch_hybrid_colbert' }),
    ]);
  });

  it('falls back to the legacy MediaWiki profile endpoint when the knowledge source endpoint is unavailable', async () => {
    const request = vi.fn(async (path) => {
      if (path === '/api/admin/knowledge-source-profile/config') {
        throw new Error('Route GET:/api/admin/knowledge-source-profile/config not found');
      }
      if (path === '/api/admin/mediawiki-profile/config') {
        return {
          values: { defaultRetrievalProfileId: 'opensearch_hybrid_colbert' },
          retrievalProfiles: [
            { id: 'opensearch_hybrid_colbert', name: 'OpenSearch hybrid + ColBERT', readiness: { status: 'prod_ready' } },
          ],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const payload = await loadMediaWikiProfilePayload(request);

    expect(request).toHaveBeenCalledWith('/api/admin/knowledge-source-profile/config');
    expect(request).toHaveBeenCalledWith('/api/admin/mediawiki-profile/config');
    expect(payload.values.defaultRetrievalProfileId).toBe('opensearch_hybrid_colbert');
  });

  it('warns and offers restore when MediaWiki profile options do not include OpenSearch profiles', () => {
    const root = document.createElement('form');

    renderMediaWikiProfileSelector(root, {
      values: { defaultRetrievalProfileId: 'semantic_broad' },
      selectedProfile: {
        id: 'semantic_broad',
        name: 'Broad semantic hybrid',
        readiness: { status: 'limited_ready', reasons: ['semantic only'] },
        config: { searchMode: 'hybrid', lexicalBackend: 'sqlite_fts', rerankMode: 'none' },
      },
      retrievalProfiles: [
        {
          id: 'semantic_broad',
          name: 'Broad semantic hybrid',
          readiness: { status: 'limited_ready' },
          config: { searchMode: 'hybrid', lexicalBackend: 'sqlite_fts', rerankMode: 'none' },
        },
      ],
    }, { i18n: ruMessages });

    const select = root.querySelector('#mediawiki-default-retrieval-profile');
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.value)).toEqual(['semantic_broad']);
    expect(root.textContent).toContain('OpenSearch-профили не загружены');
    expect(root.querySelector('#aiadmin-restore-mediawiki-retrieval-profiles')).not.toBeNull();
  });

  it('shows an explicit empty-state error instead of a blank profile select', () => {
    const root = document.createElement('form');

    renderMediaWikiProfileSelector(root, {
      values: { defaultRetrievalProfileId: 'opensearch_hybrid_colbert' },
      retrievalProfiles: [],
    }, { i18n: ruMessages });

    expect(root.querySelector('#mediawiki-default-retrieval-profile')).toBeNull();
    expect(root.textContent).toContain('Профили поиска не загружены');
    expect(root.querySelector('#aiadmin-refresh-mediawiki-profile')).not.toBeNull();
    expect(root.querySelector('#aiadmin-open-retrieval-profiles')).not.toBeNull();
    expect(root.querySelector('#aiadmin-restore-mediawiki-retrieval-profiles')).not.toBeNull();
  });

  it('keeps retrieval profile UI free of readiness and raw backend terminology', () => {
    expect(adminAppSource).toContain('retrievalProfileModeLabel');
    expect(adminAppSource).toContain('lexicalBackendLabel(ragConfig?.lexicalBackend || "sqlite_fts")');
    expect(adminAppSource).toContain('"aiadmin-table-external-api"');
    expect(adminAppSource).toContain('"aiadmin-table-mcp"');
    expect(adminAppSource).toContain('"aiadmin-table-unauthenticated"');
    expect(adminAppSource).toContain('t("aiadmin-value-lexical-backend-sqlite", "BM25/trigram")');
    expect(adminAppSource).not.toContain('"aiadmin-table-api-mcp"');
    expect(adminAppSource).not.toContain('"aiadmin-table-readiness"');
    expect(adminAppSource).not.toContain('aiadmin-status-retrieval-profile-readiness');
    expect(adminAppSource).not.toContain('anonymous ${yesNo(profile.anonymousAllowed)}');
    expect(ruMessages['aiadmin-field-external-anonymous-search']).toBe('Разрешить поиск без авторизации');
    expect(ruMessages['aiadmin-table-unauthenticated']).toBe('Без авторизации');
    expect(ruMessages['aiadmin-value-lexical-backend-sqlite']).toBe('BM25/trigram');
    expect(ruMessages['aiadmin-field-retrieval-top-k']).toBe('Сколько источников вернуть');
    expect(ruMessages['aiadmin-field-context-top-k']).toBe('Сколько источников дать модели');
    expect(ruMessages['aiadmin-field-chat-retrieval-query-mode']).toBe('История в поиске чата');
    expect(ruMessages['aiadmin-value-chat-retrieval-current-message']).toBe('Только текущий запрос');
    expect(ruMessages['aiadmin-value-chat-retrieval-history-augmented']).toBe('Текущий запрос + история');
    expect(ruMessages['aiadmin-section-retrieval-profile-limits']).toBe('Лимиты выдачи и контекста');
    expect(ruMessages['aiadmin-status-retrieval-profile-limits-ui']).toContain('Лимиты профилей загружены');
    expect(enMessages['aiadmin-field-external-anonymous-search']).toBe('Allow unauthenticated search');
    expect(enMessages['aiadmin-table-unauthenticated']).toBe('Unauthenticated');
    expect(enMessages['aiadmin-value-lexical-backend-sqlite']).toBe('BM25/trigram');
    expect(enMessages['aiadmin-field-retrieval-top-k']).toBe('Sources to return');
    expect(enMessages['aiadmin-field-context-top-k']).toBe('Sources sent to model');
    expect(enMessages['aiadmin-field-chat-retrieval-query-mode']).toBe('Chat retrieval history');
    expect(enMessages['aiadmin-value-chat-retrieval-current-message']).toBe('Current query only');
    expect(enMessages['aiadmin-value-chat-retrieval-history-augmented']).toBe('Current query + history');
    expect(enMessages['aiadmin-section-retrieval-profile-limits']).toBe('Retrieval and context limits');
    expect(enMessages['aiadmin-status-retrieval-profile-limits-ui']).toBe('Retrieval profile limits UI loaded');
  });

  it('keeps OIDC group mapping controls wired into the External API admin form', () => {
    expect(adminAppSource).toContain('external-group-mapping-mode');
    expect(adminAppSource).toContain('external-group-mappings');
    expect(adminAppSource).toContain('external-group-preview-raw');
    expect(adminAppSource).toContain('external-group-preview-output');
    expect(adminAppSource).toContain('external-group-mapping-warning');
    expect(adminAppSource).toContain('parseExternalGroupMappings');
    expect(adminAppSource).toContain('mappedExternalGroups');
    expect(adminAppSource).toContain('groupMappingMode: document.getElementById("external-group-mapping-mode").value');
    expect(adminAppSource).toContain('groupMappings: parseExternalGroupMappings(document.getElementById("external-group-mappings").value)');
    expect(specialAdminSource).toContain('aiadmin-field-oidc-group-mapping-mode');
    expect(specialAdminSource).toContain('aiadmin-help-oidc-group-mappings');
    expect(ruMessages['aiadmin-value-group-mapping-mapped-only']).toBe('Только mapped MediaWiki groups');
    expect(ruMessages['aiadmin-status-oidc-group-mapping-empty']).toContain('groups_only + mapped_only');
    expect(enMessages['aiadmin-value-group-mapping-passthrough']).toBe('Raw OIDC groups + mapped MediaWiki groups');
    expect(enMessages['aiadmin-status-external-api-capabilities']).toContain('mapping: {mappingMode}');
  });

  it('keeps OpenSearch preview actions routed to the Gateway admin API', () => {
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-test-opensearch-status") return');
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-analyze-opensearch-query") return');
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-preview-opensearch-search") return');
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-check-opensearch-attachment") return');
    expect(adminAppSource).toContain('if (event.target?.id !== "aiadmin-rebuild-opensearch-index") return');
    expect(adminAppSource).toContain('ensureOpenSearchBaseUrl();');
    expect(adminAppSource).toContain('renderOpenSearchIndexState(values)');
    expect(adminAppSource).toContain('renderOpenSearchAttachmentDiagnostics(data.values || {})');
    expect(adminAppSource).toContain('renderOpenSearchPreview(`analyzer=');
    expect(adminAppSource).toContain('renderOpenSearchPreview(`hits=');
    expect(adminAppSource).toContain('rebuildOpenSearchIndex');
  });
});
