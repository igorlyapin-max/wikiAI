import { createHash, webcrypto } from 'node:crypto';
import { config as appConfig } from '../config.js';
import { AuthenticatedPrincipal, MWUserInfo } from '../types/index.js';
import { ExternalApiConfig } from './external-api-config.js';

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const OIDC_USER_ID_BASE = 1_000_000_000;
const OIDC_USER_ID_RANGE = 1_000_000_000;

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  [claim: string]: unknown;
}

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [field: string]: unknown;
}

type JsonWebKey = Jwk;

interface JwksDocument {
  keys?: Jwk[];
}

interface CachedJwks {
  expiresAt: number;
  keys: Jwk[];
}

const jwksCache = new Map<string, CachedJwks>();

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function parseJwtPart<T>(value: string, label: string): T {
  try {
    return JSON.parse(base64UrlDecode(value).toString('utf8')) as T;
  } catch {
    throw new Error(`Invalid JWT ${label}`);
  }
}

function readStringClaim(payload: JwtPayload, claimName: string): string | undefined {
  const value = payload[claimName];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readGroupsClaim(payload: JwtPayload, claimName: string): string[] {
  const value = payload[claimName];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function mapOidcGroups(rawGroups: string[], configValue: ExternalApiConfig): string[] {
  const mappedGroups = rawGroups.flatMap((group) => configValue.groupMappings[group] ?? []);
  const effectiveGroups = configValue.groupMappingMode === 'passthrough_and_mapped'
    ? [...rawGroups, ...mappedGroups]
    : mappedGroups;
  return Array.from(new Set(
    effectiveGroups
      .map((group) => group.trim())
      .filter((group) => group.length > 0 && group !== '*')
  )).sort((left, right) => left.localeCompare(right));
}

function readNumericDate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function audMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.some((item) => item === expected);
  return false;
}

function deriveOidcUserId(subject: string): number {
  const digest = createHash('sha256').update(subject).digest();
  const high = digest.readUInt32BE(0);
  const low = digest.readUInt16BE(4);
  const value = (high * 0x10000 + low) % OIDC_USER_ID_RANGE;
  return OIDC_USER_ID_BASE + value;
}

export function principalSessionHash(principal: AuthenticatedPrincipal): string {
  if (principal.authMode === 'mediawiki_cookie') {
    return (principal.sessionCookie ?? '').slice(0, 32);
  }
  if (principal.authMode === 'oidc') {
    const subject = principal.subject ?? principal.username;
    return `oidc:${createHash('sha256').update(subject).digest('base64url').slice(0, 27)}`;
  }
  return 'anonymous';
}

export function principalFromMwUser(
  mwUser: MWUserInfo,
  sessionCookie: string | undefined
): AuthenticatedPrincipal {
  const hasCookie = Boolean(sessionCookie);
  return {
    authMode: hasCookie ? 'mediawiki_cookie' : 'anonymous',
    username: mwUser.username,
    userId: mwUser.userId,
    groups: mwUser.groups.length > 0 ? mwUser.groups : ['*'],
    rights: mwUser.rights,
    sessionCookie,
  };
}

export function anonymousPrincipal(): AuthenticatedPrincipal {
  return {
    authMode: 'anonymous',
    username: 'anonymous',
    userId: 0,
    groups: ['*'],
  };
}

function externalOidcIsConfigured(configValue: ExternalApiConfig): boolean {
  return Boolean(configValue.oidc.issuer && configValue.oidc.audience && configValue.oidc.jwksUrl);
}

async function fetchJwks(jwksUrl: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUrl);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.keys;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(jwksUrl, {
      headers: { 'User-Agent': 'WikiAI-Gateway/0.1' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as JwksDocument;
    const keys = Array.isArray(payload.keys) ? payload.keys : [];
    jwksCache.set(jwksUrl, { expiresAt: now + JWKS_CACHE_TTL_MS, keys });
    return keys;
  } finally {
    clearTimeout(timeout);
  }
}

function validateHttpsUrl(value: string, label: string): void {
  if (appConfig.nodeEnv !== 'production') return;
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS in production`);
  }
}

function validateOidcTransport(configValue: ExternalApiConfig): void {
  validateHttpsUrl(configValue.oidc.issuer, 'OIDC issuer');
  validateHttpsUrl(configValue.oidc.jwksUrl, 'OIDC JWKS URL');
}

function hasValidRsaModulus(key: Jwk): boolean {
  if (typeof key.n !== 'string') return false;
  try {
    return base64UrlDecode(key.n).byteLength >= 256;
  } catch {
    return false;
  }
}

function selectJwk(keys: Jwk[], header: JwtHeader): Jwk | undefined {
  if (!header.kid) {
    throw new Error('OIDC token kid header is required');
  }

  const matches = keys.filter((key) => {
    if (key.kid !== header.kid) return false;
    if (key.kty !== 'RSA') return false;
    if (key.alg && key.alg !== 'RS256') return false;
    if (key.use && key.use !== 'sig') return false;
    return hasValidRsaModulus(key) && typeof key.e === 'string';
  });
  if (matches.length > 1) {
    throw new Error('OIDC JWKS contains duplicate matching kid entries');
  }
  return matches[0];
}

async function verifyJwtSignature(input: {
  header: JwtHeader;
  signingInput: string;
  signature: Buffer;
  jwksUrl: string;
}): Promise<void> {
  if (input.header.alg !== 'RS256') {
    throw new Error('Only RS256 OIDC tokens are supported');
  }

  const jwk = selectJwk(await fetchJwks(input.jwksUrl), input.header);
  if (!jwk) {
    throw new Error('OIDC signing key was not found in JWKS');
  }

  const key = await webcrypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await webcrypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    input.signature,
    Buffer.from(input.signingInput, 'utf8')
  );
  if (!valid) {
    throw new Error('OIDC token signature is invalid');
  }
}

function validateClaims(payload: JwtPayload, configValue: ExternalApiConfig): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const issuer = readStringClaim(payload, 'iss');
  if (issuer !== configValue.oidc.issuer) {
    throw new Error('OIDC issuer does not match configured issuer');
  }
  if (!audMatches(payload.aud, configValue.oidc.audience)) {
    throw new Error('OIDC audience does not match configured audience');
  }

  const expiresAt = readNumericDate(payload.exp);
  if (!expiresAt || expiresAt <= nowSeconds) {
    throw new Error('OIDC token is expired');
  }
  const notBefore = readNumericDate(payload.nbf);
  if (notBefore && notBefore > nowSeconds + 60) {
    throw new Error('OIDC token is not valid yet');
  }
}

export async function authenticateOidcBearerToken(
  token: string,
  configValue: ExternalApiConfig
): Promise<AuthenticatedPrincipal> {
  if (!externalOidcIsConfigured(configValue)) {
    throw new Error('OIDC is not configured');
  }
  validateOidcTransport(configValue);

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('Bearer token is not a JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = parseJwtPart<JwtHeader>(encodedHeader, 'header');
  const payload = parseJwtPart<JwtPayload>(encodedPayload, 'payload');
  validateClaims(payload, configValue);
  await verifyJwtSignature({
    header,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: base64UrlDecode(encodedSignature),
    jwksUrl: configValue.oidc.jwksUrl,
  });

  const subject = readStringClaim(payload, configValue.oidc.subjectClaim);
  if (!subject) {
    throw new Error('OIDC subject claim is missing');
  }
  const username = readStringClaim(payload, configValue.oidc.usernameClaim) ?? subject;
  const groups = mapOidcGroups(readGroupsClaim(payload, configValue.oidc.groupsClaim), configValue);

  return {
    authMode: 'oidc',
    username,
    userId: deriveOidcUserId(subject),
    groups,
    bearerToken: token,
    subject,
  };
}
