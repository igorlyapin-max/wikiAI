import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { ensureCollection } from './services/qdrant.js';
import { redis } from './services/redis.js';
import { healthRoutes } from './routes/health.js';
import { searchRoutes } from './routes/search.js';
import { chatRoutes } from './routes/chat.js';
import { adminRoutes } from './routes/admin.js';

const app = Fastify({
  logger: config.nodeEnv === 'development',
});

app.addHook('onReady', async () => {
  await ensureCollection();
  console.log('Gateway ready, Qdrant collection ensured');
});

app.addHook('onClose', async () => {
  console.log('Gateway shutting down');
});

async function start(): Promise<void> {
  // Register rate limit plugin with Redis store
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis: redis,
    keyGenerator: (req) => req.ip,
    skipOnError: true,
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}`,
      retryAfter: context.after,
    }),
  });

  // Health check - no rate limit
  await app.register(healthRoutes, { prefix: '' });

  // Routes with default rate limit (100/min)
  // Route-specific stricter limits are applied in route files via preHandler
  await app.register(searchRoutes);
  await app.register(chatRoutes);
  await app.register(adminRoutes);

  try {
    await app.listen({ port: config.gatewayPort, host: '0.0.0.0' });
    console.log(`Gateway listening on http://0.0.0.0:${config.gatewayPort}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
