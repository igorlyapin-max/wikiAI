import { describe, it, expect } from 'vitest';
import { SearchChunk } from '../../types/index.js';

function filterChunks(
  chunks: SearchChunk[],
  userGroups: string[]
): SearchChunk[] {
  return chunks.filter((chunk) => {
    if (chunk.allowedGroups.includes('*')) return true;
    return chunk.allowedGroups.some((g) => userGroups.includes(g));
  });
}

describe('ACL Chunk Filtering', () => {
  const chunks: SearchChunk[] = [
    { id: 1, pageId: 1, title: 'Public', text: 'text', namespace: 0, allowedGroups: ['*'], score: 0.9 },
    { id: 2, pageId: 2, title: 'Engineering', text: 'text', namespace: 0, allowedGroups: ['engineer'], score: 0.8 },
    { id: 3, pageId: 3, title: 'Finance', text: 'text', namespace: 0, allowedGroups: ['finance', 'management'], score: 0.7 },
    { id: 4, pageId: 4, title: 'Secret', text: 'text', namespace: 0, allowedGroups: ['security'], score: 0.6 },
  ];

  it('shows public docs to anyone', () => {
    const result = filterChunks(chunks, ['user']);
    expect(result.map((r) => r.title)).toContain('Public');
  });

  it('shows engineering docs to engineers', () => {
    const result = filterChunks(chunks, ['user', 'engineer']);
    expect(result.map((r) => r.title)).toContain('Engineering');
  });

  it('hides finance docs from engineers', () => {
    const result = filterChunks(chunks, ['user', 'engineer']);
    expect(result.map((r) => r.title)).not.toContain('Finance');
  });

  it('shows finance docs to management', () => {
    const result = filterChunks(chunks, ['user', 'management']);
    expect(result.map((r) => r.title)).toContain('Finance');
  });

  it('shows nothing to user without groups', () => {
    const result = filterChunks(chunks, ['user']);
    expect(result.length).toBe(1); // only Public
    expect(result[0].title).toBe('Public');
  });

  it('hides all restricted docs from anonymous', () => {
    const result = filterChunks(chunks, ['*']);
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Public');
  });
});
