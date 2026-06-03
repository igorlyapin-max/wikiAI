import { buildServiceUrl, getEffectiveEmbeddingConfig } from './admin-platform-config.js';

export async function getEmbedding(text: string): Promise<number[]> {
  const embeddingConfig = await getEffectiveEmbeddingConfig();
  const isOpenAiCompatible = embeddingConfig.provider === 'openai_compatible';
  const url = buildServiceUrl(embeddingConfig.baseUrl, isOpenAiCompatible ? 'embeddings' : 'api/embeddings');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isOpenAiCompatible && embeddingConfig.apiKey) {
    headers.Authorization = `Bearer ${embeddingConfig.apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
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
