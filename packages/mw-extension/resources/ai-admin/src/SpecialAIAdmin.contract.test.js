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
      'bm25',
      'opensearch',
      'colbert',
      'composition',
      'documents',
      'chat-retention',
      'trust',
      'webhook',
      'ontology',
      'autofill',
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
  });

  it('renders OpenSearch as a first-class admin panel', () => {
    expect(specialPageSource).toContain('data-ai-tab="opensearch"');
    expect(specialPageSource).toContain('data-ai-panel="opensearch"');
    expect(specialPageSource).toContain('id="aiadmin-opensearch-config"');
    expect(specialPageSource).toContain('id="aiadmin-save-opensearch-config"');
    expect(specialPageSource).toContain("'aiadmin-tab-opensearch'");
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
