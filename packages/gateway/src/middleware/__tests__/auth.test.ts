import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANONYMOUS_MW_USER,
  AuthenticatedRequest,
  mwAuthMiddleware,
  mwOptionalAuthMiddleware,
} from '../auth.js';
import type { MWUserInfo } from '../../types/index.js';

const cachedGroups = vi.hoisted(() => ({ value: null as string[] | null }));
const cachedUser = vi.hoisted(() => ({ value: null as MWUserInfo | null }));
const fetchUserInfo = vi.hoisted(() => vi.fn());
const getCachedUserGroups = vi.hoisted(() => vi.fn(async () => cachedGroups.value));
const getCachedUserInfo = vi.hoisted(() => vi.fn(async () => cachedUser.value));
const cacheUserInfo = vi.hoisted(() => vi.fn());

vi.mock('../../services/mediawiki.js', () => ({
  fetchUserInfo,
}));

vi.mock('../../services/redis.js', () => ({
  getCachedUserGroups,
  getCachedUserInfo,
  cacheUserInfo,
}));

describe('MediaWiki auth middleware', () => {
  beforeEach(() => {
    cachedGroups.value = null;
    cachedUser.value = null;
    fetchUserInfo.mockReset();
    getCachedUserGroups.mockClear();
    getCachedUserInfo.mockClear();
    cacheUserInfo.mockClear();
    fetchUserInfo.mockResolvedValue({
      username: 'WikiUser',
      userId: 42,
      groups: ['user', 'ai-it'],
    });
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = Fastify();
    app.get('/required', { preHandler: mwAuthMiddleware }, async (request) => {
      const auth = request as AuthenticatedRequest;
      return {
        sessionCookie: auth.sessionCookie,
        user: auth.mwUser,
      };
    });
    app.get('/optional', { preHandler: mwOptionalAuthMiddleware }, async (request) => {
      const auth = request as AuthenticatedRequest;
      return {
        sessionCookie: auth.sessionCookie,
        user: auth.mwUser,
      };
    });
    return app;
  }

  it('rejects required auth without cookies', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/required' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Missing session cookie' });
    expect(fetchUserInfo).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses cached user info for required auth without calling MediaWiki', async () => {
    cachedUser.value = {
      username: 'CachedWikiUser',
      userId: 43,
      groups: ['cached-group'],
      rights: ['read'],
    };
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/required',
      headers: { cookie: 'mw=1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionCookie: 'mw=1',
      user: {
        username: 'CachedWikiUser',
        userId: 43,
        groups: ['cached-group'],
        rights: ['read'],
      },
    });
    expect(fetchUserInfo).not.toHaveBeenCalled();
    await app.close();
  });

  it('refreshes legacy group-only cache instead of returning cached as a user', async () => {
    cachedGroups.value = ['legacy-group'];
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/required',
      headers: { cookie: 'mw=legacy' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({
      username: 'WikiUser',
      userId: 42,
      groups: ['user', 'ai-it'],
    });
    expect(fetchUserInfo).toHaveBeenCalledTimes(1);
    expect(cacheUserInfo).toHaveBeenCalledWith(expect.any(String), {
      username: 'WikiUser',
      userId: 42,
      groups: ['user', 'ai-it'],
    }, 60);
    await app.close();
  });

  it('rejects invalid required sessions and caches valid MediaWiki users', async () => {
    fetchUserInfo.mockResolvedValueOnce(null);
    const app = await makeApp();
    const invalid = await app.inject({
      method: 'GET',
      url: '/required',
      headers: { cookie: 'mw=expired' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ error: 'Invalid or expired MediaWiki session' });

    fetchUserInfo.mockResolvedValueOnce({
      username: 'WikiUser',
      userId: 42,
      groups: ['user', 'ai-it'],
    });
    const valid = await app.inject({
      method: 'GET',
      url: '/required',
      headers: { cookie: 'mw=valid' },
    });

    expect(valid.statusCode).toBe(200);
    expect(valid.json().user).toMatchObject({ username: 'WikiUser', groups: ['user', 'ai-it'] });
    expect(cacheUserInfo).toHaveBeenCalledWith(expect.any(String), {
      username: 'WikiUser',
      userId: 42,
      groups: ['user', 'ai-it'],
    }, 60);
    await app.close();
  });

  it('assigns anonymous or refreshed principals in optional auth', async () => {
    const app = await makeApp();
    const anonymous = await app.inject({ method: 'GET', url: '/optional' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toMatchObject({
      sessionCookie: '',
      user: ANONYMOUS_MW_USER,
    });

    cachedGroups.value = ['cached-group'];
    const cached = await app.inject({
      method: 'GET',
      url: '/optional',
      headers: { cookie: 'mw=cached' },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().user).toMatchObject({ username: 'WikiUser', userId: 42, groups: ['user', 'ai-it'] });
    await app.close();
  });

  it('falls back to anonymous for invalid optional MediaWiki sessions', async () => {
    fetchUserInfo.mockResolvedValueOnce(null);
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/optional',
      headers: { cookie: 'mw=expired' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toEqual(ANONYMOUS_MW_USER);
    expect(cacheUserInfo).not.toHaveBeenCalled();
    await app.close();
  });
});
