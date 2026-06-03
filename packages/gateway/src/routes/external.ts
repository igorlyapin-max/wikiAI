import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { fetchUserInfo } from '../services/mediawiki.js';
import {
  externalOidcConfigured,
  getExternalApiConfig,
  toExternalApiCapabilities,
  type ExternalApiConfig,
} from '../services/external-api-config.js';
import {
  anonymousPrincipal,
  authenticateOidcBearerToken,
  principalFromMwUser,
} from '../services/principal-auth.js';
import { RuntimeHttpError } from '../services/runtime-errors.js';
import { executeRuntimeSearch } from '../services/runtime-search.js';
import {
  completeRuntimeChat,
  prepareRuntimeChat,
  streamRuntimeChat,
} from '../services/runtime-chat.js';
import { type WikiPageUrlOptions } from '../services/mediawiki-url.js';
import { AuthenticatedPrincipal } from '../types/index.js';

const searchBodySchema = z.object({
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).optional(),
  format: z.enum(['compact', 'full']).optional(),
  language: z.string().trim().min(1).max(20).optional(),
}).strict();

const chatBodySchema = z.object({
  message: z.string().trim().min(1).max(12000),
  conversationId: z.string().trim().min(1).max(200).optional(),
  stream: z.boolean().optional(),
  topK: z.number().int().min(1).max(50).optional(),
  format: z.enum(['compact', 'full']).optional(),
  language: z.string().trim().min(1).max(20).optional(),
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

function readBearerToken(value: string | string[] | undefined): string | undefined {
  const header = readHeader(value);
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function principalFromExternalRequest(input: {
  request: FastifyRequest;
  configValue: ExternalApiConfig;
  anonymousAllowed: boolean;
}): Promise<AuthenticatedPrincipal> {
  const bearerToken = readBearerToken(input.request.headers.authorization);
  if (bearerToken) {
    try {
      return await authenticateOidcBearerToken(bearerToken, input.configValue);
    } catch (err) {
      throw new RuntimeHttpError(401, {
        error: 'Invalid Bearer token',
        message: err instanceof Error ? err.message : 'OIDC authentication failed',
      });
    }
  }

  const cookie = readHeader(input.request.headers.cookie);
  if (cookie) {
    const mwUser = await fetchUserInfo(cookie);
    if (mwUser) {
      return principalFromMwUser(mwUser, cookie);
    }
    if (!input.anonymousAllowed) {
      throw new RuntimeHttpError(401, { error: 'Invalid or expired MediaWiki session' });
    }
  }

  if (input.anonymousAllowed) {
    return anonymousPrincipal();
  }

  throw new RuntimeHttpError(401, {
    error: externalOidcConfigured(input.configValue)
      ? 'Missing authentication'
      : 'Missing authentication; OIDC is not configured',
  });
}

function buildSseHeaders(origin: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };

  if (typeof origin === 'string' && config.corsOrigins.includes(origin)) {
    headers.Vary = 'Origin';
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function sendRuntimeError(reply: { status: (code: number) => { send: (payload: unknown) => void } }, err: unknown): boolean {
  if (err instanceof RuntimeHttpError) {
    reply.status(err.statusCode).send(err.payload);
    return true;
  }
  return false;
}

export async function externalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/capabilities', async (_request, reply) => {
    const configValue = await getExternalApiConfig();
    reply.send(toExternalApiCapabilities(configValue));
  });

  app.post<{ Body: unknown }>(
    '/api/v1/search',
    {
      preHandler: app.rateLimit({ max: 60, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
    },
    async (request, reply) => {
      const configValue = await getExternalApiConfig();
      if (!configValue.enabled) {
        reply.status(403).send({ error: 'External API disabled' });
        return;
      }

      const parsed = searchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400).send({ error: 'Invalid search request', details: parsed.error.flatten() });
        return;
      }

      try {
        const principal = await principalFromExternalRequest({
          request,
          configValue,
          anonymousAllowed: configValue.anonymousSearchAllowed,
        });
        reply.send(await executeRuntimeSearch({
          query: parsed.data.query,
          topK: parsed.data.topK,
          principal,
          wikiUrlOptions: wikiUrlOptionsFromRequest(request),
          maxTopK: configValue.maxTopK,
          aclMode: configValue.aclMode,
        }));
      } catch (err) {
        if (sendRuntimeError(reply, err)) return;
        throw err;
      }
    }
  );

  app.post<{ Body: unknown }>(
    '/api/v1/chat',
    {
      preHandler: app.rateLimit({ max: 20, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
    },
    async (request, reply) => {
      const configValue = await getExternalApiConfig();
      if (!configValue.enabled) {
        reply.status(403).send({ error: 'External API disabled' });
        return;
      }

      const parsed = chatBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400).send({ error: 'Invalid chat request', details: parsed.error.flatten() });
        return;
      }

      try {
        const principal = await principalFromExternalRequest({
          request,
          configValue,
          anonymousAllowed: false,
        });
        const prepared = await prepareRuntimeChat({
          message: parsed.data.message,
          conversationId: parsed.data.conversationId,
          principal,
          wikiUrlOptions: wikiUrlOptionsFromRequest(request),
          topK: parsed.data.topK,
          maxTopK: configValue.maxTopK,
          aclMode: configValue.aclMode,
        });

        if (parsed.data.stream === true) {
          reply.raw.writeHead(200, buildSseHeaders(request.headers.origin));
          await streamRuntimeChat(prepared, (payload) => {
            if (payload === '[DONE]') {
              reply.raw.write('data: [DONE]\n\n');
              return;
            }
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          });
          reply.raw.end();
          return;
        }

        reply.send(await completeRuntimeChat(prepared));
      } catch (err) {
        if (sendRuntimeError(reply, err)) return;
        throw err;
      }
    }
  );
}
