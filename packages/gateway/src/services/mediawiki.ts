import { MWUserInfo } from '../types/index.js';
import { config } from '../config.js';

export interface WikiCategory {
  name: string;
  title: string;
}

export interface WikiNamespace {
  id: number;
  name: string;
  canonical?: string;
  displayName: string;
  content: boolean;
}

export interface WikiUserGroup {
  name: string;
  displayName: string;
  rights?: string[];
}

export interface WikiTag {
  name: string;
  displayName: string;
  description?: string;
  active?: boolean;
}

export interface WikiTemplate {
  name: string;
  title: string;
}

export interface WikiPage {
  title: string;
  namespace: number;
  pageId?: number;
}

export interface SmwProperty {
  name: string;
  title: string;
  type: string;
  description?: string;
}

export interface SmwPropertiesResult {
  values: SmwProperty[];
  nextContinue?: string;
  count: number;
}

export interface FetchWikiCategoriesOptions {
  search?: string;
  limit?: number;
  sessionCookie?: string;
}

export interface FetchWikiSiteInfoOptions {
  sessionCookie?: string;
}

export interface FetchWikiListOptions {
  search?: string;
  limit?: number;
  continue?: string;
  sessionCookie?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripHtml(value: string | undefined): string | undefined {
  return value
    ?.replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim() || undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function buildHeaders(sessionCookie?: string, bearerToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'WikiAI-Gateway/0.1',
  };
  if (sessionCookie) {
    headers.Cookie = sessionCookie;
  }
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return headers;
}

async function fetchMediaWikiJson<T>(
  params: Record<string, string>,
  sessionCookie: string | undefined,
  errorLabel: string
): Promise<T | null> {
  const url = new URL(config.mwApiPath, config.mwBaseUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('format', 'json');

  try {
    const res = await fetch(url.toString(), { headers: buildHeaders(sessionCookie) });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch (err) {
    console.error(errorLabel, err);
    return null;
  }
}

function clampLimit(limit: number | undefined, fallback: number, max = 100): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}

function readCategoryName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const raw = record.category ?? record.title ?? record['*'];
  return readString(raw);
}

function normalizeCategorySearch(value: string | undefined): string | undefined {
  const search = value?.trim();
  if (!search) return undefined;
  return search
    .replace(/^(category|категория):/i, '')
    .replaceAll('_', ' ')
    .trim() || undefined;
}

function stripNamespacePrefix(value: string | undefined): string | undefined {
  const search = value?.trim();
  if (!search) return undefined;
  const separatorIndex = search.indexOf(':');
  return separatorIndex >= 0 ? search.slice(separatorIndex + 1).trim() || undefined : search;
}

function pageSearchPrefixForNamespace(search: string | undefined, namespace: WikiNamespace): string | undefined {
  const trimmed = search?.trim();
  if (!trimmed) return undefined;
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex < 0) return trimmed;

  const prefix = trimmed.slice(0, separatorIndex).trim().toLocaleLowerCase();
  const localTitle = trimmed.slice(separatorIndex + 1).trim();
  const namespaceNames = [namespace.name, namespace.canonical, namespace.displayName]
    .map((name) => name?.trim().toLocaleLowerCase())
    .filter((name): name is string => Boolean(name));
  return namespaceNames.includes(prefix) ? localTitle : undefined;
}

function readNamespace(value: unknown, fallbackId: string): WikiNamespace | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = readNumber(record.id) ?? readNumber(fallbackId);
  if (id === undefined || !Number.isInteger(id)) return undefined;
  const name = readString(record['*']) ?? readString(record.name) ?? '';
  const canonical = readString(record.canonical);
  const displayName = id === 0 && !name ? 'Main' : name || canonical || String(id);
  const content = record.content === '' || record.content === true;
  return { id, name, canonical, displayName, content };
}

function readUserGroup(value: unknown): WikiUserGroup | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = readString(record.name);
  if (!name) return undefined;
  const rights = Array.isArray(record.rights)
    ? record.rights.filter((right): right is string => typeof right === 'string')
    : undefined;
  return {
    name,
    displayName: name,
    rights,
  };
}

function readTag(value: unknown): WikiTag | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = readString(record.name) ?? readString(record.tag) ?? readString(record['*']);
  if (!name) return undefined;
  const displayName = name;
  const description = stripHtml(readString(record.description));
  const active = record.active === undefined ? undefined : record.active === '' || record.active === true;
  return { name, displayName, description, active };
}

function readTemplate(value: unknown): WikiTemplate | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const title = readString(record.title);
  if (!title) return undefined;
  const separatorIndex = title.indexOf(':');
  return {
    title,
    name: separatorIndex >= 0 ? title.slice(separatorIndex + 1) : title,
  };
}

function readPage(value: unknown): WikiPage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const title = readString(record.title);
  if (!title) return undefined;
  const namespace = readNumber(record.ns) ?? readNumber(record.namespace) ?? 0;
  const pageId = readNumber(record.pageid) ?? readNumber(record.pageId);
  return {
    title,
    namespace,
    pageId,
  };
}

function normalizeSmwType(value: string | undefined): string {
  const normalized = value
    ?.replace(/^https?:\/\/semantic-mediawiki\.org\/swivt\/1\.0#/, '')
    .replace(/^_+/, '')
    .trim()
    .toLocaleLowerCase();
  if (!normalized) return 'Unknown';

  const typeMap: Record<string, string> = {
    txt: 'Text',
    text: 'Text',
    wpg: 'Page',
    page: 'Page',
    dat: 'Date',
    date: 'Date',
    num: 'Number',
    number: 'Number',
    boo: 'Boolean',
    boolean: 'Boolean',
    uri: 'URL',
    url: 'URL',
  };
  return typeMap[normalized] ?? value?.trim() ?? 'Unknown';
}

function readSmwProperty(value: unknown): SmwProperty | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const title = readString(record.title);
  if (!title) return undefined;
  const separatorIndex = title.indexOf(':');
  const name = separatorIndex >= 0 ? title.slice(separatorIndex + 1).trim() : title;
  if (!name || name.includes('#')) return undefined;
  return {
    name,
    title,
    type: 'Unknown',
  };
}

function readPageRevisionContent(page: unknown): string | undefined {
  const revisions = asRecord(page)?.revisions;
  const firstRevision = Array.isArray(revisions) ? revisions[0] : undefined;
  const slots = asRecord(asRecord(firstRevision)?.slots);
  const main = asRecord(slots?.main);
  return readString(main?.['*']) ?? readString(asRecord(firstRevision)?.['*']);
}

function readRevisionContentsByTitle(value: unknown): Map<string, string | undefined> {
  const record = asRecord(value);
  const pages = asRecord(asRecord(record?.query)?.pages);
  const result = new Map<string, string | undefined>();
  Object.values(pages ?? {}).forEach((page) => {
    const title = readString(asRecord(page)?.title);
    if (title) result.set(title, readPageRevisionContent(page));
  });
  return result;
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parseSmwPropertyContent(content: string | undefined): Pick<SmwProperty, 'type' | 'description'> {
  if (!content) return { type: 'Unknown' };
  const typeMatch = content.match(/\[\[(?:Has type|Имеет тип)::([^\]]+)\]\]/i);
  const description = content
    .replace(/\[\[[^\]]+\]\]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return {
    type: normalizeSmwType(typeMatch?.[1]),
    description: description || undefined,
  };
}

export async function fetchUserInfo(sessionCookie: string): Promise<MWUserInfo | null> {
  const url = new URL(config.mwApiPath, config.mwBaseUrl);
  url.searchParams.set('action', 'query');
  url.searchParams.set('meta', 'userinfo');
  url.searchParams.set('uiprop', 'groups|rights');
  url.searchParams.set('format', 'json');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Cookie: sessionCookie,
        'User-Agent': 'WikiAI-Gateway/0.1',
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as any;
    const userinfo = data?.query?.userinfo;

    if (!userinfo || userinfo.id === 0) return null;

    return {
      username: userinfo.name,
      userId: userinfo.id,
      groups: userinfo.groups || ['*'],
      rights: Array.isArray(userinfo.rights)
        ? userinfo.rights.filter((right: unknown): right is string => typeof right === 'string')
        : undefined,
    };
  } catch (err) {
    console.error('MW API error:', err);
    return null;
  }
}

export async function userCanRead(sessionCookie: string | undefined, pageTitle: string): Promise<boolean> {
  return userCanReadWithAuth({ sessionCookie, pageTitle });
}

export async function userCanReadWithBearer(bearerToken: string | undefined, pageTitle: string): Promise<boolean> {
  return userCanReadWithAuth({ bearerToken, pageTitle });
}

async function userCanReadWithAuth(input: {
  sessionCookie?: string;
  bearerToken?: string;
  pageTitle: string;
}): Promise<boolean> {
  const url = new URL(config.mwApiPath, config.mwBaseUrl);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', input.pageTitle);
  url.searchParams.set('prop', 'info');
  url.searchParams.set('inprop', 'readable');
  url.searchParams.set('format', 'json');

  try {
    const res = await fetch(url.toString(), {
      headers: buildHeaders(input.sessionCookie, input.bearerToken),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as any;
    const pages = data?.query?.pages;
    if (!pages) return false;

    const page = Object.values(pages)[0] as { readable?: string };
    return page?.readable === '';
  } catch (err) {
    console.error('MW userCan error:', err);
    return false;
  }
}

export async function fetchWikiCategories(options: FetchWikiCategoriesOptions = {}): Promise<WikiCategory[]> {
  const limit = clampLimit(options.limit, 50);
  const search = normalizeCategorySearch(options.search);
  const params: Record<string, string> = {
    action: 'query',
    list: 'allcategories',
    aclimit: String(limit),
  };
  if (search) {
    params.acprefix = search;
  }

  const data = await fetchMediaWikiJson<{ query?: { allcategories?: unknown[] } }>(
    params,
    options.sessionCookie,
    'MW categories API error:'
  );
  const categories = data?.query?.allcategories ?? [];
  return categories
    .map(readCategoryName)
    .filter((name): name is string => Boolean(name))
    .map((name) => ({
      name,
      title: `Category:${name}`,
    }));
}

export async function fetchWikiNamespaces(options: FetchWikiSiteInfoOptions = {}): Promise<WikiNamespace[]> {
  const data = await fetchMediaWikiJson<{ query?: { namespaces?: Record<string, unknown> } }>(
    {
      action: 'query',
      meta: 'siteinfo',
      siprop: 'namespaces',
    },
    options.sessionCookie,
    'MW namespaces API error:'
  );
  return Object.entries(data?.query?.namespaces ?? {})
    .map(([id, value]) => readNamespace(value, id))
    .filter((namespace): namespace is WikiNamespace => Boolean(namespace))
    .sort((left, right) => left.id - right.id);
}

export async function fetchWikiUserGroups(options: FetchWikiSiteInfoOptions = {}): Promise<WikiUserGroup[]> {
  const data = await fetchMediaWikiJson<{ query?: { usergroups?: unknown[] } }>(
    {
      action: 'query',
      meta: 'siteinfo',
      siprop: 'usergroups',
    },
    options.sessionCookie,
    'MW user groups API error:'
  );
  return (data?.query?.usergroups ?? [])
    .map(readUserGroup)
    .filter((group): group is WikiUserGroup => Boolean(group))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function fetchWikiTags(options: FetchWikiListOptions = {}): Promise<WikiTag[]> {
  const limit = clampLimit(options.limit, 50);
  const search = options.search?.trim().toLocaleLowerCase();
  const data = await fetchMediaWikiJson<{ query?: { tags?: unknown[] } }>(
    {
      action: 'query',
      list: 'tags',
      tgprop: 'displayname|description|active',
      tglimit: String(limit),
    },
    options.sessionCookie,
    'MW tags API error:'
  );
  return (data?.query?.tags ?? [])
    .map(readTag)
    .filter((tag): tag is WikiTag => Boolean(tag))
    .filter((tag) => !search || tag.name.toLocaleLowerCase().includes(search) || tag.displayName.toLocaleLowerCase().includes(search))
    .slice(0, limit);
}

export async function fetchWikiTemplates(options: FetchWikiListOptions = {}): Promise<WikiTemplate[]> {
  const limit = clampLimit(options.limit, 50);
  const search = stripNamespacePrefix(options.search);
  const params: Record<string, string> = {
    action: 'query',
    list: 'allpages',
    apnamespace: '10',
    aplimit: String(limit),
  };
  if (search) {
    params.apprefix = search;
  }
  const data = await fetchMediaWikiJson<{ query?: { allpages?: unknown[] } }>(
    params,
    options.sessionCookie,
    'MW templates API error:'
  );
  return (data?.query?.allpages ?? [])
    .map(readTemplate)
    .filter((template): template is WikiTemplate => Boolean(template));
}

export async function fetchWikiPages(options: FetchWikiListOptions = {}): Promise<WikiPage[]> {
  const limit = clampLimit(options.limit, 50);
  const search = options.search?.trim();
  const namespaces = await fetchWikiNamespaces({ sessionCookie: options.sessionCookie });
  const searchableNamespaces = namespaces.filter((namespace) => namespace.id >= 0);
  const pages: WikiPage[] = [];

  for (const namespace of searchableNamespaces.length > 0 ? searchableNamespaces : [{ id: 0, name: '', displayName: 'Main', content: true }]) {
    if (pages.length >= limit) break;
    const pagePrefix = pageSearchPrefixForNamespace(search, namespace);
    if (search && pagePrefix === undefined) continue;
    const params: Record<string, string> = {
      action: 'query',
      list: 'allpages',
      apnamespace: String(namespace.id),
      aplimit: String(limit - pages.length),
    };
    if (pagePrefix) {
      params.apprefix = pagePrefix;
    }
    const data = await fetchMediaWikiJson<{ query?: { allpages?: unknown[] } }>(
      params,
      options.sessionCookie,
      'MW pages API error:'
    );
    const namespacePages = (data?.query?.allpages ?? [])
      .map(readPage)
      .filter((page): page is WikiPage => Boolean(page));
    pages.push(...namespacePages);
  }

  return pages.slice(0, limit);
}

export async function fetchSmwProperties(options: FetchWikiListOptions = {}): Promise<SmwPropertiesResult> {
  const limit = clampLimit(options.limit, 100, 500);
  const search = stripNamespacePrefix(options.search);
  const normalizedSearch = search?.toLocaleLowerCase();
  const params: Record<string, string> = {
    action: 'query',
    list: 'allpages',
    apnamespace: '102',
    aplimit: String(limit),
  };
  if (search) params.apprefix = search;
  if (options.continue) params.apcontinue = options.continue;

  const data = await fetchMediaWikiJson<{ query?: { allpages?: unknown[] } }>(
    params,
    options.sessionCookie,
    'MW SMW properties API error:'
  );
  const continuation = asRecord(data)?.continue;
  const nextContinue = readString(asRecord(continuation)?.apcontinue);
  const properties = (data?.query?.allpages ?? [])
    .map(readSmwProperty)
    .filter((property): property is SmwProperty => Boolean(property))
    .filter((property) => !normalizedSearch || property.name.toLocaleLowerCase().includes(normalizedSearch))
    .slice(0, limit);

  const contentsByTitle = new Map<string, string | undefined>();
  const titleBatches = chunkValues(properties.map((property) => property.title), 50);
  await Promise.all(titleBatches.map(async (titles) => {
    const content = await fetchMediaWikiJson<unknown>(
      {
        action: 'query',
        titles: titles.join('|'),
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
      },
      options.sessionCookie,
      'MW SMW property content API error:'
    );
    readRevisionContentsByTitle(content).forEach((value, title) => contentsByTitle.set(title, value));
  }));

  const values = properties.map((property) => {
    return {
      ...property,
      ...parseSmwPropertyContent(contentsByTitle.get(property.title)),
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'ru'));

  return {
    values,
    nextContinue,
    count: values.length,
  };
}
