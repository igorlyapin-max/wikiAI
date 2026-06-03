import { FastifyRequest, FastifyReply } from 'fastify';
import { fetchUserInfo } from '../services/mediawiki.js';
import { getCachedUserGroups, cacheUserGroups } from '../services/redis.js';
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

  const sessionHash = Buffer.from(cookie).toString('base64url').slice(0, 32);
  const cached = await getCachedUserGroups(sessionHash);

  if (cached) {
    (request as AuthenticatedRequest).mwUser = {
      username: 'cached',
      userId: 0,
      groups: cached,
    };
    return;
  }

  const userInfo = await fetchUserInfo(cookie);

  if (!userInfo) {
    reply.status(401).send({ error: 'Invalid or expired MediaWiki session' });
    return;
  }

  await cacheUserGroups(sessionHash, userInfo.groups, config.userGroupsCacheTtl);

  (request as AuthenticatedRequest).mwUser = userInfo;
}

export async function mwOptionalAuthMiddleware(request: FastifyRequest): Promise<void> {
  const cookie = request.headers.cookie || '';
  (request as AuthenticatedRequest).sessionCookie = cookie;

  if (!cookie) {
    (request as AuthenticatedRequest).mwUser = ANONYMOUS_MW_USER;
    return;
  }

  const sessionHash = Buffer.from(cookie).toString('base64url').slice(0, 32);
  const cached = await getCachedUserGroups(sessionHash);

  if (cached) {
    (request as AuthenticatedRequest).mwUser = {
      username: 'cached',
      userId: 0,
      groups: cached,
    };
    return;
  }

  const userInfo = await fetchUserInfo(cookie);
  if (!userInfo) {
    (request as AuthenticatedRequest).mwUser = ANONYMOUS_MW_USER;
    return;
  }

  await cacheUserGroups(sessionHash, userInfo.groups, config.userGroupsCacheTtl);
  (request as AuthenticatedRequest).mwUser = userInfo;
}
