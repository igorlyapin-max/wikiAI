import { redis } from './redis.js';

const CONFIG_KEY = 'ai:gateway:settings';

export interface RuntimeConfig {
  litellmModel: string;
  temperature: number;
  maxTokens: number;
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
  showSources: boolean;
  systemPrompt: string;
  timeoutMs: number;
}

const DEFAULTS: RuntimeConfig = {
  litellmModel: process.env.LITELLM_MODEL ?? 'mistral-7b-instruct',
  temperature: 0.3,
  maxTokens: 1024,
  topK: 4,
  chunkSize: 512,
  chunkOverlap: 50,
  showSources: true,
  systemPrompt: 'Ты — корпоративный помощник по внутренней вики. Отвечай только на основе предоставленных документов. Если ответа нет — честно скажи об этом. Приводи ссылки на источники. Отвечай на том же языке, что и вопрос пользователя.',
  timeoutMs: 30000,
};

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const raw = await redis.get(CONFIG_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setRuntimeConfig(partial: Partial<RuntimeConfig>): Promise<void> {
  const current = await getRuntimeConfig();
  const updated = { ...current, ...partial };
  await redis.set(CONFIG_KEY, JSON.stringify(updated));
}

export async function resetRuntimeConfig(): Promise<void> {
  await redis.set(CONFIG_KEY, JSON.stringify(DEFAULTS));
}
