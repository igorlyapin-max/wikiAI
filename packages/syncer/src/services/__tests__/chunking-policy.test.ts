import { describe, expect, it } from 'vitest';
import {
  legacyChunkingRule,
  normalizeChunkingPolicy,
  resolveChunkingOptions,
} from '../chunking-policy.js';

describe('chunking policy resolver', () => {
  it('uses source-specific chunking over the legacy fallback', () => {
    const legacy = legacyChunkingRule({
      chunkSize: 512,
      chunkOverlap: 50,
      chunkSeparators: ['\n\n'],
    });
    const policy = normalizeChunkingPolicy({
      defaults: { chunkSize: 700, chunkOverlap: 70, chunkSeparators: ['\n\n'] },
      sources: {
        attachment_text: { chunkSize: 1200, chunkOverlap: 180, chunkSeparators: ['\n'] },
      },
      namespaceOverrides: {},
    }, legacy);

    expect(resolveChunkingOptions({
      policy,
      sourceType: 'attachment_text',
      namespace: 0,
    })).toEqual({
      chunkSize: 1200,
      chunkOverlap: 180,
      chunkSeparators: ['\n'],
    });
  });

  it('applies namespace overrides only to wiki pages', () => {
    const legacy = legacyChunkingRule({ chunkSize: 512, chunkOverlap: 50 });
    const policy = normalizeChunkingPolicy({
      defaults: { chunkSize: 700, chunkOverlap: 70, chunkSeparators: ['\n\n'] },
      sources: {
        wiki_page: { chunkSize: 900, chunkOverlap: 90, chunkSeparators: ['\n\n'] },
        attachment_text: { chunkSize: 1200, chunkOverlap: 180, chunkSeparators: ['\n'] },
      },
      namespaceOverrides: {
        '3030': { chunkSize: 640, chunkOverlap: 80 },
      },
    }, legacy);

    expect(resolveChunkingOptions({
      policy,
      sourceType: 'wiki_page',
      namespace: 3030,
    })).toMatchObject({ chunkSize: 640, chunkOverlap: 80 });
    expect(resolveChunkingOptions({
      policy,
      sourceType: 'attachment_text',
      namespace: 3030,
    })).toMatchObject({ chunkSize: 1200, chunkOverlap: 180 });
  });
});
