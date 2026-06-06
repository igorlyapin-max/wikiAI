import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { ensureCollection } from './services/qdrant.js';
import { redis } from './services/redis.js';
import { startIndexingProfileScheduler, stopIndexingProfileScheduler } from './services/indexing-profile-scheduler.js';
import { startTrustRecalculationScheduler, stopTrustRecalculationScheduler } from './services/trust-recalculation-scheduler.js';
import { createFastifyLoggerOptions, diagnosticStartupFields } from './services/logging.js';
import { registerMetrics } from './services/metrics.js';
import { enterTraceContext, getTraceContext, traceContextFromHeaders } from './services/tracing.js';
import { healthRoutes } from './routes/health.js';
import { searchRoutes } from './routes/search.js';
import { chatRoutes } from './routes/chat.js';
import { adminRoutes } from './routes/admin.js';
import { externalRoutes } from './routes/external.js';

export function buildGatewayApp(): FastifyInstance {
  const app = Fastify({
    logger: createFastifyLoggerOptions(),
    bodyLimit: config.httpBodyLimitBytes,
  });

  app.addHook('onRequest', async (request, reply) => {
    const traceContext = traceContextFromHeaders(request.headers);
    enterTraceContext(traceContext);
    reply.header('x-request-id', traceContext.requestId);
    if (traceContext.traceparent) reply.header('traceparent', traceContext.traceparent);
  });

  app.setErrorHandler((err, request, reply) => {
    const error = err as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    const message = typeof error.message === 'string' ? error.message : 'Unknown request error';
    request.log.error(
      { event: 'gateway.request_error', err, requestId: getTraceContext()?.requestId },
      'Gateway request failed'
    );
    reply.status(statusCode).send({
      error: statusCode === 413 ? 'Payload too large' : 'Request failed',
      message: statusCode >= 500 && config.nodeEnv === 'production' ? 'Internal server error' : message,
      requestId: getTraceContext()?.requestId,
    });
  });

  registerMetrics(app, 'gateway');

  app.addHook('onReady', async () => {
    await ensureCollection();
    startIndexingProfileScheduler();
    startTrustRecalculationScheduler();
    app.log.info(
      {
        event: 'gateway.ready',
        ...(config.debugDiagnosticsEnabled ? diagnosticStartupFields() : {}),
      },
      'Gateway ready, Qdrant collection ensured'
    );
  });

  app.addHook('onClose', async () => {
    app.log.info({ event: 'gateway.shutdown' }, 'Gateway shutting down');
    stopIndexingProfileScheduler();
    stopTrustRecalculationScheduler();
    await redis.quit();
  });

  if (config.corsOrigins.length > 0) {
    void app.register(cors, {
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow: boolean) => void
      ) => {
        callback(null, !origin || config.corsOrigins.includes(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'traceparent'],
    });
  }

  void app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) => req.ip,
    skipOnError: true,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}`,
      retryAfter: context.after,
    }),
  });

  void app.register(healthRoutes, { prefix: '' });
  void app.register(searchRoutes);
  void app.register(chatRoutes);
  void app.register(externalRoutes);
  void app.register(adminRoutes);

  return app;
}
