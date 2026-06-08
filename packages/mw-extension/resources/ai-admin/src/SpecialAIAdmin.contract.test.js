import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const specialPagePath = path.resolve(process.cwd(), '../../src/SpecialAIAdmin.php');
const specialPageSource = fs.readFileSync(specialPagePath, 'utf8');

describe('SpecialAIAdmin UI contract', () => {
  it('keeps every admin tab paired with a panel', () => {
    const tabs = [...specialPageSource.matchAll(/data-ai-tab="([^"]+)"/g)].map((match) => match[1]);
    const panels = [...specialPageSource.matchAll(/data-ai-panel="([^"]+)"/g)].map((match) => match[1]);

    expect(tabs).toEqual([
      'overview',
      'services',
      'external-api',
      'retrieval-profiles',
      'llm',
      'embeddings',
      'rag',
      'debug-chain',
      'index-status',
      'bm25',
      'opensearch',
      'colbert',
      'composition',
      'documents',
      'chat-retention',
      'trust',
      'webhook',
      'ontology',
      'sensitive',
      'indexing',
      'audit',
    ]);
    expect(panels).toEqual(tabs);
  });

  it('loads admin JavaScript through ResourceLoader config and module', () => {
    expect(specialPageSource).toContain("addJsConfigVars(\n      'wgAIAssistantAdminConfig'");
    expect(specialPageSource).toContain("$this->getOutput()->addModules('ext.aiadmin');");
    expect(specialPageSource).not.toContain('const apiBase = ');
    expect(specialPageSource).not.toContain('let documentPolicy =');
  });

  it('renders retrieval profiles as a first-class admin panel', () => {
    expect(specialPageSource).toContain('data-ai-tab="retrieval-profiles"');
    expect(specialPageSource).toContain('data-ai-panel="retrieval-profiles"');
    expect(specialPageSource).toContain('id="aiadmin-retrieval-profiles"');
    expect(specialPageSource).toContain("'aiadmin-tab-retrieval-profiles'");
    expect(specialPageSource).toContain("'aiadmin-field-retrieval-top-k'");
    expect(specialPageSource).toContain("'aiadmin-field-context-top-k'");
    expect(specialPageSource).toContain("'aiadmin-field-context-max-chars'");
    expect(specialPageSource).toContain("'aiadmin-field-chat-retrieval-query-mode'");
    expect(specialPageSource).toContain("'aiadmin-section-retrieval-profile-limits'");
    expect(specialPageSource).toContain("'aiadmin-status-retrieval-profile-limits-ui'");
  });

  it('renders OpenSearch as a first-class admin panel', () => {
    expect(specialPageSource).toContain('data-ai-tab="opensearch"');
    expect(specialPageSource).toContain('data-ai-panel="opensearch"');
    expect(specialPageSource).toContain('id="aiadmin-opensearch-config"');
    expect(specialPageSource).toContain('id="aiadmin-save-opensearch-config"');
    expect(specialPageSource).toContain("'aiadmin-tab-opensearch'");
  });

  it('renders unified index status as an operational admin panel', () => {
    expect(specialPageSource).toContain('data-ai-tab="index-status"');
    expect(specialPageSource).toContain('data-ai-panel="index-status"');
    expect(specialPageSource).toContain('id="aiadmin-index-status-summary"');
    expect(specialPageSource).toContain('id="aiadmin-reindex-all-indexes"');
    expect(specialPageSource).toContain('id="aiadmin-reindex-dense-colbert"');
    expect(specialPageSource).toContain('id="aiadmin-reindex-lexical-indexes"');
    expect(specialPageSource).toContain('id="aiadmin-index-status-backfill-trigram"');
    expect(specialPageSource).toContain('id="aiadmin-index-status-operation"');
    expect(specialPageSource).toContain("'aiadmin-tab-index-status'");
    expect(specialPageSource).toContain("'aiadmin-section-index-status'");
    expect(specialPageSource).toContain("'aiadmin-label-index-current-operation'");
    expect(specialPageSource).toContain("'aiadmin-index-operation-target-writes'");
  });

  it('renders the MediaWiki profile selector panel instead of the legacy composition form', () => {
    expect(specialPageSource).toContain('data-ai-tab="composition"');
    expect(specialPageSource).toContain('data-ai-panel="composition"');
    expect(specialPageSource).toContain('id="aiadmin-mediawiki-profile-config"');
    expect(specialPageSource).toContain('id="aiadmin-save-mediawiki-profile-config"');
    expect(specialPageSource).toContain("'aiadmin-tab-composition'");
    expect(specialPageSource).not.toContain('id="aiadmin-composition-config"');
    expect(specialPageSource).not.toContain('id="aiadmin-save-composition-config"');
  });

  it('exposes OpenSearch as an indexing target in the admin form', () => {
    expect(specialPageSource).toContain('class="idx-profile-target" value="opensearch"');
    expect(specialPageSource).toContain('OpenSearch');
  });

  it('keeps the proxy permission and path guard in the MediaWiki special page', () => {
    expect(specialPageSource).toContain("!$this->getUser()->isAllowed('aiadmin')");
    expect(specialPageSource).toContain("!str_starts_with($path, '/api/admin/')");
    expect(specialPageSource).toContain("str_contains($path, '..')");
  });

  it('exposes document recognition capability labels to the ResourceLoader app', () => {
    [
      'aiadmin-doc-capabilities-title',
      'aiadmin-doc-cap-office-title',
      'aiadmin-doc-cap-archive-title',
      'aiadmin-doc-cap-media-title',
      'aiadmin-doc-cap-base-title',
      'aiadmin-doc-cap-mode-missing',
    ].forEach((key) => {
      expect(specialPageSource).toContain(`'${key}'`);
    });
  });
});
