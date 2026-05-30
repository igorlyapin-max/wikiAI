import { FastifyInstance } from 'fastify';
import { mwAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getEmbedding } from '../services/embedding.js';
import { searchChunks } from '../services/qdrant.js';
import { userCanRead } from '../services/mediawiki.js';
import { getRuntimeConfig } from '../services/config.js';
import { SearchRequest } from '../types/index.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SearchRequest }>(
    '/api/search',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const { query, topK } = request.body;
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const cookie = (request as AuthenticatedRequest).sessionCookie;

      if (!query || query.trim().length === 0) {
        reply.status(400).send({ error: 'Query is required' });
        return;
      }

      const runtime = await getRuntimeConfig();
      const embedding = await getEmbedding(query);
      const rawChunks = await searchChunks(embedding, mwUser.groups, topK ?? runtime.topK);

      const results: typeof rawChunks = [];
      for (const chunk of rawChunks) {
        if (chunk.allowedGroups.includes('*')) {
          results.push(chunk);
          continue;
        }
        const hasGroup = chunk.allowedGroups.some((g) => mwUser.groups.includes(g));
        if (!hasGroup) continue;
        if (chunk.namespace !== 0 || chunk.allowedGroups.length > 1) {
          const canRead = await userCanRead(cookie, chunk.title);
          if (canRead) results.push(chunk);
        } else {
          results.push(chunk);
        }
        if (results.length >= (topK ?? runtime.topK)) break;
      }

      reply.send({
        query,
        user: mwUser.username,
        groups: mwUser.groups,
        results,
      });
    }
  );
}
