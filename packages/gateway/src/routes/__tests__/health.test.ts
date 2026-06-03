import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { healthRoutes } from '../health.js';

const qdrantGetCollections = vi.hoisted(() => vi.fn());
const redisPing = vi.hoisted(() => vi.fn());

vi.mock('../../services/qdrant.js', () => ({
  qdrant: {
    getCollections: qdrantGetCollections,
  },
}));

vi.mock('../../services/redis.js', () => ({
  redis: {
    ping: redisPing,
  },
}));

describe('health routes', () => {
  beforeEach(() => {
    qdrantGetCollections.mockReset();
    redisPing.mockReset();
    qdrantGetCollections.mockResolvedValue({ collections: [] });
    redisPing.mockResolvedValue('PONG');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
  });

  async function makeApp() {
    const app = Fastify();
    await app.register(healthRoutes);
    return app;
  }

  it('reports live and healthy readiness when dependencies respond', async () => {
    const app = await makeApp();

    const live = await app.inject({ method: 'GET', url: '/live' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok', service: 'gateway' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'healthy',
      checks: {
        qdrant: { status: 'ok' },
        redis: { status: 'ok' },
        litellm: { status: 'ok' },
      },
    });
    await app.close();
  });

  it('returns degraded health when dependency checks fail', async () => {
    qdrantGetCollections.mockRejectedValueOnce(new Error('qdrant offline'));
    redisPing.mockResolvedValueOnce('PONG');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const app = await makeApp();

    const health = await app.inject({ method: 'GET', url: '/health' });

    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({
      status: 'degraded',
      checks: {
        qdrant: { status: 'error', error: 'qdrant offline' },
        redis: { status: 'ok' },
        litellm: { status: 'error', error: 'LiteLLM readiness failed with HTTP 503' },
      },
    });
    await app.close();
  });
});
