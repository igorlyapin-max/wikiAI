import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mwOptionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { type WikiPageUrlOptions } from '../services/mediawiki-url.js';
import { executeRuntimeSearch } from '../services/runtime-search.js';
import { RuntimeHttpError } from '../services/runtime-errors.js';
import { principalFromMwUser } from '../services/principal-auth.js';
import { getRuntimeConfig } from '../services/config.js';
import {
  getMediaWikiProfileConfig,
  getMediaWikiProfileConfigStatus,
} from '../services/mediawiki-profile-config.js';
import { SearchRequest } from '../types/index.js';

const searchRequestSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(20).optional(),
  retrievalProfileId: z.string().trim().min(1).optional(),
  context: z.unknown().optional(),
}).strict();

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function wikiUrlOptionsFromRequest(request: FastifyRequest): WikiPageUrlOptions {
  return {
    requestOrigin: readHeader(request.headers.origin),
    requestHost: readHeader(request.headers.host),
    requestProtocol: readHeader(request.headers['x-forwarded-proto']),
  };
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ui/config', async (_request, reply) => {
    const [runtime, profileStatus] = await Promise.all([
      getRuntimeConfig(),
      getMediaWikiProfileConfigStatus(),
    ]);
    reply.send({
      values: {
        searchHistoryEnabled: runtime.searchHistoryEnabled,
        searchHistoryLimit: runtime.searchHistoryLimit,
        mediaWikiRetrievalProfileId: profileStatus.values.defaultRetrievalProfileId,
        mediaWikiRetrievalProfileName: profileStatus.selectedProfile?.name,
        mediaWikiRetrievalProfileReadiness: profileStatus.selectedProfile?.readiness.status,
        mediaWikiRetrievalProfileReasons: profileStatus.selectedProfile?.readiness.reasons ?? [],
      },
    });
  });

  app.post<{ Body: SearchRequest }>(
    '/api/search',
    {
      preHandler: [
        mwOptionalAuthMiddleware,
        app.rateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const parsed = searchRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        if (parsed.error.issues.some((issue) => issue.path[0] === 'query' && issue.code === 'too_small')) {
          reply.status(400).send({ error: 'Query is required' });
          return;
        }
        reply.status(400).send({ error: 'Invalid search request', issues: parsed.error.issues });
        return;
      }

      const { query, topK } = parsed.data;
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const cookie = (request as AuthenticatedRequest).sessionCookie;

      try {
        const mediaWikiProfile = await getMediaWikiProfileConfig();
        reply.send(await executeRuntimeSearch({
          query,
          topK,
          retrievalProfileId: mediaWikiProfile.defaultRetrievalProfileId,
          retrievalProfileSurface: 'mediawiki',
          principal: principalFromMwUser(mwUser, cookie),
          wikiUrlOptions: wikiUrlOptionsFromRequest(request),
          aclMode: 'mediawiki_check',
        }));
      } catch (err) {
        if (err instanceof RuntimeHttpError) {
          reply.status(err.statusCode).send(err.payload);
          return;
        }
        throw err;
      }
    }
  );
}
