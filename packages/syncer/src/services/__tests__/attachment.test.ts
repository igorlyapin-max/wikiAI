import { describe, expect, it } from 'vitest';
import { getMetadataText, processAttachment } from '../attachment.js';
import { normalizeDocumentProcessingConfig } from '../document-policy.js';

describe('attachment processing', () => {
  it('extracts text/plain when policy mode is text', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'text/plain': { mode: 'text' } },
    });
    const result = await processAttachment(Buffer.from('hello wiki'), 'text/plain', 'note.txt', policy);
    expect(result.text).toBe('hello wiki');
    expect(result.metadata.mode).toBe('text');
  });

  it('returns metadata-only for metadata mode', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'text/plain': { mode: 'metadata' } },
    });
    const result = await processAttachment(Buffer.from('hidden'), 'text/plain', 'note.txt', policy);
    expect(result.text).toBe('');
    expect(result.metadata.mode).toBe('metadata');
    expect(getMetadataText('note.txt', 'text/plain', result.metadata)).toContain('note.txt');
  });

  it('returns metadata error when maxBytes is exceeded', async () => {
    const policy = normalizeDocumentProcessingConfig({
      mimeTypes: { 'text/plain': { mode: 'text', maxBytes: 2 } },
    });
    const result = await processAttachment(Buffer.from('hidden'), 'text/plain', 'note.txt', policy);
    expect(result.text).toBe('');
    expect(result.metadata.error).toBe('max_bytes_exceeded');
  });
});
