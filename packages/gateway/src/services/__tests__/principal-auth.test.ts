import { describe, expect, it } from 'vitest';
import {
  anonymousPrincipal,
  authenticateOidcBearerToken,
  principalFromMwUser,
  principalSessionHash,
} from '../principal-auth.js';
import type { ExternalApiConfig } from '../external-api-config.js';

function oidcConfig(patch: Partial<ExternalApiConfig['oidc']> = {}): ExternalApiConfig {
  return {
    enabled: true,
    mcpEnabled: true,
    anonymousSearchAllowed: false,
    maxTopK: 10,
    aclMode: 'mediawiki_check',
    oidc: {
      issuer: 'https://issuer.example',
      audience: 'wikiai',
      jwksUrl: 'https://issuer.example/jwks.json',
      subjectClaim: 'sub',
      usernameClaim: 'preferred_username',
      groupsClaim: 'groups',
      ...patch,
    },
  };
}

function unsignedToken(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }): string {
  return [
    Buffer.from(JSON.stringify(header)).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    Buffer.from('signature').toString('base64url'),
  ].join('.');
}

describe('principal auth helpers', () => {
  it('builds anonymous and MediaWiki principals without losing group defaults', () => {
    expect(anonymousPrincipal()).toEqual({
      authMode: 'anonymous',
      username: 'anonymous',
      userId: 0,
      groups: ['*'],
    });
    expect(principalFromMwUser({ username: 'Admin', userId: 42, groups: [] }, 'mw=1')).toMatchObject({
      authMode: 'mediawiki_cookie',
      username: 'Admin',
      userId: 42,
      groups: ['*'],
      sessionCookie: 'mw=1',
    });
  });

  it('derives stable session hashes by authentication mode', () => {
    expect(principalSessionHash(anonymousPrincipal())).toBe('anonymous');
    const longCookie = 'mw_session=1234567890123456789012345678901234567890';
    expect(principalSessionHash(principalFromMwUser({
      username: 'Admin',
      userId: 42,
      groups: ['sysop'],
    }, longCookie))).toBe(longCookie.slice(0, 32));
    expect(principalSessionHash({
      authMode: 'oidc',
      username: 'oidc-user',
      userId: 1000000001,
      groups: ['aiadmin'],
      subject: 'subject-1',
    })).toMatch(/^oidc:[A-Za-z0-9_-]{27}$/);
  });

  it('rejects OIDC auth when the external config is incomplete', async () => {
    const config = oidcConfig({ jwksUrl: '' });
    await expect(authenticateOidcBearerToken('a.b.c', config)).rejects.toThrow('OIDC is not configured');
  });

  it('rejects malformed and expired bearer JWTs before JWKS lookup', async () => {
    await expect(authenticateOidcBearerToken('not-a-jwt', oidcConfig())).rejects.toThrow('Bearer token is not a JWT');

    const expired = unsignedToken({
      iss: 'https://issuer.example',
      aud: 'wikiai',
      exp: Math.floor(Date.now() / 1000) - 60,
      sub: 'user-1',
    });
    await expect(authenticateOidcBearerToken(expired, oidcConfig())).rejects.toThrow('OIDC token is expired');
  });

  it('rejects OIDC issuer and audience mismatches before signature verification', async () => {
    const validFuture = Math.floor(Date.now() / 1000) + 3600;
    await expect(authenticateOidcBearerToken(unsignedToken({
      iss: 'https://other.example',
      aud: 'wikiai',
      exp: validFuture,
      sub: 'user-1',
    }), oidcConfig())).rejects.toThrow('OIDC issuer does not match configured issuer');

    await expect(authenticateOidcBearerToken(unsignedToken({
      iss: 'https://issuer.example',
      aud: 'other',
      exp: validFuture,
      sub: 'user-1',
    }), oidcConfig())).rejects.toThrow('OIDC audience does not match configured audience');
  });
});
