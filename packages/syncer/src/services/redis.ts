import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { config } from '../config.js';
import { logOperationalError } from './logging.js';

type SetMode = ['EX', number, 'NX'];

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: SetMode | []): Promise<'OK' | null>;
  setex(key: string, ttl: number, value: string): Promise<'OK'>;
  del(...keys: string[]): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  on(event: string, handler: (err: Error) => void): RedisLike;
}

interface MemoryValue {
  value: string;
  expiresAt?: number;
}

function isExpired(entry: MemoryValue | undefined): boolean {
  return Boolean(entry?.expiresAt && entry.expiresAt <= Date.now());
}

function createMemoryRedis(): RedisLike {
  const data = new Map<string, MemoryValue>();

  function read(key: string): MemoryValue | undefined {
    const entry = data.get(key);
    if (isExpired(entry)) {
      data.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      return read(key)?.value ?? null;
    },
    async set(key: string, value: string, ...args: SetMode | []) {
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

export interface RedisLock {
  key: string;
  owner: string;
  release: () => Promise<void>;
}

export const redis = createRedisClient();

redis.on('error', (err) => {
  logOperationalError('redis.connection_error', err);
});

export async function rememberOnce(key: string, ttlSeconds: number): Promise<boolean> {
  return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
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
