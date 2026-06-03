import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redisUrl, {
  retryStrategy: (times) => {
    if (times > 5) return null;
    return Math.min(times * 100, 3000);
  },
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

export async function getCachedUserGroups(sessionId: string): Promise<string[] | null> {
  const key = `mw:groups:${sessionId}`;
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : null;
}

export async function cacheUserGroups(sessionId: string, groups: string[], ttl: number): Promise<void> {
  const key = `mw:groups:${sessionId}`;
  await redis.setex(key, ttl, JSON.stringify(groups));
}

export async function clearUserGroupCache(): Promise<number> {
  let cursor = '0';
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'mw:groups:*', 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');

  return deleted;
}

export async function getChatHistory(sessionId: string, conversationId: string): Promise<{ role: string; content: string }[]> {
  const key = `chat:${sessionId}:${conversationId}`;
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : [];
}

export async function appendChatMessage(
  sessionId: string,
  conversationId: string,
  message: { role: string; content: string },
  ttl: number
): Promise<void> {
  const key = `chat:${sessionId}:${conversationId}`;
  const history = await getChatHistory(sessionId, conversationId);
  history.push(message);
  await redis.setex(key, ttl, JSON.stringify(history));
}
