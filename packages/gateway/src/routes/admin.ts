import { FastifyInstance } from 'fastify';
import { mwAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getRuntimeConfig, setRuntimeConfig, resetRuntimeConfig, RuntimeConfig } from '../services/config.js';

const HELP_TEXT: Record<keyof RuntimeConfig, { label: string; help: string; type: string; min?: number; max?: number }> = {
  litellmModel: {
    label: 'Модель LLM',
    help: 'Название модели в LiteLLM. Примеры: mistral-7b-instruct, gpt-4o, llama-3.1-8b. Изменение требует наличия модели в LiteLLM.',
    type: 'string',
  },
  temperature: {
    label: 'Температура',
    help: '0.1 = точные, консервативные ответы. 1.0 = креативные, разнообразные. Для корпоративной вики рекомендуется 0.2–0.4.',
    type: 'number',
    min: 0,
    max: 2,
  },
  maxTokens: {
    label: 'Макс. токенов в ответе',
    help: 'Максимальная длина ответа LLM. Больше = длиннее ответы, но дороже и дольше. Рекомендуется 512–1024.',
    type: 'number',
    min: 64,
    max: 4096,
  },
  topK: {
    label: 'Количество чанков в контексте (top-k)',
    help: 'Сколько фрагментов вики передавать LLM. Больше = точнее, но дороже (больше токенов в промпте). Рекомендуется 3–5.',
    type: 'number',
    min: 1,
    max: 10,
  },
  chunkSize: {
    label: 'Размер чанка (при переиндексации)',
    help: 'Размер фрагмента текста в токенах. Больше = меньше чанков, но контекст размывается. Меньше = точнее, но больше записей. Рекомендуется 384–768.',
    type: 'number',
    min: 128,
    max: 2048,
  },
  chunkOverlap: {
    label: 'Перекрытие чанков',
    help: 'Сколько токенов дублировать между соседними чанками. Предотвращает потерю смысла на границах. Рекомендуется 40–100.',
    type: 'number',
    min: 0,
    max: 512,
  },
  showSources: {
    label: 'Показывать источники в ответе',
    help: 'Если включено — в конце каждого ответа будет список страниц вики, на которых основан ответ. Рекомендуется включить.',
    type: 'boolean',
  },
  systemPrompt: {
    label: 'Системный промпт',
    help: 'Инструкция для LLM, которая подаётся в начале каждого диалога. Определяет стиль и ограничения ответов.',
    type: 'string',
  },
  timeoutMs: {
    label: 'Таймаут LLM (мс)',
    help: 'Сколько миллисекунд ждать ответа от LLM. Если превышен — вернётся ошибка или fallback. Рекомендуется 15000–60000.',
    type: 'number',
    min: 5000,
    max: 120000,
  },
};

function isAdmin(user: AuthenticatedRequest['mwUser']): boolean {
  return user?.groups?.includes('sysop') ?? false;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      if (!isAdmin(mwUser)) {
        reply.status(403).send({ error: 'Requires sysop group' });
        return;
      }

      const config = await getRuntimeConfig();
      reply.send({
        values: config,
        fields: HELP_TEXT,
        defaults: Object.fromEntries(
          Object.entries(HELP_TEXT).map(([k, v]) => [k, v.label])
        ),
      });
    }
  );

  app.post(
    '/api/admin/config',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      if (!isAdmin(mwUser)) {
        reply.status(403).send({ error: 'Requires sysop group' });
        return;
      }

      const body = request.body as Partial<RuntimeConfig>;
      await setRuntimeConfig(body);
      reply.send({ status: 'saved', config: await getRuntimeConfig() });
    }
  );

  app.post(
    '/api/admin/config/reset',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      if (!isAdmin(mwUser)) {
        reply.status(403).send({ error: 'Requires sysop group' });
        return;
      }

      await resetRuntimeConfig();
      reply.send({ status: 'reset', config: await getRuntimeConfig() });
    }
  );

  app.post(
    '/api/admin/cache/clear',
    { preHandler: mwAuthMiddleware },
    async (request, reply) => {
      const mwUser = (request as AuthenticatedRequest).mwUser!;
      if (!isAdmin(mwUser)) {
        reply.status(403).send({ error: 'Requires sysop group' });
        return;
      }

      const { redis } = await import('../services/redis.js');
      await redis.flushdb();
      reply.send({ status: 'cache_cleared' });
    }
  );
}
