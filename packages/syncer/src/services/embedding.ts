import { config } from '../config.js';

export async function getEmbedding(text: string): Promise<number[]> {
  const url = `${config.ollamaBaseUrl}/api/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollamaEmbeddingModel, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}
