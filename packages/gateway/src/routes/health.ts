import { FastifyInstance } from 'fastify';
import { qdrant } from '../services/qdrant.js';
import { redis } from '../services/redis.js';
import { config } from '../config.js';

export interface HealthCheck {
  status: string;
  latencyMs: number;
  error?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded';
  checks: Record<string, HealthCheck>;
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const checks: Record<string, HealthCheck> = {};

  const qdrantStart = Date.now();
  try {
    await qdrant.getCollections();
    checks.qdrant = { status: 'ok', latencyMs: Date.now() - qdrantStart };
  } catch (err) {
    checks.qdrant = { status: 'error', latencyMs: Date.now() - qdrantStart, error: (err as Error).message };
  }

  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
  } catch (err) {
    checks.redis = { status: 'error', latencyMs: Date.now() - redisStart, error: (err as Error).message };
  }

  const litellmStart = Date.now();
  try {
    const litellmHost = config.litellmBaseUrl.replace('/v1', '');
    const res = await fetch(`${litellmHost}/health/readiness`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.litellmApiKey}` },
    });
    checks.litellm = {
      status: res.ok ? 'ok' : 'error',
      latencyMs: Date.now() - litellmStart,
    };
  } catch (err) {
    checks.litellm = { status: 'error', latencyMs: Date.now() - litellmStart, error: (err as Error).message };
  }

  const allOk = Object.values(checks).every((c) => c.status === 'ok');
  return {
    status: allOk ? 'healthy' : 'degraded',
    checks,
  };
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const health = await getHealthStatus();
    reply.status(health.status === 'healthy' ? 200 : 503).send(health);
  });
}
