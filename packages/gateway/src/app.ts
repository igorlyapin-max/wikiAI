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
import { healthRoutes } from './routes/health.js';
import { searchRoutes } from './routes/search.js';
import { chatRoutes } from './routes/chat.js';
import { adminRoutes } from './routes/admin.js';
import { externalRoutes } from './routes/external.js';

export function buildGatewayApp(): FastifyInstance {
  const app = Fastify({
    logger: createFastifyLoggerOptions(),
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
      allowedHeaders: ['Content-Type', 'Authorization'],
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
