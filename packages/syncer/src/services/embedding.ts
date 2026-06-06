import { config } from '../config.js';
import { fetchGatewayEmbedding } from './gateway.js';
import { logOperationalError } from './logging.js';
import { measureDependency } from './metrics.js';
import { currentTraceHeaders } from './tracing.js';

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.embeddingTimeoutMs);
    try {
      return await measureDependency(
        { dependency: 'ollama', operation: 'embed' },
        async () => fetch(url, { ...init, signal: controller.signal })
      );
    } catch (err) {
      lastError = err instanceof Error && err.name === 'AbortError'
        ? new Error(`Ollama embedding request timed out after ${config.embeddingTimeoutMs}ms`)
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
  try {
    const gatewayEmbedding = await fetchGatewayEmbedding(text);
    return gatewayEmbedding.vector;
  } catch (err) {
    logOperationalError('gateway.embedding_unavailable', err);
  }

  const url = `${config.ollamaBaseUrl}/api/embeddings`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...currentTraceHeaders() },
    body: JSON.stringify({ model: config.ollamaEmbeddingModel, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}
