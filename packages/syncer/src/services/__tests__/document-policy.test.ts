import { describe, expect, it } from 'vitest';
import {
  getMimeProcessingRule,
  normalizeDocumentProcessingConfig,
} from '../document-policy.js';

describe('document policy', () => {
  it('merges overrides with defaults', () => {
    const policy = normalizeDocumentProcessingConfig({
      attachmentsEnabled: false,
      mimeTypes: {
        'image/png': { mode: 'metadata' },
        'application/x-custom': { mode: 'disabled' },
      },
    });

    expect(policy.attachmentsEnabled).toBe(false);
    expect(policy.mimeTypes['application/pdf'].mode).toBe('text');
    expect(policy.mimeTypes['image/png'].mode).toBe('metadata');
    expect(policy.mimeTypes['application/x-custom'].mode).toBe('disabled');
  });

  it('defaults unknown MIME types to metadata mode', () => {
    const policy = normalizeDocumentProcessingConfig({});
    expect(getMimeProcessingRule('application/x-unknown', policy).mode).toBe('metadata');
  });

  it('rejects invalid policy modes', () => {
    expect(() => normalizeDocumentProcessingConfig({
      mimeTypes: { 'application/pdf': { mode: 'vision' } },
    })).toThrow();
  });
});
