import { FastifyInstance, FastifyRequest } from 'fastify';
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
      const { query, topK } = request.body;
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const cookie = (request as AuthenticatedRequest).sessionCookie;

      if (!query || query.trim().length === 0) {
        reply.status(400).send({ error: 'Query is required' });
        return;
      }

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
