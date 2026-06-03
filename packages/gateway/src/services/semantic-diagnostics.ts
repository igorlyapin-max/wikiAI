import { config } from '../config.js';
import { qdrant } from './qdrant.js';
import { userCanRead } from './mediawiki.js';

export type SemanticFacts = Record<string, string[]>;

export interface SemanticStatusOptions {
  batchSize?: number;
  maxScan?: number;
}

export interface SemanticPropertyStatus {
  points: number;
  pages: number;
  values: string[];
}

export interface SemanticStatus {
  collection: string;
  scannedPoints: number;
  semanticPoints: number;
  semanticPages: number;
  scanComplete: boolean;
  namespaces: Record<string, number>;
  properties: Record<string, SemanticPropertyStatus>;
}

export interface SemanticSearchOptions extends SemanticStatusOptions {
  property: string;
  value?: string;
  namespace?: number;
  limit?: number;
}

export interface SemanticSearchResult {
  pageId: number;
  title: string;
  namespace: number;
  allowedGroups: string[];
  semanticFacts: SemanticFacts;
  matchedValues: string[];
  lastModified?: string;
}

export interface SemanticSearchResponse {
  collection: string;
  property: string;
  value?: string;
  namespace?: number;
  scannedPoints: number;
  matchedPoints: number;
  returnedPages: number;
  scanComplete: boolean;
  results: SemanticSearchResult[];
}

type ScrollOffset = number | string | Record<string, unknown> | null | undefined;

interface SemanticPointPayload {
  pageId: number;
  title: string;
  namespace: number;
  allowedGroups: string[];
  semanticFacts: SemanticFacts;
  lastModified?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
          .filter((item) => item.length > 0)
      )
    );
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  return [];
}

function readSemanticFacts(payload: Record<string, unknown>): SemanticFacts {
  const rawFacts = payload.semantic_facts;
  if (!isRecord(rawFacts)) return {};

  const facts: SemanticFacts = {};
  for (const [property, rawValues] of Object.entries(rawFacts)) {
    const values = toStringArray(rawValues);
    if (values.length > 0) facts[property] = values;
  }
  return facts;
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readSemanticPayload(payload: Record<string, unknown>): SemanticPointPayload | null {
  const semanticFacts = readSemanticFacts(payload);
  if (Object.keys(semanticFacts).length === 0) return null;

  const pageId = readNumber(payload, 'page_id');
  const namespace = readNumber(payload, 'namespace');
  const title = readString(payload, 'title');
  if (pageId === undefined || namespace === undefined || !title) return null;

  return {
    pageId,
    title,
    namespace,
    allowedGroups: toStringArray(payload.allowed_groups),
    semanticFacts,
    lastModified: readString(payload, 'last_modified'),
  };
}

function hasSemanticPropertyMatch(
  facts: SemanticFacts,
  property: string,
  value?: string
): string[] {
  const values = facts[property] ?? [];
  if (values.length === 0) return [];
  if (!value) return values;

  const expected = value.trim().toLocaleLowerCase('ru-RU');
  return values.filter((item) => item.toLocaleLowerCase('ru-RU').includes(expected));
}

async function scrollSemanticPayloads(
  options: Required<SemanticStatusOptions>,
  onPayload: (payload: SemanticPointPayload) => Promise<void> | void
): Promise<{ scannedPoints: number; semanticPoints: number; scanComplete: boolean }> {
  let offset: ScrollOffset;
  let scannedPoints = 0;
  let semanticPoints = 0;

  do {
    const remaining = options.maxScan - scannedPoints;
    if (remaining <= 0) break;

    const page = await qdrant.scroll(config.qdrantCollection, {
      limit: Math.min(options.batchSize, remaining),
      offset,
      with_payload: true,
      with_vector: false,
    });

    scannedPoints += page.points.length;
    for (const point of page.points) {
      if (!isRecord(point.payload)) continue;
      const payload = readSemanticPayload(point.payload);
      if (!payload) continue;
      semanticPoints++;
      await onPayload(payload);
    }

    offset = page.next_page_offset;
  } while (offset !== undefined && offset !== null);

  return {
    scannedPoints,
    semanticPoints,
    scanComplete: offset === undefined || offset === null,
  };
}

function normalizeStatusOptions(options: SemanticStatusOptions): Required<SemanticStatusOptions> {
  return {
    batchSize: Math.min(Math.max(options.batchSize ?? 256, 1), 500),
    maxScan: Math.min(Math.max(options.maxScan ?? 10_000, 1), 100_000),
  };
}

export async function getSemanticStatus(options: SemanticStatusOptions = {}): Promise<SemanticStatus> {
  const normalized = normalizeStatusOptions(options);
  const pageIds = new Set<number>();
  const namespaces: Record<string, number> = {};
  const propertyPoints = new Map<string, number>();
  const propertyPages = new Map<string, Set<number>>();
  const propertyValues = new Map<string, Set<string>>();

  const scan = await scrollSemanticPayloads(normalized, (payload) => {
    pageIds.add(payload.pageId);
    namespaces[String(payload.namespace)] = (namespaces[String(payload.namespace)] ?? 0) + 1;

    for (const [property, values] of Object.entries(payload.semanticFacts)) {
      propertyPoints.set(property, (propertyPoints.get(property) ?? 0) + 1);

      const pages = propertyPages.get(property) ?? new Set<number>();
      pages.add(payload.pageId);
      propertyPages.set(property, pages);

      const knownValues = propertyValues.get(property) ?? new Set<string>();
      values.forEach((value) => knownValues.add(value));
      propertyValues.set(property, knownValues);
    }
  });

  const properties: Record<string, SemanticPropertyStatus> = {};
  for (const [property, points] of propertyPoints.entries()) {
    properties[property] = {
      points,
      pages: propertyPages.get(property)?.size ?? 0,
      values: Array.from(propertyValues.get(property) ?? []).sort((a, b) => a.localeCompare(b, 'ru')),
    };
  }

  return {
    collection: config.qdrantCollection,
    scannedPoints: scan.scannedPoints,
    semanticPoints: scan.semanticPoints,
    semanticPages: pageIds.size,
    scanComplete: scan.scanComplete,
    namespaces,
    properties,
  };
}

export async function searchSemanticFacts(
  options: SemanticSearchOptions,
  sessionCookie: string,
  canReadPage: (sessionCookie: string, pageTitle: string) => Promise<boolean> = userCanRead
): Promise<SemanticSearchResponse> {
  const normalized = normalizeStatusOptions(options);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const results: SemanticSearchResult[] = [];
  const seenPageIds = new Set<number>();
  let matchedPoints = 0;

  const property = options.property.trim();
  const value = options.value?.trim() || undefined;
  const readableByTitle = new Map<string, boolean>();

  const scan = await scrollSemanticPayloads(normalized, async (payload) => {
    if (results.length >= limit) return;
    if (options.namespace !== undefined && payload.namespace !== options.namespace) return;

    const matchedValues = hasSemanticPropertyMatch(payload.semanticFacts, property, value);
    if (matchedValues.length === 0) return;

    matchedPoints++;
    if (seenPageIds.has(payload.pageId)) return;

    let readable = readableByTitle.get(payload.title);
    if (readable === undefined) {
      readable = await canReadPage(sessionCookie, payload.title);
      readableByTitle.set(payload.title, readable);
    }
    if (!readable) return;

    seenPageIds.add(payload.pageId);
    results.push({
      pageId: payload.pageId,
      title: payload.title,
      namespace: payload.namespace,
      allowedGroups: payload.allowedGroups,
      semanticFacts: payload.semanticFacts,
      matchedValues,
      lastModified: payload.lastModified,
    });
  });

  return {
    collection: config.qdrantCollection,
    property,
    value,
    namespace: options.namespace,
    scannedPoints: scan.scannedPoints,
    matchedPoints,
    returnedPages: results.length,
    scanComplete: scan.scanComplete,
    results,
  };
}
