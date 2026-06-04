import Redis from 'ioredis';
import { config } from '../config.js';
import { logOperationalError } from './logging.js';

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string>;
  setex(key: string, ttl: number, value: string): Promise<string>;
  scan(cursor: string, mode: 'MATCH', pattern: string, countMode: 'COUNT', count: number): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  on(event: string, handler: (err: Error) => void): RedisLike;
}

function matchesRedisPattern(key: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(key);
}

function createMemoryRedis(): RedisLike {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
      return 'OK';
    },
    async setex(key, _ttl, value) {
      data.set(key, value);
      return 'OK';
    },
    async scan(cursor, _mode, pattern, _countMode, _count) {
      if (cursor !== '0') return ['0', []];
      return ['0', [...data.keys()].filter((key) => matchesRedisPattern(key, pattern))];
    },
    async del(...keys) {
      let deleted = 0;
      for (const key of keys) {
        if (data.delete(key)) deleted++;
      }
      return deleted;
    },
    async ping() {
      return 'PONG';
    },
    async quit() {
      data.clear();
      return 'OK';
    },
    on() {
      return this;
    },
  };
}

function createRedisClient(): RedisLike {
  if (config.nodeEnv === 'test' && config.redisUrl === 'memory://test') {
    return createMemoryRedis();
  }

  return new Redis(config.redisUrl, {
    retryStrategy: (times) => {
      if (times > 5) return null;
      return Math.min(times * 100, 3000);
    },
    maxRetriesPerRequest: 3,
  });
}

export const redis = createRedisClient();

redis.on('error', (err) => {
  logOperationalError('redis.connection_error', err);
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
