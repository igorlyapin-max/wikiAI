import { describe, expect, it } from 'vitest';
import { splitText } from '../chunker.js';

describe('chunker', () => {
  it('uses profile chunking options when provided', () => {
    const chunks = splitText('alpha beta gamma delta epsilon zeta eta theta '.repeat(20), {
      chunkSize: 16,
      chunkOverlap: 4,
      chunkSeparators: [' '],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.total === chunks.length)).toBe(true);
  });

  it('clamps overlap below chunk size', () => {
    const chunks = splitText('a'.repeat(300), {
      chunkSize: 128,
      chunkOverlap: 999,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(128);
  });
});
