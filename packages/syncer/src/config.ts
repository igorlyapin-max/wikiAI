function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) throw new Error(`Missing env: ${name}`);
  return value;
}

export const config = {
  mwBaseUrl: env('MW_BASE_URL', 'http://localhost:8082'),
  mwApiPath: env('MW_API_PATH', '/api.php'),
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaEmbeddingModel: env('OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text'),
  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),
  qdrantCollection: env('QDRANT_COLLECTION', 'wiki_chunks'),
  syncerPort: parseInt(env('SYNCER_PORT', '3001'), 10),
  chunkSize: parseInt(env('CHUNK_SIZE', '512'), 10),
  chunkOverlap: parseInt(env('CHUNK_OVERLAP', '50'), 10),
  // Namespace ID → allowed_groups mapping
  namespaceAcl: JSON.parse(env('NAMESPACE_ACL', '{"0":["*"]}')) as Record<number, string[]>,
};
