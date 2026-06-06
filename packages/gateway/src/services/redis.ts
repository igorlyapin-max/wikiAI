import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../config.js';
import type { MWUserInfo } from '../types/index.js';
import { logOperationalError } from './logging.js';

type SetMode = ['EX', number, 'NX'];

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: SetMode | []): Promise<'OK' | null>;
  setex(key: string, ttl: number, value: string): Promise<string>;
  scan(cursor: string, mode: 'MATCH', pattern: string, countMode: 'COUNT', count: number): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  on(event: string, handler: (err: Error) => void): RedisLike;
}

interface MemoryValue {
  value: string;
  expiresAt?: number;
}

function matchesRedisPattern(key: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(key);
}

function createMemoryRedis(): RedisLike {
  const data = new Map<string, MemoryValue>();

  function read(key: string): MemoryValue | undefined {
    const entry = data.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      return read(key)?.value ?? null;
    },
    async set(key, value, ...args: SetMode | []) {
      if (args[2] === 'NX' && read(key)) return null;
      const expiresAt = args.length === 3 && args[0] === 'EX'
        ? Date.now() + args[1] * 1000
        : undefined;
      data.set(key, {
        value,
        expiresAt,
      });
      return 'OK';
    },
    async setex(key, ttl, value) {
      data.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return 'OK';
    },
    async scan(cursor, _mode, pattern, _countMode, _count) {
      if (cursor !== '0') return ['0', []];
      return ['0', [...data.keys()].filter((key) => read(key) && matchesRedisPattern(key, pattern))];
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
  }) as unknown as RedisLike;
}

export const redis = createRedisClient();

redis.on('error', (err) => {
  logOperationalError('redis.connection_error', err);
});

export interface RedisLock {
  key: string;
  owner: string;
  release: () => Promise<void>;
}

export async function acquireRedisLock(key: string, ttlSeconds: number): Promise<RedisLock | null> {
  const owner = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const acquired = await redis.set(key, owner, 'EX', ttlSeconds, 'NX');
  if (acquired !== 'OK') return null;

  return {
    key,
    owner,
    release: async () => {
      const current = await redis.get(key);
      if (current === owner) await redis.del(key);
    },
  };
}

export async function readJson<T>(key: string): Promise<T | undefined> {
  const value = await redis.get(key);
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

export async function writeJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

function normalizeCachedUserInfo(value: unknown): MWUserInfo | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MWUserInfo>;
  if (typeof candidate.username !== 'string' || candidate.username.trim().length === 0) return null;
  if (typeof candidate.userId !== 'number' || !Number.isInteger(candidate.userId) || candidate.userId < 0) return null;
  if (!Array.isArray(candidate.groups) || !candidate.groups.every((group) => typeof group === 'string')) return null;
  if (candidate.rights !== undefined && (!Array.isArray(candidate.rights) || !candidate.rights.every((right) => typeof right === 'string'))) return null;

  return {
    username: candidate.username,
    userId: candidate.userId,
    groups: candidate.groups,
    rights: candidate.rights,
  };
}

export async function getCachedUserInfo(sessionId: string): Promise<MWUserInfo | null> {
  const cached = await readJson<unknown>(`mw:user:${sessionId}`);
  return normalizeCachedUserInfo(cached);
}

export async function cacheUserInfo(sessionId: string, userInfo: MWUserInfo, ttl: number): Promise<void> {
  await writeJson(`mw:user:${sessionId}`, userInfo, ttl);
}

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
  const patterns = ['mw:groups:*', 'mw:user:*'];
  let deleted = 0;

  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

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
