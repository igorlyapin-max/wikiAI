import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANONYMOUS_MW_USER,
  AuthenticatedRequest,
  mwAuthMiddleware,
  mwOptionalAuthMiddleware,
} from '../auth.js';

const cachedGroups = vi.hoisted(() => ({ value: null as string[] | null }));
const fetchUserInfo = vi.hoisted(() => vi.fn());
const getCachedUserGroups = vi.hoisted(() => vi.fn(async () => cachedGroups.value));
const cacheUserGroups = vi.hoisted(() => vi.fn());

vi.mock('../../services/mediawiki.js', () => ({
  fetchUserInfo,
}));

vi.mock('../../services/redis.js', () => ({
  getCachedUserGroups,
  cacheUserGroups,
}));

describe('MediaWiki auth middleware', () => {
  beforeEach(() => {
    cachedGroups.value = null;
    fetchUserInfo.mockReset();
    getCachedUserGroups.mockClear();
    cacheUserGroups.mockClear();
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

  it('uses cached groups for required auth without calling MediaWiki', async () => {
    cachedGroups.value = ['cached-group'];
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
        username: 'cached',
        userId: 0,
        groups: ['cached-group'],
      },
    });
    expect(fetchUserInfo).not.toHaveBeenCalled();
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
    expect(cacheUserGroups).toHaveBeenCalledWith(expect.any(String), ['user', 'ai-it'], 60);
    await app.close();
  });

  it('assigns anonymous or cached principals in optional auth', async () => {
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
    expect(cached.json().user).toMatchObject({ username: 'cached', groups: ['cached-group'] });
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
    expect(cacheUserGroups).not.toHaveBeenCalled();
    await app.close();
  });
});
