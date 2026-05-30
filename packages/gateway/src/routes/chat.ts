import { FastifyInstance } from 'fastify';
import { mwAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getEmbedding } from '../services/embedding.js';
import { searchChunks } from '../services/qdrant.js';
import { userCanRead } from '../services/mediawiki.js';
import { streamChatCompletion, callLiteLLM } from '../services/litellm.js';
import { getChatHistory, appendChatMessage } from '../services/redis.js';
import { getRuntimeConfig } from '../services/config.js';
import { ChatRequest } from '../types/index.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatRequest }>(
    '/api/chat',
    {
      preHandler: [
        mwAuthMiddleware,
        app.rateLimit({ max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.ip }),
      ],
    },
    async (request, reply) => {
      const { message, conversationId } = request.body;
      const stream = (request.body as any).stream ?? true;
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      const cookie = (request as AuthenticatedRequest).sessionCookie;

      if (!message || message.trim().length === 0) {
        reply.status(400).send({ error: 'Message is required' });
        return;
      }

      const convId = conversationId ?? `${mwUser.userId}-${Date.now()}`;
      const runtime = await getRuntimeConfig();

      const fullHistory = await getChatHistory(cookie.slice(0, 32), convId);
      const history = fullHistory.slice(-4);

      const embedding = await getEmbedding(message);
      const rawChunks = await searchChunks(embedding, mwUser.groups, runtime.topK);

      const verifiedChunks: typeof rawChunks = [];
      for (const chunk of rawChunks) {
        if (chunk.allowedGroups.includes('*')) {
          verifiedChunks.push(chunk);
          continue;
        }
        const hasGroup = chunk.allowedGroups.some((g) => mwUser.groups.includes(g));
        if (!hasGroup) continue;
        if (chunk.namespace !== 0 || chunk.allowedGroups.length > 1) {
          const canRead = await userCanRead(cookie, chunk.title);
          if (canRead) verifiedChunks.push(chunk);
        } else {
          verifiedChunks.push(chunk);
        }
        if (verifiedChunks.length >= runtime.topK) break;
      }

      const sources = verifiedChunks.map((c) => ({
        pageId: c.pageId,
        title: c.title,
        namespace: c.namespace,
      }));

      await appendChatMessage(cookie.slice(0, 32), convId, { role: 'user', content: message }, 3600);

      const contextText = verifiedChunks
        .map((c, i) => `[${i + 1}] ${c.title}:\n${c.text}`)
        .join('\n\n');

      const messages = [
        { role: 'system', content: runtime.systemPrompt },
        ...(contextText ? [{ role: 'system', content: `Documents for answer:\n${contextText}` }] : []),
        ...history,
        { role: 'user', content: message },
      ];

      if (!stream) {
        try {
          const response = await callLiteLLM(messages as any, runtime.litellmModel, runtime.timeoutMs);
          const content = response.choices[0]?.message?.content ?? '';
          if (content) {
            await appendChatMessage(cookie.slice(0, 32), convId, { role: 'assistant', content }, 3600);
          }
          reply.send({
            message: content,
            sources: runtime.showSources ? sources : undefined,
          });
          return;
        } catch (err) {
          console.error('Chat non-streaming error:', err);
          reply.send({
            llmAvailable: false,
            message: 'AI model temporarily unavailable. Here are the found documents:',
            sources,
          });
          return;
        }
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let fullResponse = '';

      try {
        for await (const chunk of streamChatCompletion(messages as any, runtime.litellmModel, runtime.timeoutMs)) {
          const content = chunk.choices[0]?.delta?.content ?? '';
          if (content) {
            fullResponse += content;
            const payload = JSON.stringify({ type: 'token', content });
            reply.raw.write(`data: ${payload}\n\n`);
          }
        }

        if (runtime.showSources) {
          const payload = JSON.stringify({ type: 'sources', sources });
          reply.raw.write(`data: ${payload}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
      } catch (err) {
        console.error('Chat stream error:', err);
        const errorMsg = 'AI model temporarily unavailable. Here are the found documents:';
        const payload1 = JSON.stringify({ type: 'token', content: errorMsg });
        reply.raw.write(`data: ${payload1}\n\n`);
        const payload2 = JSON.stringify({ type: 'token', content: '\n\n' });
        reply.raw.write(`data: ${payload2}\n\n`);

        for (const src of sources) {
          const line = `• ${src.title}\n`;
          const payload = JSON.stringify({ type: 'token', content: line });
          reply.raw.write(`data: ${payload}\n\n`);
        }

        if (runtime.showSources) {
          const payload = JSON.stringify({ type: 'sources', sources });
          reply.raw.write(`data: ${payload}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
      } finally {
        reply.raw.end();
        if (fullResponse) {
          await appendChatMessage(cookie.slice(0, 32), convId, { role: 'assistant', content: fullResponse }, 3600);
        }
      }
    }
  );
}
