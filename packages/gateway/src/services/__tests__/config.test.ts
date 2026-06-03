import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('../redis.js', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  },
}));

describe('Runtime Config', () => {
  beforeEach(() => {
    store.clear();
  });

  it('returns defaults when Redis is empty', async () => {
    const { getRuntimeConfig } = await import('../config.js');
    const config = await getRuntimeConfig();
    expect(config.temperature).toBe(0.3);
    expect(config.topK).toBe(4);
    expect(config.maxTokens).toBe(1024);
  });

  it('saves and retrieves custom values', async () => {
    const { getRuntimeConfig, setRuntimeConfig } = await import('../config.js');
    await setRuntimeConfig({ temperature: 0.8, topK: 6 });
    const config = await getRuntimeConfig();
    expect(config.temperature).toBe(0.8);
    expect(config.topK).toBe(6);
    expect(config.maxTokens).toBe(1024);
  });

  it('resets to defaults', async () => {
    const { getRuntimeConfig, resetRuntimeConfig, setRuntimeConfig } = await import('../config.js');
    await setRuntimeConfig({ temperature: 0.9 });
    await resetRuntimeConfig();
    const config = await getRuntimeConfig();
    expect(config.temperature).toBe(0.3);
  });
});
