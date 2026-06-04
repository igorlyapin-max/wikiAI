import { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { mwAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import {
  getChatRetentionAdminConfig,
} from '../services/admin-platform-config.js';
import type { ChatExportFormat } from '../services/admin-platform-config.js';
import {
  archiveUserChatSession,
  enforceChatRetention,
  exportUserChatArchive,
  exportUserChatSession,
  getUserChatSessionMessages,
  listUserChatSessions,
  type ChatSessionStatus,
} from '../services/chat-store.js';
import { type WikiPageUrlOptions } from '../services/mediawiki-url.js';
import {
  buildChatRetrievalQuery,
  completeRuntimeChat,
  prepareRuntimeChat,
  streamRuntimeChat,
} from '../services/runtime-chat.js';
import { RuntimeHttpError } from '../services/runtime-errors.js';
import { principalFromMwUser } from '../services/principal-auth.js';
import { ChatRequest } from '../types/index.js';

export { buildChatRetrievalQuery };

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

function parseIntegerParam(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  return Number(value);
}

function parseChatSessionStatus(value: unknown): ChatSessionStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'deleted' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseChatExportFormat(value: unknown, allowedFormats: ChatExportFormat[]): ChatExportFormat {
  const requested = value === 'csv' || value === 'html' || value === 'json' ? value : 'json';
  if (allowedFormats.includes(requested)) return requested;
  return allowedFormats[0] ?? 'json';
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/chat/sessions',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      await enforceChatRetention(await getChatRetentionAdminConfig());
      const status = parseChatSessionStatus(request.query.status);
      const limit = parseIntegerParam(request.query.limit, 50);
      reply.send({
        values: await listUserChatSessions(mwUser.userId, status, limit),
      });
    }
  );

  app.get<{ Params: { sessionId: string } }>(
    '/api/chat/sessions/:sessionId/messages',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      try {
        reply.send({ values: await getUserChatSessionMessages(request.params.sessionId, mwUser.userId) });
      } catch (err) {
        reply.status(404).send({
          error: 'Chat session not found',
          message: err instanceof Error ? err.message : 'Unknown chat session error',
        });
      }
    }
  );

  app.post<{ Body: unknown }>(
    '/api/chat/archive/export',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const retention = await getChatRetentionAdminConfig();
      await enforceChatRetention(retention);
      const format = parseChatExportFormat(
        isRecord(request.body) ? request.body.format : undefined,
        retention.exportOptions.formats
      );
      reply.send({
        status: 'exported',
        values: await exportUserChatArchive(mwUser.userId, format, retention),
      });
    }
  );

  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/api/chat/sessions/:sessionId/archive',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 15, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const reason = isRecord(request.body) && typeof request.body.reason === 'string'
        ? request.body.reason
        : 'user';
      try {
        reply.send({
          status: 'archived',
          values: await archiveUserChatSession(request.params.sessionId, mwUser.userId, reason),
        });
      } catch (err) {
        reply.status(404).send({
          error: 'Chat session archive failed',
          message: err instanceof Error ? err.message : 'Unknown chat archive error',
        });
      }
    }
  );

  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/api/chat/sessions/:sessionId/export',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 15, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const retention = await getChatRetentionAdminConfig();
      const format = parseChatExportFormat(
        isRecord(request.body) ? request.body.format : undefined,
        retention.exportOptions.formats
      );
      try {
        reply.send({
          status: 'exported',
          values: await exportUserChatSession(request.params.sessionId, mwUser.userId, format, retention),
        });
      } catch (err) {
        reply.status(404).send({
          error: 'Chat session export failed',
          message: err instanceof Error ? err.message : 'Unknown chat export error',
        });
      }
    }
  );

  app.post<{ Body: ChatRequest }>(
    '/api/chat',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const { message, conversationId, stream: requestedStream, topK, retrievalProfileId } = request.body;
      const stream = requestedStream ?? true;
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const cookie = (request as AuthenticatedRequest).sessionCookie;

      if (!message || message.trim().length === 0) {
        reply.status(400).send({ error: 'Message is required' });
        return;
      }

      try {
        const prepared = await prepareRuntimeChat({
          message,
          conversationId,
          topK,
          retrievalProfileId,
          principal: principalFromMwUser(mwUser, cookie),
          wikiUrlOptions: wikiUrlOptionsFromRequest(request),
          aclMode: 'mediawiki_check',
        });

        if (!stream) {
          reply.send(await completeRuntimeChat(prepared));
          return;
        }

        reply.raw.writeHead(200, buildSseHeaders(request.headers.origin));
        await streamRuntimeChat(prepared, (payload) => {
          if (payload === '[DONE]') {
            reply.raw.write('data: [DONE]\n\n');
            return;
          }
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        });
        reply.raw.end();
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
