import { describe, it, expect } from 'vitest';
import { SearchChunk } from '../../types/index.js';
import { filterReadableChunks, filterReadableChunksForPrincipal } from '../acl.js';

describe('ACL Chunk Filtering', () => {
  const chunks: SearchChunk[] = [
    { id: 1, pageId: 1, title: 'Public', text: 'text', namespace: 0, allowedGroups: ['*'], score: 0.9 },
    { id: 2, pageId: 2, title: 'Engineering', text: 'text', namespace: 0, allowedGroups: ['engineer'], score: 0.8 },
    { id: 3, pageId: 3, title: 'Finance', text: 'text', namespace: 0, allowedGroups: ['finance', 'management'], score: 0.7 },
    { id: 4, pageId: 4, title: 'Secret', text: 'text', namespace: 0, allowedGroups: ['*'], score: 0.6 },
  ];

  it('post-checks every chunk with MediaWiki, including public fallback groups', async () => {
    const checkedTitles: string[] = [];
    const result = await filterReadableChunks(
      chunks,
      'mw-session',
      10,
      async (_cookie, title) => {
        checkedTitles.push(title);
        return title !== 'Secret';
      }
    );

    expect(result.map((r) => r.title)).toEqual(['Public', 'Engineering', 'Finance']);
    expect(checkedTitles).toEqual(['Public', 'Engineering', 'Finance', 'Secret']);
  });

  it('does not treat allowedGroups wildcard as sufficient access', async () => {
    const result = await filterReadableChunks(
      chunks,
      'mw-session',
      10,
      async (_cookie, title) => title !== 'Public' && title !== 'Secret'
    );

    expect(result.map((r) => r.title)).toEqual(['Engineering', 'Finance']);
  });

  it('allows chunks when MediaWiki says readable even if payload groups do not match user groups', async () => {
    const result = await filterReadableChunks(
      chunks,
      'mw-session',
      10,
      async (_cookie, title) => title === 'Finance'
    );

    expect(result.map((r) => r.title)).toEqual(['Finance']);
  });

  it('caches MediaWiki readability checks by page title', async () => {
    const repeatedPageChunks: SearchChunk[] = [
      ...chunks,
      { id: 5, pageId: 1, title: 'Public', text: 'more text', namespace: 0, allowedGroups: ['*'], score: 0.5 },
    ];
    const checkedTitles: string[] = [];

    await filterReadableChunks(
      repeatedPageChunks,
      'mw-session',
      10,
      async (_cookie, title) => {
        checkedTitles.push(title);
        return true;
      }
    );

    expect(checkedTitles.filter((title) => title === 'Public')).toHaveLength(1);
  });

  it('can explicitly use indexed allowedGroups for groups_only external ACL mode', async () => {
    const result = await filterReadableChunksForPrincipal(
      chunks,
      {
        authMode: 'oidc',
        username: 'external-user',
        userId: 1_000_000_001,
        groups: ['finance'],
        bearerToken: 'token',
        subject: 'external-user',
      },
      10,
      'groups_only',
      async () => {
        throw new Error('MediaWiki should not be called in groups_only mode');
      }
    );

    expect(result.map((r) => r.title)).toEqual(['Public', 'Finance', 'Secret']);
  });
});
