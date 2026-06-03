import { config } from '../config.js';
import { getSecretStatus, resolveSecretValue } from './secrets.js';
import { logOperationalError } from './logging.js';

export interface MWPage {
  pageid: number;
  ns: number;
  title: string;
  content?: string;
  lastModified?: string;
}

export interface MWEditResult {
  result: 'Success';
  pageId?: number;
  title?: string;
  oldRevisionId?: number;
  newRevisionId?: number;
}

export type SemanticFacts = Record<string, string[]>;

export interface MediaWikiServiceAuthStatus {
  configured: boolean;
  source: 'service_credentials' | 'legacy_cookie' | 'none';
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  passwordUsesSecretReference: boolean;
  pamProviderConfigured: boolean;
  deprecatedCookieConfigured: boolean;
}

export interface MediaWikiServiceLoginTestResult {
  status: 'ok' | 'error';
  auth: MediaWikiServiceAuthStatus;
  user?: {
    username: string;
    userId: number;
    groups: string[];
  };
  error?: string;
}

let cachedSessionCookie: string | undefined;
let loginPromise: Promise<string | undefined> | undefined;

function getApiUrl(): URL {
  return new URL(config.mwApiPath, config.mwBaseUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSetCookie(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }

  const value = headers.get('set-cookie');
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]+)/) : [];
}

function captureCookies(headers: Headers, jar: Map<string, string>): void {
  for (const header of readSetCookie(headers)) {
    const firstPart = header.split(';')[0];
    const index = firstPart.indexOf('=');
    if (index <= 0) continue;
    jar.set(firstPart.slice(0, index).trim(), firstPart.slice(index + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar, ([key, value]) => `${key}=${value}`).join('; ');
}

function serviceCredentialsConfigured(): boolean {
  return Boolean(config.mwServiceUsername && (config.mwServicePassword || config.mwServicePasswordSecret));
}

export function getMediaWikiServiceAuthStatus(): MediaWikiServiceAuthStatus {
  const secret = getSecretStatus(config.mwServicePassword, config.mwServicePasswordSecret);
  const hasServiceCredentials = Boolean(config.mwServiceUsername && secret.configured);
  return {
    configured: hasServiceCredentials || Boolean(config.mwSyncCookie),
    source: hasServiceCredentials ? 'service_credentials' : config.mwSyncCookie ? 'legacy_cookie' : 'none',
    usernameConfigured: Boolean(config.mwServiceUsername),
    passwordConfigured: secret.configured,
    passwordUsesSecretReference: secret.usesSecretReference,
    pamProviderConfigured: secret.provider === 'IndeedPamAapm',
    deprecatedCookieConfigured: Boolean(config.mwSyncCookie),
  };
}

function isAuthError(data: unknown): boolean {
  if (!isRecord(data) || !isRecord(data.error)) return false;
  const code = readString(data.error.code)?.toLowerCase() ?? '';
  return [
    'badtoken',
    'assertuserfailed',
    'assertbotfailed',
    'notloggedin',
    'readapidenied',
    'permissiondenied',
  ].includes(code);
}

async function loginWithServiceCredentials(): Promise<string | undefined> {
  if (!config.mwServiceUsername) return undefined;
  const password = await resolveSecretValue(config.mwServicePassword, config.mwServicePasswordSecret);
  if (!password) return undefined;

  const jar = new Map<string, string>();
  const tokenUrl = getApiUrl();
  tokenUrl.searchParams.set('action', 'query');
  tokenUrl.searchParams.set('meta', 'tokens');
  tokenUrl.searchParams.set('type', 'login');
  tokenUrl.searchParams.set('format', 'json');

  const tokenResponse = await fetch(tokenUrl.toString(), { headers: { 'User-Agent': 'WikiAI-Syncer/0.1' } });
  captureCookies(tokenResponse.headers, jar);
  if (!tokenResponse.ok) throw new Error(`MediaWiki login token request failed with HTTP ${tokenResponse.status}`);
  const tokenData = await tokenResponse.json() as unknown;
  const loginToken = isRecord(tokenData)
    && isRecord(tokenData.query)
    && isRecord(tokenData.query.tokens)
    ? readString(tokenData.query.tokens.logintoken)
    : undefined;
  if (!loginToken) throw new Error('MediaWiki login token was not returned');

  const form = new URLSearchParams({
    action: 'login',
    lgname: config.mwServiceUsername,
    lgpassword: password,
    lgtoken: loginToken,
    format: 'json',
  });
  const loginResponse = await fetch(getApiUrl().toString(), {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'WikiAI-Syncer/0.1',
    },
    body: form,
  });
  captureCookies(loginResponse.headers, jar);
  if (!loginResponse.ok) throw new Error(`MediaWiki login failed with HTTP ${loginResponse.status}`);
  const loginData = await loginResponse.json() as unknown;
  const result = isRecord(loginData)
    && isRecord(loginData.login)
    ? readString(loginData.login.result)
    : undefined;
  if (result !== 'Success') {
    throw new Error(`MediaWiki login failed: ${result ?? 'unknown result'}`);
  }

  const header = cookieHeader(jar);
  if (!header) throw new Error('MediaWiki login succeeded but no session cookie was captured');
  return header;
}

async function getServiceSessionCookie(): Promise<string | undefined> {
  if (!serviceCredentialsConfigured()) return undefined;
  if (cachedSessionCookie) return cachedSessionCookie;
  loginPromise ??= loginWithServiceCredentials().finally(() => {
    loginPromise = undefined;
  });
  cachedSessionCookie = await loginPromise;
  return cachedSessionCookie;
}

function invalidateServiceSession(): void {
  cachedSessionCookie = undefined;
}

export function resetMediaWikiServiceAuthForTests(): void {
  cachedSessionCookie = undefined;
  loginPromise = undefined;
}

async function getRequestHeaders(): Promise<Record<string, string>> {
  const serviceCookie = await getServiceSessionCookie();
  const cookie = serviceCookie ?? config.mwSyncCookie;
  return cookie
    ? { Cookie: cookie, 'User-Agent': 'WikiAI-Syncer/0.1' }
    : { 'User-Agent': 'WikiAI-Syncer/0.1' };
}

async function fetchJson(url: URL, retry = true): Promise<unknown | null> {
  const res = await fetch(url.toString(), { headers: await getRequestHeaders() });
  if (!res.ok) return null;
  const data = await res.json() as unknown;
  if (retry && serviceCredentialsConfigured() && isAuthError(data)) {
    invalidateServiceSession();
    return fetchJson(url, false);
  }
  return data;
}

async function postForm(form: URLSearchParams, retry = true): Promise<unknown | null> {
  const res = await fetch(getApiUrl().toString(), {
    method: 'POST',
    headers: {
      ...(await getRequestHeaders()),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) return null;
  const data = await res.json() as unknown;
  if (retry && serviceCredentialsConfigured() && isAuthError(data)) {
    invalidateServiceSession();
    return postForm(form, false);
  }
  return data;
}

async function fetchCsrfToken(): Promise<string> {
  const url = getApiUrl();
  url.searchParams.set('action', 'query');
  url.searchParams.set('meta', 'tokens');
  url.searchParams.set('type', 'csrf');
  url.searchParams.set('format', 'json');

  const data = await fetchJson(url);
  if (!data || !isRecord(data) || !isRecord(data.query) || !isRecord(data.query.tokens)) {
    throw new Error('MediaWiki CSRF token response is empty');
  }
  const token = readString(data.query.tokens.csrftoken);
  if (!token || token === '+\\') throw new Error('MediaWiki CSRF token was not returned');
  return token;
}

export async function editPageContent(title: string, text: string, summary: string): Promise<MWEditResult> {
  const token = await fetchCsrfToken();
  const form = new URLSearchParams({
    action: 'edit',
    title,
    text,
    summary,
    token,
    bot: '1',
    format: 'json',
  });
  const data = await postForm(form);
  if (!data || !isRecord(data)) throw new Error('MediaWiki edit response is empty');
  if (isRecord(data.error)) {
    throw new Error(`MediaWiki edit failed: ${readString(data.error.code) ?? 'unknown error'}`);
  }
  if (!isRecord(data.edit) || readString(data.edit.result) !== 'Success') {
    throw new Error('MediaWiki edit did not return Success');
  }
  return {
    result: 'Success',
    pageId: typeof data.edit.pageid === 'number' ? data.edit.pageid : undefined,
    title: readString(data.edit.title),
    oldRevisionId: typeof data.edit.oldrevid === 'number' ? data.edit.oldrevid : undefined,
    newRevisionId: typeof data.edit.newrevid === 'number' ? data.edit.newrevid : undefined,
  };
}

export async function fetchPageContent(title: string): Promise<MWPage | null> {
  const url = getApiUrl();
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', title);
  url.searchParams.set('prop', 'revisions');
  url.searchParams.set('rvprop', 'content|timestamp');
  url.searchParams.set('rvslots', 'main');
  url.searchParams.set('format', 'json');

  try {
    const data = await fetchJson(url);
    if (!data || isAuthError(data)) return null;
    const record = data as any;
    const pages = record.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0] as any;
    if (page.missing) return null;

    const revision = page.revisions?.[0];
    const content = revision?.slots?.main?.['*'] ?? revision?.['*'] ?? '';
    const lastModified = typeof revision?.timestamp === 'string' ? revision.timestamp : undefined;

    return { pageid: page.pageid, ns: page.ns, title: page.title, content, lastModified };
  } catch (err) {
    logOperationalError('mediawiki.fetch_page_error', err, { title });
    return null;
  }
}

export function normalizeSemanticValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const key of ['fulltext', 'fullText', 'displaytitle', 'value', 'timestamp', 'raw']) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.trim()) return nested;
    if (typeof nested === 'number' || typeof nested === 'boolean') return String(nested);
  }
  return null;
}

export function normalizeSemanticPrintouts(printouts: Record<string, unknown>): SemanticFacts {
  const facts: SemanticFacts = {};

  for (const [property, rawValues] of Object.entries(printouts)) {
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const normalized = values
      .map(normalizeSemanticValue)
      .filter((value): value is string => Boolean(value && value.trim()));
    if (normalized.length > 0) {
      facts[property] = Array.from(new Set(normalized));
    }
  }

  return facts;
}

export function semanticFactsToText(facts: SemanticFacts): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return '';

  return [
    'Семантические свойства:',
    ...entries.map(([property, values]) => `${property}: ${values.join(', ')}`),
  ].join('\n');
}

function uniqueProperties(properties: string[]): string[] {
  return Array.from(new Set(
    properties
      .map((property) => property.trim())
      .filter(Boolean)
  ));
}

export async function fetchSemanticFacts(
  title: string,
  smwProperties = config.smwSyncProperties
): Promise<SemanticFacts> {
  const properties = uniqueProperties(smwProperties);
  if (properties.length === 0) return {};

  const url = getApiUrl();
  url.searchParams.set('action', 'ask');
  url.searchParams.set(
    'query',
    `[[${title}]]|${properties.map((property) => `?${property}`).join('|')}|limit=1`
  );
  url.searchParams.set('format', 'json');

  try {
    const data = await fetchJson(url);
    if (!data || isAuthError(data)) return {};
    const record = data as any;
    if (record.error) return {};
    const results = record.query?.results;
    if (!results || typeof results !== 'object') return {};
    const firstResult = Object.values(results)[0] as any;
    return normalizeSemanticPrintouts(firstResult?.printouts ?? {});
  } catch (err) {
    logOperationalError('mediawiki.fetch_semantic_facts_error', err, { title });
    return {};
  }
}

export async function fetchAllPages(namespace?: number): Promise<Array<{ pageid: number; ns: number; title: string }>> {
  const results: Array<{ pageid: number; ns: number; title: string }> = [];
  let apcontinue: string | undefined;

  do {
    const url = getApiUrl();
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'allpages');
    url.searchParams.set('aplimit', '500');
    url.searchParams.set('format', 'json');
    if (namespace !== undefined) url.searchParams.set('apnamespace', String(namespace));
    if (apcontinue) url.searchParams.set('apcontinue', apcontinue);

    const data = await fetchJson(url);
    if (!data || isAuthError(data)) break;
    const record = data as any;
    const pages = record.query?.allpages ?? [];
    results.push(...pages);
    apcontinue = record.continue?.apcontinue;
  } while (apcontinue);

  return results;
}

export async function fetchPageCategories(title: string): Promise<string[]> {
  const url = getApiUrl();
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', title);
  url.searchParams.set('prop', 'categories');
  url.searchParams.set('cllimit', 'max');
  url.searchParams.set('format', 'json');

  try {
    const data = await fetchJson(url);
    if (!data || isAuthError(data)) return [];
    const record = data as any;
    const pages = record.query?.pages;
    if (!pages) return [];

    const page = Object.values(pages)[0] as any;
    const categories = page.categories ?? [];
    return categories
      .map((category: { title?: unknown }) => typeof category.title === 'string' ? category.title : undefined)
      .filter((category: string | undefined): category is string => Boolean(category));
  } catch (err) {
    logOperationalError('mediawiki.fetch_page_categories_error', err, { title });
    return [];
  }
}

export interface MWFile {
  filename: string;
  url: string;
  mime: string;
  size: number;
}

export async function fetchPageFiles(title: string): Promise<string[]> {
  const url = getApiUrl();
  url.searchParams.set('action', 'parse');
  url.searchParams.set('page', title);
  url.searchParams.set('prop', 'images');
  url.searchParams.set('format', 'json');

  try {
    const data = await fetchJson(url);
    if (!data || isAuthError(data)) return [];
    const record = data as any;
    const images: string[] = record.parse?.images ?? [];
    return images.filter((name: string) => !name.startsWith('Page_'));
  } catch (err) {
    logOperationalError('mediawiki.fetch_page_files_error', err, { title });
    return [];
  }
}

export async function fetchFileInfo(filename: string): Promise<MWFile | null> {
  const url = getApiUrl();
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', `File:${filename}`);
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|size|mime');
  url.searchParams.set('format', 'json');

  try {
    const data = await fetchJson(url);
    if (!data || isAuthError(data)) return null;
    const record = data as any;
    const pages = record.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0] as any;
    if (page.missing) return null;

    const info = page.imageinfo?.[0];
    if (!info) return null;

    return {
      filename,
      url: info.url,
      mime: info.mime,
      size: info.size,
    };
  } catch (err) {
    logOperationalError('mediawiki.fetch_file_info_error', err, { filename });
    return null;
  }
}

export async function downloadFile(url: string): Promise<Buffer | null> {
  try {
    let res = await fetch(url, { headers: await getRequestHeaders() });
    if ((res.status === 401 || res.status === 403) && serviceCredentialsConfigured()) {
      invalidateServiceSession();
      res = await fetch(url, { headers: await getRequestHeaders() });
    }
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logOperationalError('mediawiki.download_file_error', err);
    return null;
  }
}

export async function testMediaWikiServiceLogin(): Promise<MediaWikiServiceLoginTestResult> {
  const auth = getMediaWikiServiceAuthStatus();
  if (!auth.configured) {
    return { status: 'error', auth, error: 'MediaWiki service credentials are not configured' };
  }

  try {
    invalidateServiceSession();
    const headers = await getRequestHeaders();
    const url = getApiUrl();
    url.searchParams.set('action', 'query');
    url.searchParams.set('meta', 'userinfo');
    url.searchParams.set('uiprop', 'groups');
    url.searchParams.set('format', 'json');
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`MediaWiki userinfo failed with HTTP ${res.status}`);
    const data = await res.json() as unknown;
    if (isAuthError(data)) throw new Error('MediaWiki service session is not authorized');
    const userInfo = isRecord(data) && isRecord(data.query) && isRecord(data.query.userinfo)
      ? data.query.userinfo
      : {};
    const username = readString((userInfo as Record<string, unknown>).name) ?? 'unknown';
    const userIdRaw = (userInfo as Record<string, unknown>).id;
    const groupsRaw = (userInfo as Record<string, unknown>).groups;
    return {
      status: 'ok',
      auth: getMediaWikiServiceAuthStatus(),
      user: {
        username,
        userId: typeof userIdRaw === 'number' ? userIdRaw : 0,
        groups: Array.isArray(groupsRaw)
          ? groupsRaw.filter((group): group is string => typeof group === 'string')
          : [],
      },
    };
  } catch (err) {
    invalidateServiceSession();
    return {
      status: 'error',
      auth: getMediaWikiServiceAuthStatus(),
      error: err instanceof Error ? err.message : 'Unknown MediaWiki service login error',
    };
  }
}
