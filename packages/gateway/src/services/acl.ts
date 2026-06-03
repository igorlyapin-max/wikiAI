import { AuthenticatedPrincipal, SearchChunk } from '../types/index.js';
import { userCanRead, userCanReadWithBearer } from './mediawiki.js';

export type CanReadPage = (sessionCookie: string | undefined, pageTitle: string) => Promise<boolean>;
export type PrincipalAclMode = 'mediawiki_check' | 'groups_only';
export type CanReadPrincipalPage = (principal: AuthenticatedPrincipal, pageTitle: string) => Promise<boolean>;

export async function filterReadableChunks(
  chunks: SearchChunk[],
  sessionCookie: string | undefined,
  limit: number,
  canReadPage: CanReadPage = userCanRead
): Promise<SearchChunk[]> {
  const results: SearchChunk[] = [];
  const readableByTitle = new Map<string, boolean>();

  for (const chunk of chunks) {
    if (!chunk.title) continue;

    let readable = readableByTitle.get(chunk.title);
    if (readable === undefined) {
      readable = await canReadPage(sessionCookie, chunk.title);
      readableByTitle.set(chunk.title, readable);
    }

    if (readable) {
      results.push(chunk);
    }

    if (results.length >= limit) break;
  }

  return results;
}

function chunkAllowedByGroups(chunk: SearchChunk, groups: string[]): boolean {
  if (chunk.allowedGroups.includes('*')) return true;
  const userGroups = new Set(groups);
  return chunk.allowedGroups.some((group) => userGroups.has(group));
}

async function principalCanReadPage(principal: AuthenticatedPrincipal, pageTitle: string): Promise<boolean> {
  if (principal.authMode === 'oidc') {
    return userCanReadWithBearer(principal.bearerToken, pageTitle);
  }
  return userCanRead(principal.sessionCookie, pageTitle);
}

export async function filterReadableChunksForPrincipal(
  chunks: SearchChunk[],
  principal: AuthenticatedPrincipal,
  limit: number,
  aclMode: PrincipalAclMode = 'mediawiki_check',
  canReadPage: CanReadPrincipalPage = principalCanReadPage
): Promise<SearchChunk[]> {
  if (aclMode === 'groups_only') {
    return chunks
      .filter((chunk) => chunk.title && chunkAllowedByGroups(chunk, principal.groups))
      .slice(0, limit);
  }

  const results: SearchChunk[] = [];
  const readableByTitle = new Map<string, boolean>();

  for (const chunk of chunks) {
    if (!chunk.title) continue;

    let readable = readableByTitle.get(chunk.title);
    if (readable === undefined) {
      readable = await canReadPage(principal, chunk.title);
      readableByTitle.set(chunk.title, readable);
    }

    if (readable) {
      results.push(chunk);
    }

    if (results.length >= limit) break;
  }

  return results;
}
