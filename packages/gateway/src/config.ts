import { AppConfig } from './types/index.js';

function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: AppConfig = {
  mwBaseUrl: env('MW_BASE_URL', 'http://localhost:8082'),
  mwApiPath: env('MW_API_PATH', '/api.php'),
  litellmBaseUrl: env('LITELLM_BASE_URL'),
  litellmApiKey: env('LITELLM_API_KEY'),
  litellmModel: env('LITELLM_MODEL', 'mistral-7b-instruct'),
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  ollamaEmbeddingModel: env('OLLAMA_EMBEDDING_MODEL', 'nomic-embed-text'),
  qdrantUrl: env('QDRANT_URL', 'http://localhost:6333'),
  qdrantCollection: env('QDRANT_COLLECTION', 'wiki_chunks'),
  redisUrl: env('REDIS_URL', 'redis://localhost:16379/0'),
  gatewayPort: parseInt(env('GATEWAY_PORT', '3000'), 10),
  nodeEnv: env('NODE_ENV', 'development'),
  userGroupsCacheTtl: parseInt(env('USER_GROUPS_CACHE_TTL', '300'), 10),
};
