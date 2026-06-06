import { describe, expect, it } from 'vitest';
import { acquireRedisLock, readJson, redis, writeJson } from '../redis.js';

describe('syncer redis helpers', () => {
  it('stores JSON values and releases distributed locks', async () => {
    const suffix = `${Date.now()}:${Math.random()}`;
    const statusKey = `test:json:${suffix}`;
    const lockKey = `test:lock:${suffix}`;

    await writeJson(statusKey, { state: 'running', count: 1 }, 60);
    await expect(readJson<{ state: string; count: number }>(statusKey)).resolves.toEqual({
      state: 'running',
      count: 1,
    });

    const lock = await acquireRedisLock(lockKey, 60);
    expect(lock).not.toBeNull();
    await expect(acquireRedisLock(lockKey, 60)).resolves.toBeNull();

    await lock?.release();
    const secondLock = await acquireRedisLock(lockKey, 60);
    expect(secondLock).not.toBeNull();
    await secondLock?.release();
    await redis.del(statusKey, lockKey);
  });
});
