import { buildServiceUrl, getEffectiveEmbeddingConfig } from './admin-platform-config.js';
import { config } from '../config.js';
import { measureDependency } from './metrics.js';
import { currentTraceHeaders } from './tracing.js';

async function fetchEmbeddingWithTimeout(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.embeddingTimeoutMs);
    try {
      return await measureDependency(
        { dependency: 'embedding', operation: 'embed' },
        async () => fetch(url, { ...init, signal: controller.signal })
      );
    } catch (err) {
      lastError = err instanceof Error && err.name === 'AbortError'
        ? new Error(`Embedding provider request timed out after ${config.embeddingTimeoutMs}ms`)
        : err;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const embeddingConfig = await getEffectiveEmbeddingConfig();
  const isOpenAiCompatible = embeddingConfig.provider === 'openai_compatible';
  const url = buildServiceUrl(embeddingConfig.baseUrl, isOpenAiCompatible ? 'embeddings' : 'api/embeddings');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isOpenAiCompatible && embeddingConfig.apiKey) {
    headers.Authorization = `Bearer ${embeddingConfig.apiKey}`;
  }

  const res = await fetchEmbeddingWithTimeout(url, {
    method: 'POST',
    headers: { ...headers, ...currentTraceHeaders() },
    body: JSON.stringify(isOpenAiCompatible
      ? { model: embeddingConfig.model, input: text, dimensions: embeddingConfig.dimensions }
      : { model: embeddingConfig.model, prompt: text }),
  });

  if (!res.ok) {
    throw new Error(`Embedding provider error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as {
    embedding?: unknown;
    data?: Array<{ embedding?: unknown }>;
  };
  const embedding = isOpenAiCompatible ? data.data?.[0]?.embedding : data.embedding;
  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
    throw new Error('Embedding provider response does not contain numeric vector');
  }
  return embedding;
}
