export interface AppConfig {
  mwBaseUrl: string;
  mwApiPath: string;
  litellmBaseUrl: string;
  litellmApiKey: string;
  litellmModel: string;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  qdrantUrl: string;
  qdrantCollection: string;
  redisUrl: string;
  gatewayPort: number;
  nodeEnv: string;
  userGroupsCacheTtl: number;
}

export interface MWUserInfo {
  username: string;
  userId: number;
  groups: string[];
}

export interface SearchChunk {
  id: number;
  pageId: number;
  title: string;
  text: string;
  namespace: number;
  allowedGroups: string[];
  score: number;
}

export interface SearchRequest {
  query: string;
  topK?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
}
