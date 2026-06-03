import { readFile } from 'node:fs/promises';
import { config } from '../config.js';

const SECRET_PREFIX = 'secret://';
const AAPM_PREFIX = 'aapm://';

export type SecretProvider = 'None' | 'IndeedPamAapm';

export interface ResolvedSecretStatus {
  configured: boolean;
  usesSecretReference: boolean;
  provider: SecretProvider;
}

interface ApplicationCredentials {
  token?: string;
  username?: string;
  password?: string;
}

interface TimeoutFetchOptions {
  method: 'GET';
  headers: Record<string, string>;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSecretReference(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith(SECRET_PREFIX) || trimmed.startsWith(AAPM_PREFIX);
}

export function ensureSecretReference(value: string): string {
  const trimmed = value.trim();
  return isSecretReference(trimmed) ? trimmed : `${SECRET_PREFIX}${trimmed}`;
}

function readSecretId(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(SECRET_PREFIX)) return trimmed.slice(SECRET_PREFIX.length).trim();
  if (lower.startsWith(AAPM_PREFIX)) return trimmed.slice(AAPM_PREFIX.length).trim();
  return '';
}

function activeProvider(): SecretProvider {
  if (config.secretsProvider.toLowerCase() === 'indeedpamaapm') return 'IndeedPamAapm';
  return 'None';
}

function parseSecretId(secretId: string): { accountPath?: string; accountName?: string } {
  const dot = secretId.lastIndexOf('.');
  if (dot > 0 && dot < secretId.length - 1) {
    return { accountPath: secretId.slice(0, dot), accountName: secretId.slice(dot + 1) };
  }

  const slash = secretId.lastIndexOf('/');
  if (slash > 0 && slash < secretId.length - 1) {
    return { accountPath: secretId.slice(0, slash), accountName: secretId.slice(slash + 1) };
  }

  return {};
}

async function fetchWithTimeout(url: string, options: TimeoutFetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, {
      method: options.method,
      headers: options.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function appendQuery(url: URL, key: string, value: string | undefined): void {
  if (value && value.trim()) url.searchParams.set(key, value.trim());
}

function formatPamComment(secretId: string): string {
  return config.pamComment
    .replaceAll('{service}', 'wikiai-syncer')
    .replaceAll('{secretId}', secretId);
}

async function readApplicationCredentials(): Promise<ApplicationCredentials> {
  if (config.pamToken) return { token: config.pamToken };
  if (config.pamTokenFile) return { token: (await readFile(config.pamTokenFile, 'utf8')).trim() };
  if (config.pamUsername && config.pamPassword) {
    return { username: config.pamUsername, password: config.pamPassword };
  }
  throw new Error(
    'Indeed PAM AAPM credentials are not configured. Set PAMTOKEN, PAMTOKENFILE, or PAMUSERNAME/PAMPASSWORD.'
  );
}

function readJsonPath(value: unknown, path: string): string | undefined {
  let current: unknown = value;
  for (const part of path.split(/[.:]/).filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }

  if (typeof current === 'string') return current.trim() || undefined;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  return undefined;
}

function extractSecretValue(body: string): string {
  if (config.pamResponseType.toLowerCase() !== 'json') return body.trim();

  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed === 'string') return parsed.trim();

  const configured = readJsonPath(parsed, config.pamValueJsonPath);
  if (configured) return configured;

  for (const fallback of ['password', 'value', 'secret', 'Password']) {
    const value = readJsonPath(parsed, fallback);
    if (value) return value;
  }

  return '';
}

async function resolveIndeedPamSecret(secretId: string): Promise<string> {
  if (!config.pamBaseUrl) {
    throw new Error('Indeed PAM AAPM base URL is not configured. Set PAMURL.');
  }

  const { accountPath: parsedAccountPath, accountName: parsedAccountName } = parseSecretId(secretId);
  const accountPath = parsedAccountPath ?? config.pamDefaultAccountPath;
  const accountName = parsedAccountName ?? (config.pamDefaultAccountPath ? secretId : undefined);
  if (!accountPath || !accountName) {
    throw new Error(`Indeed PAM AAPM secret '${secretId}' must include account path and account name.`);
  }

  const url = new URL(config.pamPasswordEndpointPath.replace(/^\/+/, ''), `${config.pamBaseUrl.replace(/\/+$/, '')}/`);
  const appCredentials = await readApplicationCredentials();
  appendQuery(url, 'token', appCredentials.token);
  appendQuery(url, 'sapmaccountpath', accountPath);
  appendQuery(url, 'sapmaccountname', accountName);
  appendQuery(url, 'responsetype', config.pamResponseType);
  appendQuery(url, 'passwordexpirationinminute', config.pamPasswordExpirationInMinute);
  appendQuery(url, 'passwordchangerequired', config.pamPasswordChangeRequired);
  appendQuery(url, 'comment', formatPamComment(secretId));
  appendQuery(url, 'tenantid', config.pamTenantId);
  appendQuery(url, 'pin', config.pamPin);

  const headers: Record<string, string> = {};
  if (appCredentials.username && appCredentials.password) {
    const token = Buffer.from(`${appCredentials.username}:${appCredentials.password}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${token}`;
    if (config.pamSendApplicationCredentialsInQuery) {
      appendQuery(url, 'username', appCredentials.username);
      appendQuery(url, 'password', appCredentials.password);
    }
  }

  const timeoutMs = Number.isFinite(config.pamTimeoutMs) ? config.pamTimeoutMs : 10000;
  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers,
    timeoutMs,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Indeed PAM AAPM secret '${secretId}' request failed with HTTP ${response.status}.`);
  }

  const secret = extractSecretValue(body);
  if (!secret) {
    throw new Error(`Indeed PAM AAPM secret '${secretId}' returned an empty value.`);
  }
  return secret;
}

export function getSecretStatus(value: string | undefined, companionValue?: string): ResolvedSecretStatus {
  const effectiveValue = value?.trim() || (companionValue?.trim() ? ensureSecretReference(companionValue) : undefined);
  return {
    configured: Boolean(effectiveValue),
    usesSecretReference: Boolean(effectiveValue && isSecretReference(effectiveValue)),
    provider: activeProvider(),
  };
}

export async function resolveSecretValue(value: string | undefined, companionValue?: string): Promise<string | undefined> {
  const effectiveValue = value?.trim() || (companionValue?.trim() ? ensureSecretReference(companionValue) : undefined);
  if (!effectiveValue) return undefined;
  if (!isSecretReference(effectiveValue)) return effectiveValue;

  const provider = activeProvider();
  if (provider !== 'IndeedPamAapm') {
    throw new Error(`Configuration contains ${SECRET_PREFIX} or ${AAPM_PREFIX} reference, but secret provider is '${provider}'.`);
  }

  const secretId = readSecretId(effectiveValue);
  if (!secretId) throw new Error('Secret reference is empty.');
  return resolveIndeedPamSecret(secretId);
}
