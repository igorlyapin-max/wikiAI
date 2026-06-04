import { createHash } from 'node:crypto';
import { config } from '../config.js';

export type CmdbDynamicMarkerType = 'parser_function' | 'template' | 'html_marker';
export type CmdbDynamicSnapshotStatus = 'snapshot_hit' | 'snapshot_miss' | 'unresolved_params' | 'disabled' | 'error';

export interface CmdbDynamicSource {
  sourceId: string;
  markerType: CmdbDynamicMarkerType;
  templateCode: string;
  params: Record<string, string>;
  title?: string;
  mode?: string;
  allowAnonymousSnapshot: boolean;
}

export interface CmdbDynamicSnapshotChunk {
  text: string;
  source: CmdbDynamicSource;
  status: CmdbDynamicSnapshotStatus;
  paramsHash: string;
  snapshotFound: boolean;
  publishedBy?: string;
  publishedAt?: string;
  specHash?: string;
}

interface SnapshotFetchOptions {
  enabled?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  maxSnapshotChars?: number;
  redactParams?: string[];
}

interface SnapshotTable {
  name?: unknown;
  title?: unknown;
  columns?: unknown;
  rows?: unknown;
  emptyText?: unknown;
  truncated?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function stableJson(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  ));
}

function sha256Short(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, '');
}

function resolveSimpleMagicWords(value: string, pageTitle?: string): string {
  if (!pageTitle) return value;
  return value
    .replace(/\{\{\s*PAGENAME\s*\}\}/gi, pageTitle.replace(/^.*:/, ''))
    .replace(/\{\{\s*FULLPAGENAME\s*\}\}/gi, pageTitle);
}

function hasUnresolvedWikitext(value: string): boolean {
  return /\{\{|\}\}|\{\#/.test(value);
}

function splitTopLevelPipe(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const pair = input.slice(i, i + 2);
    if (pair === '{{') {
      depth++;
      current += pair;
      i++;
      continue;
    }
    if (pair === '}}' && depth > 0) {
      depth--;
      current += pair;
      i++;
      continue;
    }
    if (input[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += input[i];
  }
  parts.push(current);
  return parts;
}

function findTemplates(content: string): string[] {
  const templates: string[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content.slice(index, index + 2) !== '{{') continue;
    let depth = 0;
    for (let cursor = index; cursor < content.length; cursor++) {
      const pair = content.slice(cursor, cursor + 2);
      if (pair === '{{') {
        depth++;
        cursor++;
        continue;
      }
      if (pair === '}}') {
        depth--;
        cursor++;
        if (depth === 0) {
          templates.push(content.slice(index + 2, cursor - 1));
          index = cursor;
          break;
        }
      }
    }
  }
  return templates;
}

function parseTemplateArgs(rawTemplate: string, pageTitle?: string): CmdbDynamicSource | undefined {
  const parts = splitTopLevelPipe(rawTemplate).map((part) => part.trim());
  if (parts.length === 0) return undefined;
  const head = parts[0] ?? '';
  const normalizedHead = normalizeName(head.split(':')[0] ?? head);
  const isParser = normalizedHead === '#cmdb';
  const isTemplate = ['cmdbpage', 'cmdbwidget', 'cmdbdynamicpage'].includes(normalizedHead);
  if (!isParser && !isTemplate) return undefined;

  const values = new Map<string, string>();
  const parserInlineValue = isParser ? head.replace(/^#cmdb\s*:/i, '').trim() : '';
  if (parserInlineValue) values.set('templatecode', resolveSimpleMagicWords(parserInlineValue, pageTitle));

  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = normalizeName(part.slice(0, eq));
    const value = resolveSimpleMagicWords(part.slice(eq + 1).trim(), pageTitle);
    if (key) values.set(key, value);
  }

  const templateCode = values.get('templatecode')
    ?? values.get('template')
    ?? values.get('code')
    ?? values.get('page');
  if (!templateCode || hasUnresolvedWikitext(templateCode)) return undefined;

  const knownKeys = new Set([
    'templatecode',
    'template',
    'code',
    'page',
    'mode',
    'title',
    'allowanonymoussnapshot',
    'anonymoussnapshot',
    'source',
  ]);
  const params: Record<string, string> = {};
  for (const [key, value] of values) {
    if (knownKeys.has(key)) continue;
    if (value.length > 0) params[key] = value;
  }

  return {
    sourceId: sha256Short({ marker: rawTemplate }),
    markerType: isParser ? 'parser_function' : 'template',
    templateCode,
    params,
    title: values.get('title'),
    mode: values.get('mode'),
    allowAnonymousSnapshot: values.has('allowanonymoussnapshot')
      ? truthy(values.get('allowanonymoussnapshot'))
      : values.has('anonymoussnapshot')
        ? truthy(values.get('anonymoussnapshot'))
        : true,
  };
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of input.matchAll(attrPattern)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

function parseHtmlMarkers(content: string, pageTitle?: string): CmdbDynamicSource[] {
  const sources: CmdbDynamicSource[] = [];
  const elementPattern = /<[^>]*data-wikiai-dynamic-source\s*=\s*(?:"cmdbdynamicpages"|'cmdbdynamicpages')[^>]*>/gi;
  for (const match of content.matchAll(elementPattern)) {
    const raw = match[0] ?? '';
    const attrs = parseAttributes(raw);
    const templateCode = attrs['data-template-code'] || attrs['data-cmdb-template'] || attrs['data-page'];
    if (!templateCode || hasUnresolvedWikitext(templateCode)) continue;
    let params: Record<string, string> = {};
    if (attrs['data-params']) {
      try {
        const parsed = JSON.parse(resolveSimpleMagicWords(attrs['data-params'], pageTitle));
        if (isRecord(parsed)) {
          params = Object.fromEntries(
            Object.entries(parsed)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          );
        }
      } catch {
        params = {};
      }
    }
    sources.push({
      sourceId: sha256Short({ marker: raw }),
      markerType: 'html_marker',
      templateCode,
      params,
      title: attrs['data-title'],
      mode: attrs['data-mode'],
      allowAnonymousSnapshot: attrs['data-allow-anonymous-snapshot'] === undefined
        ? true
        : truthy(attrs['data-allow-anonymous-snapshot']),
    });
  }
  return sources;
}

function dedupeSources(sources: CmdbDynamicSource[]): CmdbDynamicSource[] {
  const seen = new Set<string>();
  const result: CmdbDynamicSource[] = [];
  for (const source of sources) {
    const key = stableJson({
      templateCode: source.templateCode,
      params: source.params,
      allowAnonymousSnapshot: source.allowAnonymousSnapshot,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

export function extractCmdbDynamicSources(
  content: string,
  pageTitle?: string,
  maxSources = config.cmdbDynamicPagesMaxBlocksPerPage
): CmdbDynamicSource[] {
  if (!content.trim()) return [];
  const templateSources = findTemplates(content)
    .map((template) => parseTemplateArgs(template, pageTitle))
    .filter((source): source is CmdbDynamicSource => Boolean(source));
  return dedupeSources([...templateSources, ...parseHtmlMarkers(content, pageTitle)])
    .slice(0, Math.max(0, maxSources));
}

function buildSnapshotUrl(source: CmdbDynamicSource, baseUrl: string): string {
  const url = new URL(`/cmdbuild/dynamicpages/ui/run/${encodeURIComponent(source.templateCode)}`, baseUrl);
  for (const [key, value] of Object.entries(source.params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('json', 'true');
  return url.toString();
}

function hasUnresolvedParams(source: CmdbDynamicSource): boolean {
  return Object.values(source.params).some(hasUnresolvedWikitext);
}

function redactedParams(params: Record<string, string>, redactParams: string[]): Record<string, string> {
  const redacted = new Set(redactParams.map(normalizeName));
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key,
    redacted.has(normalizeName(key)) ? '[redacted]' : value,
  ]));
}

function tableRowsToText(table: SnapshotTable): string[] {
  const title = readString(table.title) ?? readString(table.name) ?? 'table';
  const columns = Array.isArray(table.columns)
    ? table.columns
      .map((column) => isRecord(column) ? readString(column.label) ?? readString(column.key) : readString(column))
      .filter((column): column is string => Boolean(column))
    : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const lines = [`Table: ${title}`];
  if (columns.length > 0) lines.push(`Columns: ${columns.join(', ')}`);
  for (const row of rows.slice(0, 50)) {
    const record = isRecord(row) && isRecord(row.values) ? row.values : row;
    if (!isRecord(record)) continue;
    const cells = Object.entries(record)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('; ');
    if (cells) lines.push(cells);
  }
  if (table.truncated === true) lines.push('Rows are truncated.');
  if (rows.length === 0) {
    const emptyText = readString(table.emptyText);
    if (emptyText) lines.push(`Empty: ${emptyText}`);
  }
  return lines;
}

function snapshotText(input: {
  source: CmdbDynamicSource;
  body: Record<string, unknown>;
  maxChars: number;
  redactParams: string[];
}): string {
  const template = isRecord(input.body.template) ? input.body.template : {};
  const cache = isRecord(input.body.cache) ? input.body.cache : {};
  const tables = Array.isArray(input.body.tables) ? input.body.tables : [];
  const lines = [
    `CMDB dynamic snapshot: ${input.source.title ?? readString(template.description) ?? input.source.templateCode}`,
    `Template: ${input.source.templateCode}`,
    `Snapshot status: snapshot_hit`,
    `Published: ${readString(cache.publishedAt) ?? ''}`,
    `Published by: ${readString(cache.publishedBy) ?? ''}`,
    `Params: ${JSON.stringify(redactedParams(input.source.params, input.redactParams))}`,
    '',
    ...tables.flatMap((table) => tableRowsToText(table as SnapshotTable)),
  ];
  return lines.join('\n').slice(0, Math.max(100, input.maxChars));
}

function statusText(input: {
  source: CmdbDynamicSource;
  status: CmdbDynamicSnapshotStatus;
  message: string;
  redactParams: string[];
}): string {
  return [
    `CMDB dynamic block: ${input.source.title ?? input.source.templateCode}`,
    `Template: ${input.source.templateCode}`,
    `Snapshot status: ${input.status}`,
    `Params: ${JSON.stringify(redactedParams(input.source.params, input.redactParams))}`,
    input.message,
  ].join('\n');
}

export async function fetchCmdbDynamicSnapshotChunk(
  source: CmdbDynamicSource,
  options: SnapshotFetchOptions = {}
): Promise<CmdbDynamicSnapshotChunk | undefined> {
  const enabled = options.enabled ?? config.cmdbDynamicPagesEnabled;
  const baseUrl = options.baseUrl ?? config.cmdbDynamicPagesBaseUrl;
  const maxSnapshotChars = options.maxSnapshotChars ?? config.cmdbDynamicPagesMaxSnapshotChars;
  const timeoutMs = options.timeoutMs ?? config.cmdbDynamicPagesSnapshotTimeoutMs;
  const redactParams = options.redactParams ?? config.cmdbDynamicPagesRedactParams;
  const paramsHash = sha256Short(source.params);

  if (!enabled || !baseUrl || !source.allowAnonymousSnapshot) {
    return undefined;
  }
  if (hasUnresolvedParams(source)) {
    return {
      text: statusText({
        source,
        status: 'unresolved_params',
        message: 'Snapshot was not requested because at least one parameter still contains unresolved wikitext.',
        redactParams,
      }),
      source,
      status: 'unresolved_params',
      paramsHash,
      snapshotFound: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildSnapshotUrl(source, baseUrl), {
      headers: { Accept: 'application/json', 'User-Agent': 'WikiAI-Syncer/0.1' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        text: statusText({
          source,
          status: 'error',
          message: `Anonymous snapshot request failed with HTTP ${response.status}.`,
          redactParams,
        }),
        source,
        status: 'error',
        paramsHash,
        snapshotFound: false,
      };
    }

    const body = await response.json() as unknown;
    if (!isRecord(body)) {
      return undefined;
    }
    const cache = isRecord(body.cache) ? body.cache : {};
    const snapshotFound = body.snapshotFound === true;
    if (!snapshotFound) {
      return {
        text: statusText({
          source,
          status: 'snapshot_miss',
          message: 'Published static snapshot is missing. Dynamic runtime may still require a CMDBuild user session.',
          redactParams,
        }),
        source,
        status: 'snapshot_miss',
        paramsHash: readString(cache.paramsHash) ?? paramsHash,
        snapshotFound: false,
      };
    }

    return {
      text: snapshotText({ source, body, maxChars: maxSnapshotChars, redactParams }),
      source,
      status: 'snapshot_hit',
      paramsHash: readString(cache.paramsHash) ?? paramsHash,
      snapshotFound: true,
      publishedBy: readString(cache.publishedBy),
      publishedAt: readString(cache.publishedAt),
      specHash: readString(cache.specHash),
    };
  } catch (err) {
    return {
      text: statusText({
        source,
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown anonymous snapshot error',
        redactParams,
      }),
      source,
      status: 'error',
      paramsHash,
      snapshotFound: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCmdbDynamicSnapshotChunks(
  sources: CmdbDynamicSource[],
  options: SnapshotFetchOptions = {}
): Promise<CmdbDynamicSnapshotChunk[]> {
  const chunks: CmdbDynamicSnapshotChunk[] = [];
  for (const source of sources) {
    const chunk = await fetchCmdbDynamicSnapshotChunk(source, options);
    if (chunk && chunk.text.trim()) chunks.push(chunk);
  }
  return chunks;
}
