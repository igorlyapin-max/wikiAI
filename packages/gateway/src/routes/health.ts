import { FastifyInstance } from 'fastify';
import { qdrant } from '../services/qdrant.js';
import { redis } from '../services/redis.js';
import { config } from '../config.js';
import { currentTraceHeaders } from '../services/tracing.js';
import { recordHealthCheckMetric } from '../services/metrics.js';

export interface HealthCheck {
  status: string;
  latencyMs: number;
  error?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded';
  checks: Record<string, HealthCheck>;
}

export interface LiveStatus {
  status: 'ok';
  service: 'gateway';
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${config.healthCheckTimeoutMs}ms`)), config.healthCheckTimeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runCheck(name: string, operation: () => Promise<void>): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await withTimeout(operation(), name);
    const latencyMs = Date.now() - start;
    recordHealthCheckMetric({ check: name, ok: true, latencyMs });
    return { status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    recordHealthCheckMetric({ check: name, ok: false, latencyMs });
    return { status: 'error', latencyMs, error: (err as Error).message };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.healthCheckTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function getLiveStatus(): LiveStatus {
  return { status: 'ok', service: 'gateway' };
}

export async function getReadinessStatus(): Promise<HealthStatus> {
  const checks: Record<string, HealthCheck> = {};

  checks.qdrant = await runCheck('qdrant', async () => {
    await qdrant.getCollections();
  });

  checks.redis = await runCheck('redis', async () => {
    await redis.ping();
  });

  checks.litellm = await runCheck('litellm', async () => {
    const litellmHost = config.litellmBaseUrl.replace('/v1', '');
    const res = await fetchWithTimeout(`${litellmHost}/health/readiness`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.litellmApiKey}`, ...currentTraceHeaders() },
    });
    if (!res.ok) throw new Error(`LiteLLM readiness failed with HTTP ${res.status}`);
  });

  const allOk = Object.values(checks).every((c) => c.status === 'ok');
  return {
    status: allOk ? 'healthy' : 'degraded',
    checks,
  };
}

export const getHealthStatus = getReadinessStatus;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/live', async () => getLiveStatus());

  app.get('/ready', async (_request, reply) => {
    const health = await getReadinessStatus();
    reply.status(health.status === 'healthy' ? 200 : 503).send(health);
  });

  app.get('/health', async (_request, reply) => {
    const health = await getReadinessStatus();
    reply.status(health.status === 'healthy' ? 200 : 503).send(health);
  });
}
