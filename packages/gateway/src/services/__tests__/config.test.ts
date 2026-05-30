import { describe, it, expect, beforeEach } from 'vitest';
import { getRuntimeConfig, setRuntimeConfig, resetRuntimeConfig, RuntimeConfig } from '../config.js';
import { redis } from '../redis.js';

describe('Runtime Config', () => {
  beforeEach(async () => {
    await resetRuntimeConfig();
  });

  it('returns defaults when Redis is empty', async () => {
    await redis.del('ai:gateway:settings');
    const config = await getRuntimeConfig();
    expect(config.temperature).toBe(0.3);
    expect(config.topK).toBe(4);
    expect(config.maxTokens).toBe(1024);
  });

  it('saves and retrieves custom values', async () => {
    await setRuntimeConfig({ temperature: 0.8, topK: 6 });
    const config = await getRuntimeConfig();
    expect(config.temperature).toBe(0.8);
    expect(config.topK).toBe(6);
    expect(config.maxTokens).toBe(1024); // unchanged
  });

  it('resets to defaults', async () => {
    await setRuntimeConfig({ temperature: 0.9 });
    await resetRuntimeConfig();
    const config = await getRuntimeConfig();
    expect(config.temperature).toBe(0.3);
  });
});
