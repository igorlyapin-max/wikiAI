import { beforeEach, describe, expect, it } from 'vitest';

describe('redis cache helpers', () => {
  beforeEach(async () => {
    process.env.REDIS_URL = 'memory://test';
    const { redis } = await import('../redis.js');
    await redis.quit();
  });

  it('caches MediaWiki user groups with TTL', async () => {
    const { cacheUserGroups, getCachedUserGroups } = await import('../redis.js');

    await cacheUserGroups('session-1', ['sysop', 'aiadmin'], 300);

    await expect(getCachedUserGroups('session-1')).resolves.toEqual(['sysop', 'aiadmin']);
  });

  it('caches full MediaWiki user info with TTL', async () => {
    const { cacheUserInfo, getCachedUserInfo } = await import('../redis.js');

    await cacheUserInfo('session-1', {
      username: 'Admin',
      userId: 2,
      groups: ['sysop', 'aiadmin'],
      rights: ['read'],
    }, 300);

    await expect(getCachedUserInfo('session-1')).resolves.toEqual({
      username: 'Admin',
      userId: 2,
      groups: ['sysop', 'aiadmin'],
      rights: ['read'],
    });
  });

  it('returns null for a missing user group cache entry', async () => {
    const { getCachedUserGroups } = await import('../redis.js');

    await expect(getCachedUserGroups('missing')).resolves.toBeNull();
  });

  it('clears all cached user group keys across scan pages', async () => {
    const {
      appendChatMessage,
      cacheUserInfo,
      cacheUserGroups,
      clearUserGroupCache,
      getCachedUserInfo,
      getCachedUserGroups,
      getChatHistory,
    } = await import('../redis.js');
    await cacheUserGroups('a', ['a'], 300);
    await cacheUserGroups('b', ['b'], 300);
    await cacheUserInfo('c', { username: 'User C', userId: 3, groups: ['c'] }, 300);
    await appendChatMessage('s', 'c', { role: 'user', content: 'keep' }, 60);

    await expect(clearUserGroupCache()).resolves.toBe(3);

    await expect(getCachedUserGroups('a')).resolves.toBeNull();
    await expect(getCachedUserGroups('b')).resolves.toBeNull();
    await expect(getCachedUserInfo('c')).resolves.toBeNull();
    await expect(getChatHistory('s', 'c')).resolves.toEqual([{ role: 'user', content: 'keep' }]);
  });

  it('appends chat messages while preserving existing history', async () => {
    const { appendChatMessage, getChatHistory } = await import('../redis.js');

    await appendChatMessage('session-1', 'conv-1', { role: 'user', content: 'Hi' }, 60);
    await appendChatMessage('session-1', 'conv-1', { role: 'assistant', content: 'Hello' }, 60);

    await expect(getChatHistory('session-1', 'conv-1')).resolves.toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ]);
  });
});
