import { FastifyRequest, FastifyReply } from 'fastify';
import { fetchUserInfo } from '../services/mediawiki.js';
import { getCachedUserGroups, cacheUserInfo, getCachedUserInfo } from '../services/redis.js';
import { logOperationalEvent } from '../services/logging.js';
import { config } from '../config.js';
import { MWUserInfo } from '../types/index.js';

export interface AuthenticatedRequest extends FastifyRequest {
  mwUser?: MWUserInfo;
  sessionCookie: string;
}

export const ANONYMOUS_MW_USER: MWUserInfo = {
  username: 'anonymous',
  userId: 0,
  groups: ['*'],
};

async function resolveMediaWikiUserFromCookie(cookie: string): Promise<MWUserInfo | null> {
  const sessionHash = Buffer.from(cookie).toString('base64url').slice(0, 32);
  const cachedUser = await getCachedUserInfo(sessionHash);
  if (cachedUser) return cachedUser;

  const legacyCachedGroups = await getCachedUserGroups(sessionHash);
  if (legacyCachedGroups) {
    logOperationalEvent('info', 'mediawiki.auth.legacy_group_cache_refresh', {
      groupsCount: legacyCachedGroups.length,
    });
  }

  const userInfo = await fetchUserInfo(cookie);
  if (!userInfo) return null;

  await cacheUserInfo(sessionHash, userInfo, config.userGroupsCacheTtl);
  return userInfo;
}

export async function mwAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const cookie = request.headers.cookie || '';
  if (!cookie) {
    reply.status(401).send({ error: 'Missing session cookie' });
    return;
  }

  (request as AuthenticatedRequest).sessionCookie = cookie;

  const userInfo = await resolveMediaWikiUserFromCookie(cookie);

  if (!userInfo) {
    reply.status(401).send({ error: 'Invalid or expired MediaWiki session' });
    return;
  }

  (request as AuthenticatedRequest).mwUser = userInfo;
}

export async function mwOptionalAuthMiddleware(request: FastifyRequest): Promise<void> {
  const cookie = request.headers.cookie || '';
  (request as AuthenticatedRequest).sessionCookie = cookie;

  if (!cookie) {
    (request as AuthenticatedRequest).mwUser = ANONYMOUS_MW_USER;
    return;
  }

  const userInfo = await resolveMediaWikiUserFromCookie(cookie);
  if (!userInfo) {
    (request as AuthenticatedRequest).mwUser = ANONYMOUS_MW_USER;
    return;
  }

  (request as AuthenticatedRequest).mwUser = userInfo;
}
