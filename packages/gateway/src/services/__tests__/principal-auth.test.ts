import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function createJwtSigner(kid = 'k1'): Promise<{
  jwk: Record<string, unknown>;
  signToken: (payload: Record<string, unknown>, header?: Record<string, unknown>) => Promise<string>;
}> {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  if (!('privateKey' in keyPair)) {
    throw new Error('RSA key pair was not generated');
  }

  const exportedJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey) as Record<string, unknown>;
  const jwk = {
    ...exportedJwk,
    kid,
    alg: 'RS256',
    use: 'sig',
  };

  return {
    jwk,
    signToken: async (
      payload: Record<string, unknown>,
      header: Record<string, unknown> = { alg: 'RS256', kid }
    ) => {
      const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = await webcrypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keyPair.privateKey,
        Buffer.from(signingInput, 'utf8')
      );
      return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('authenticates signed RS256 OIDC tokens and maps string group claims', async () => {
    const { jwk, signToken } = await createJwtSigner('happy-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));

    const principal = await authenticateOidcBearerToken(await signToken({
      iss: 'https://issuer.example',
      aud: ['other-audience', 'wikiai'],
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'subject-123',
      preferred_username: 'oidc-admin',
      groups: 'aiadmin sysop',
    }), oidcConfig({ jwksUrl: 'https://issuer.example/jwks-happy.json' }));

    expect(principal).toMatchObject({
      authMode: 'oidc',
      username: 'oidc-admin',
      groups: ['aiadmin', 'sysop'],
      subject: 'subject-123',
    });
    expect(principal.userId).toBeGreaterThanOrEqual(1_000_000_000);
  });

  it('rejects valid OIDC signatures when the subject claim is missing', async () => {
    const { jwk, signToken } = await createJwtSigner('missing-sub-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));

    await expect(authenticateOidcBearerToken(await signToken({
      iss: 'https://issuer.example',
      aud: 'wikiai',
      exp: Math.floor(Date.now() / 1000) + 3600,
      preferred_username: 'oidc-admin',
    }), oidcConfig({ jwksUrl: 'https://issuer.example/jwks-missing-sub.json' })))
      .rejects.toThrow('OIDC subject claim is missing');
  });

  it('rejects unsupported algorithms, unavailable JWKS, missing keys, and future nbf claims', async () => {
    const validFuture = Math.floor(Date.now() / 1000) + 3600;
    await expect(authenticateOidcBearerToken(unsignedToken({
      iss: 'https://issuer.example',
      aud: 'wikiai',
      exp: validFuture,
      sub: 'user-1',
    }, { alg: 'HS256', kid: 'k1' }), oidcConfig()))
      .rejects.toThrow('Only RS256 OIDC tokens are supported');

    await expect(authenticateOidcBearerToken(unsignedToken({
      iss: 'https://issuer.example',
      aud: 'wikiai',
      exp: validFuture,
      nbf: validFuture,
      sub: 'user-1',
    }), oidcConfig()))
      .rejects.toThrow('OIDC token is not valid yet');

    const { signToken } = await createJwtSigner('unavailable-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    })));
    await expect(authenticateOidcBearerToken(await signToken({
      iss: 'https://issuer.example',
      aud: 'wikiai',
      exp: validFuture,
      sub: 'user-1',
    }), oidcConfig({ jwksUrl: 'https://issuer.example/jwks-unavailable.json' })))
      .rejects.toThrow('JWKS fetch failed: 503 Service Unavailable');

    const signedWithUnknownKid = await signToken({
      iss: 'https://issuer.example',
      aud: 'wikiai',
      exp: validFuture,
      sub: 'user-1',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      keys: [{ kty: 'RSA', kid: 'other-key', alg: 'RS256', use: 'sig', n: 'n', e: 'AQAB' }],
    }), { status: 200 })));
    await expect(authenticateOidcBearerToken(
      signedWithUnknownKid,
      oidcConfig({ jwksUrl: 'https://issuer.example/jwks-missing-key.json' })
    )).rejects.toThrow('OIDC signing key was not found in JWKS');
  });
});
