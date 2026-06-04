import { config } from '../config.js';

export interface StartReindexRequest {
  profileId?: string;
  indexTargets?: string[];
  source?: 'mediawiki' | 'qdrant_payload';
  colbertModel?: string;
  colbertCollection?: string;
  attachmentsEnabled?: boolean;
  semanticFactsEnabled?: boolean;
  smwProperties?: string[];
  namespaces?: number[];
  namespaceAcl?: Record<string, string[]>;
  titleFilters?: {
    include: string[];
    exclude: string[];
  };
  categoryFilters?: {
    include: string[];
    exclude: string[];
  };
  documentPolicyId?: string;
  maxPages?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
  dryRun?: boolean;
  llmEnrichmentEnabled?: boolean;
  llmEnrichmentModel?: string;
  llmEnrichmentMaxChars?: number;
  cmdbDynamicPagesEnabled?: boolean;
}

export interface SyncerMediaWikiServiceAuthStatus {
  configured: boolean;
  source: 'service_credentials' | 'legacy_cookie' | 'none' | 'unknown';
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  passwordUsesSecretReference: boolean;
  pamProviderConfigured: boolean;
  deprecatedCookieConfigured: boolean;
  error?: string;
}

export interface SyncerMediaWikiServiceLoginTestResult {
  status: 'ok' | 'error';
  auth: SyncerMediaWikiServiceAuthStatus;
  user?: {
    username: string;
    userId: number;
    groups: string[];
  };
  error?: string;
}

export class SyncerAdminError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: unknown
  ) {
    super(message);
    this.name = 'SyncerAdminError';
  }
}

export function isSyncerAdminError(err: unknown): err is SyncerAdminError {
  return err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fallbackMediaWikiServiceAuthStatus(error?: string): SyncerMediaWikiServiceAuthStatus {
  return {
    configured: false,
    source: 'unknown',
    usernameConfigured: false,
    passwordConfigured: false,
    passwordUsesSecretReference: false,
    pamProviderConfigured: false,
    deprecatedCookieConfigured: false,
    error,
  };
}

export async function callSyncerAdmin(
  path: string,
  init: RequestInit = {},
  baseUrl = config.syncerBaseUrl
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (config.syncerAdminToken) {
    headers.set('x-wikiai-admin-token', config.syncerAdminToken);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data === 'object' && data && 'message' in data
      ? String((data as { message?: unknown }).message)
      : `Syncer HTTP ${res.status}`;
    throw new SyncerAdminError(message, res.status, data);
  }
  return data;
}

export async function startSyncerReindex(input: StartReindexRequest): Promise<unknown> {
  return callSyncerAdmin('/admin/reindex', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getSyncerReindexStatus(): Promise<unknown> {
  return callSyncerAdmin('/admin/reindex/status');
}

export async function getSyncerMediaWikiServiceAuthStatus(
  baseUrl = config.syncerBaseUrl
): Promise<SyncerMediaWikiServiceAuthStatus> {
  const data = await callSyncerAdmin('/admin/mediawiki-service-auth/status', {}, baseUrl);
  if (isRecord(data) && isRecord(data.auth)) {
    return data.auth as unknown as SyncerMediaWikiServiceAuthStatus;
  }
  return fallbackMediaWikiServiceAuthStatus('Unexpected Syncer auth status response');
}

export async function testSyncerMediaWikiServiceAuth(
  baseUrl = config.syncerBaseUrl
): Promise<SyncerMediaWikiServiceLoginTestResult> {
  const data = await callSyncerAdmin('/admin/mediawiki-service-auth/test', { method: 'POST' }, baseUrl);
  if (isRecord(data) && (data.status === 'ok' || data.status === 'error')) {
    return data as unknown as SyncerMediaWikiServiceLoginTestResult;
  }
  return {
    status: 'error',
    auth: fallbackMediaWikiServiceAuthStatus('Unexpected Syncer auth test response'),
    error: 'Unexpected Syncer auth test response',
  };
}
