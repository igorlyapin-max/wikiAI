import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisData = vi.hoisted(() => new Map<string, string>());
const scanPages = vi.hoisted(() => new Map<string, [string, string[]]>());
const redisClient = vi.hoisted(() => ({
  on: vi.fn(),
  get: vi.fn(async (key: string) => redisData.get(key) ?? null),
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    redisData.set(key, value);
    return 'OK';
  }),
  scan: vi.fn(async (cursor: string) => scanPages.get(cursor) ?? ['0', []]),
  del: vi.fn(async (...keys: string[]) => {
    let deleted = 0;
    for (const key of keys) {
      if (redisData.delete(key)) deleted++;
    }
    return deleted;
  }),
}));

vi.mock('ioredis', () => ({
  default: vi.fn(function Redis() {
    return redisClient;
  }),
}));

describe('redis cache helpers', () => {
  beforeEach(() => {
    redisData.clear();
    scanPages.clear();
    vi.clearAllMocks();
  });

  it('caches MediaWiki user groups with TTL', async () => {
    const { cacheUserGroups, getCachedUserGroups } = await import('../redis.js');

    await cacheUserGroups('session-1', ['sysop', 'aiadmin'], 300);

    expect(redisClient.setex).toHaveBeenCalledWith(
      'mw:groups:session-1',
      300,
      JSON.stringify(['sysop', 'aiadmin'])
    );
    await expect(getCachedUserGroups('session-1')).resolves.toEqual(['sysop', 'aiadmin']);
  });

  it('returns null for a missing user group cache entry', async () => {
    const { getCachedUserGroups } = await import('../redis.js');

    await expect(getCachedUserGroups('missing')).resolves.toBeNull();
  });

  it('clears all cached user group keys across scan pages', async () => {
    const { clearUserGroupCache } = await import('../redis.js');
    redisData.set('mw:groups:a', '["a"]');
    redisData.set('mw:groups:b', '["b"]');
    redisData.set('chat:s:c', '[]');
    scanPages.set('0', ['2', ['mw:groups:a']]);
    scanPages.set('2', ['0', ['mw:groups:b']]);

    await expect(clearUserGroupCache()).resolves.toBe(2);

    expect(redisClient.scan).toHaveBeenCalledWith('0', 'MATCH', 'mw:groups:*', 'COUNT', 100);
    expect(redisClient.scan).toHaveBeenCalledWith('2', 'MATCH', 'mw:groups:*', 'COUNT', 100);
    expect(redisData.has('chat:s:c')).toBe(true);
  });

  it('appends chat messages while preserving existing history', async () => {
    const { appendChatMessage, getChatHistory } = await import('../redis.js');

    await appendChatMessage('session-1', 'conv-1', { role: 'user', content: 'Hi' }, 60);
    await appendChatMessage('session-1', 'conv-1', { role: 'assistant', content: 'Hello' }, 60);

    await expect(getChatHistory('session-1', 'conv-1')).resolves.toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(redisClient.setex).toHaveBeenLastCalledWith(
      'chat:session-1:conv-1',
      60,
      JSON.stringify([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ])
    );
  });
});
