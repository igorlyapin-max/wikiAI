import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  getAdminPostgresStore,
  getAdminSqliteDatabase,
  isPostgresDatabase,
  type PostgresQueryClient,
} from '../db/admin-store.js';
import { logOperationalError, logOperationalEvent } from './logging.js';
import {
  recordTrigramBackfillJobMetric,
  recordTrigramBackfillProgress,
  recordTrigramSearchMetrics,
} from './metrics.js';
import { SearchChunk } from '../types/index.js';

export interface SearchIndexChunkInput {
  id: number;
  text: string;
  chunkIndex?: number;
  totalChunks?: number;
  sourceType?: string;
  attachmentFilename?: string;
  mimeType?: string;
  processingMode?: string;
  contentType?: string;
}

export interface SearchIndexPageInput {
  pageId: number;
  title: string;
  namespace: number;
  allowedGroups: string[];
  lastModified?: string;
  chunks: SearchIndexChunkInput[];
  replacePage?: boolean;
  indexTargets?: string[];
  colbertModel?: string;
  colbertCollection?: string;
}

export interface SearchIndexWriteResult {
  status: 'ok';
  pageId: number;
  replacedPage: boolean;
  chunks: number;
}

export type LexicalNormalizationMode = 'simple_stem' | 'raw_prefix';

export interface LexicalSynonymRule {
  term: string;
  synonyms: string[];
}

export interface LexicalSearchOptions {
  normalizationMode?: LexicalNormalizationMode;
  synonymsEnabled?: boolean;
  synonyms?: LexicalSynonymRule[];
  transliterationEnabled?: boolean;
  editDistanceEnabled?: boolean;
}

export interface LexicalSearchChunk extends SearchChunk {
  lexicalRank: number;
  lexicalMatchedTerms: string[];
  lexicalMatchedTermCount: number;
}

export interface LexicalSearchResult {
  chunks: LexicalSearchChunk[];
  rawCandidates: number;
  requiredMatchedTerms: number;
  queryTerms: string[];
  expandedTerms: string[];
  synonymTerms: string[];
  transliterationTerms: string[];
  editDistanceTerms: string[];
  ftsQuery: string;
}

export interface SearchIndexStatus {
  chunks: number;
  ftsChunks: number;
  trigramChunks: number;
  trigramFtsChunks: number;
  attachmentChunks: number;
  attachmentPages: number;
  attachmentFilenames: Array<{
    filename: string;
    chunks: number;
    pages: number;
  }>;
  attachmentColumnsReady: boolean;
  pages: number;
  latestUpdatedAt?: string;
  populated: boolean;
  backfillRecommended: boolean;
  trigramPopulated: boolean;
  trigramBackfillRecommended: boolean;
}

export interface SearchIndexAttachmentDiagnostics {
  filename: string;
  chunks: number;
  pages: number;
  found: boolean;
  samples: Array<{
    id: number;
    pageId: number;
    title: string;
    sourceType?: string;
    attachmentFilename?: string;
    attachmentMime?: string;
    attachmentProcessingMode?: string;
    chunkIndex?: number;
    totalChunks?: number;
  }>;
}

export interface TrigramSearchResult {
  chunks: LexicalSearchChunk[];
  rawCandidates: number;
  requiredMatchedTerms: number;
  queryTerms: string[];
  ftsQuery: string;
  latencyMs: number;
}

export interface TrigramBackfillResult {
  status: 'ok';
  chunks: number;
  grams: number;
}

export type TrigramBackfillJobStatusValue = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface TrigramBackfillJobStatus {
  id: string;
  type: 'trigram';
  status: TrigramBackfillJobStatusValue;
  totalChunks: number;
  processedChunks: number;
  writtenChunks: number;
  grams: number;
  requestedBy?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  error?: string;
}

interface SearchChunkRow {
  chunk_id: string;
  page_id: number;
  title: string;
  namespace: number;
  text: string;
  allowed_groups_json: unknown;
  chunk_index: number;
  total_chunks: number;
  source_type: string;
  attachment_filename: string | null;
  attachment_mime: string | null;
  attachment_processing_mode: string | null;
  content_type: string | null;
  last_modified: Date | string | null;
  lexical_rank: number;
}

interface SearchIndexStatusRow {
  chunks: number;
  pages: number;
  attachment_chunks?: number;
  attachment_pages?: number;
  latest_updated_at: Date | string | null;
}

interface AttachmentFilenameRow {
  attachment_filename: string | null;
  chunks: number;
  pages: number;
}

interface CountRow {
  count: number;
}

const REQUIRED_ATTACHMENT_COLUMNS = ['attachment_mime', 'attachment_processing_mode', 'content_type'];

interface TrigramChunkRow {
  chunk_id: string;
  page_id: number;
  title: string;
  text: string;
}

interface TrigramBackfillJobRow {
  id: string;
  type: string;
  status: string;
  total_chunks: number;
  processed_chunks: number;
  written_chunks: number;
  grams: number;
  requested_by: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  updated_at: Date | string;
  error: string | null;
}

interface LexicalQueryPlan {
  queryTerms: string[];
  expandedTerms: string[];
  synonymTerms: string[];
  transliterationTerms: string[];
  editDistanceTerms: string[];
  ftsQuery: string;
}

const DEFAULT_TECH_TRANSLITERATION_TERMS: LexicalSynonymRule[] = [
  { term: 'server', synonyms: ['сервер'] },
  { term: 'router', synonyms: ['роутер'] },
  { term: 'switch', synonyms: ['свитч'] },
  { term: 'gateway', synonyms: ['гейтвей', 'шлюз'] },
  { term: 'service', synonyms: ['сервис'] },
  { term: 'incident', synonyms: ['инцидент'] },
  { term: 'ticket', synonyms: ['тикет', 'заявка'] },
  { term: 'database', synonyms: ['база', 'бд'] },
];

const TRIGRAM_BACKFILL_BATCH_SIZE = 500;
const TRIGRAM_SLOW_SEARCH_THRESHOLD_MS = 200;
const TRIGRAM_BACKFILL_STALE_MS = 10 * 60 * 1000;
let activeTrigramBackfillJobId: string | undefined;
const canceledTrigramBackfillJobs = new Set<string>();

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function normalizeAllowedGroups(value: string[]): string[] {
  const groups = Array.from(new Set(
    value
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  ));
  return groups.length > 0 ? groups : ['*'];
}

function parseAllowedGroups(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedGroups(value.filter((item): item is string => typeof item === 'string'));
  }
  if (typeof value !== 'string') return ['*'];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? normalizeAllowedGroups(parsed.filter((item): item is string => typeof item === 'string'))
      : ['*'];
  } catch {
    return ['*'];
  }
}

function serializeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeOptionalTimestamp(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return serializeTimestamp(value);
}

function attachmentFilenameRows(rows: AttachmentFilenameRow[]): SearchIndexStatus['attachmentFilenames'] {
  return rows
    .filter((row) => typeof row.attachment_filename === 'string' && row.attachment_filename.trim().length > 0)
    .map((row) => ({
      filename: String(row.attachment_filename),
      chunks: Number(row.chunks ?? 0),
      pages: Number(row.pages ?? 0),
    }));
}

function tokenizeForFts(input: string): string[] {
  return input
    .toLocaleLowerCase('ru')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => term.trim())
    .filter((term) => term.length >= 2) ?? [];
}

function normalizeFtsTerm(term: string, mode: LexicalNormalizationMode = 'simple_stem'): string {
  if (/^\d+$/.test(term)) return term;
  if (mode === 'raw_prefix') {
    return term.length <= 5 ? term : term.slice(0, 5);
  }
  const isCyrillic = /^[\p{Script=Cyrillic}]+$/u.test(term);
  if (!isCyrillic) {
    return term.length <= 5 ? term : term.slice(0, 5);
  }

  const stem = term.replace(
    /(ами|ями|ого|ему|ыми|ими|ий|ый|ой|ая|ое|ее|ые|ие|ую|юю|ым|им|ом|ем|ах|ях|а|я|ы|и|у|ю|е|о)$/u,
    ''
  );
  const normalized = stem.length >= 4 ? stem : term;
  return normalized.length <= 5 ? normalized : normalized.slice(0, 5);
}

function buildFtsTerms(input: string, mode: LexicalNormalizationMode = 'simple_stem'): string[] {
  return Array.from(new Set(tokenizeForFts(input).map((term) => normalizeFtsTerm(term, mode)))).slice(0, 12);
}

function normalizeLexicalOptions(options: LexicalSearchOptions = {}): Required<LexicalSearchOptions> {
  return {
    normalizationMode: options.normalizationMode ?? 'simple_stem',
    synonymsEnabled: options.synonymsEnabled ?? false,
    synonyms: options.synonyms ?? [],
    transliterationEnabled: options.transliterationEnabled ?? false,
    editDistanceEnabled: options.editDistanceEnabled ?? false,
  };
}

function uniqueTerms(terms: string[], maxTerms = 24): string[] {
  return Array.from(new Set(terms.filter((term) => term.length >= 2))).slice(0, maxTerms);
}

function normalizeRuleTerms(rule: LexicalSynonymRule, mode: LexicalNormalizationMode): { term: string[]; synonyms: string[] } {
  return {
    term: buildFtsTerms(rule.term, mode),
    synonyms: uniqueTerms(rule.synonyms.flatMap((synonym) => buildFtsTerms(synonym, mode))),
  };
}

function buildSynonymTerms(
  queryTerms: string[],
  rules: LexicalSynonymRule[],
  mode: LexicalNormalizationMode
): string[] {
  const additions: string[] = [];
  for (const rule of rules) {
    const normalized = normalizeRuleTerms(rule, mode);
    const ruleMatched = normalized.term.some((term) => queryTerms.includes(term));
    const synonymMatched = normalized.synonyms.some((term) => queryTerms.includes(term));
    if (ruleMatched) additions.push(...normalized.synonyms);
    if (synonymMatched) additions.push(...normalized.term);
  }
  return uniqueTerms(additions, 12);
}

const cyrillicToLatin: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ы: 'y',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const latinToCyrillicPairs: Array<[string, string]> = [
  ['shch', 'щ'],
  ['zh', 'ж'],
  ['ch', 'ч'],
  ['sh', 'ш'],
  ['ts', 'ц'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['yo', 'е'],
  ['a', 'а'],
  ['b', 'б'],
  ['v', 'в'],
  ['g', 'г'],
  ['d', 'д'],
  ['e', 'е'],
  ['z', 'з'],
  ['i', 'и'],
  ['y', 'й'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['f', 'ф'],
  ['h', 'х'],
];

function transliterateCyrillicToLatin(term: string): string {
  return Array.from(term)
    .map((char) => cyrillicToLatin[char] ?? char)
    .join('');
}

function transliterateLatinToCyrillic(term: string): string {
  let result = '';
  let index = 0;
  while (index < term.length) {
    const match = latinToCyrillicPairs.find(([latin]) => term.startsWith(latin, index));
    if (!match) {
      result += term[index];
      index += 1;
      continue;
    }
    result += match[1];
    index += match[0].length;
  }
  return result;
}

function buildTransliterationTerms(query: string, mode: LexicalNormalizationMode): string[] {
  const terms: string[] = [];
  for (const token of tokenizeForFts(query)) {
    if (/^[\p{Script=Cyrillic}]+$/u.test(token)) {
      terms.push(...buildFtsTerms(transliterateCyrillicToLatin(token), mode));
    } else if (/^[a-z0-9]+$/u.test(token)) {
      terms.push(...buildFtsTerms(transliterateLatinToCyrillic(token), mode));
    }
  }
  terms.push(...buildSynonymTerms(
    buildFtsTerms(query, mode),
    DEFAULT_TECH_TRANSLITERATION_TERMS,
    mode
  ));
  return uniqueTerms(terms, 12);
}

function buildEditDistanceTerms(queryTerms: string[]): string[] {
  return uniqueTerms(
    queryTerms
      .filter((term) => term.length >= 5)
      .map((term) => term.slice(0, -1))
      .filter((term) => term.length >= 4),
    12
  );
}

function buildLexicalQueryPlan(query: string, options: LexicalSearchOptions = {}): LexicalQueryPlan {
  const normalizedOptions = normalizeLexicalOptions(options);
  const queryTerms = buildFtsTerms(query, normalizedOptions.normalizationMode);
  const synonymTerms = normalizedOptions.synonymsEnabled
    ? buildSynonymTerms(queryTerms, normalizedOptions.synonyms, normalizedOptions.normalizationMode)
    : [];
  const transliterationTerms = normalizedOptions.transliterationEnabled
    ? buildTransliterationTerms(query, normalizedOptions.normalizationMode)
    : [];
  const editDistanceTerms = normalizedOptions.editDistanceEnabled
    ? buildEditDistanceTerms(queryTerms)
    : [];
  const expandedTerms = uniqueTerms([
    ...queryTerms,
    ...synonymTerms,
    ...transliterationTerms,
    ...editDistanceTerms,
  ]);
  return {
    queryTerms,
    expandedTerms,
    synonymTerms,
    transliterationTerms,
    editDistanceTerms,
    ftsQuery: expandedTerms.map((term) => `${term}*`).join(' OR '),
  };
}

function validateSearchIndexPageInput(input: SearchIndexPageInput): void {
  if (!isPositiveInteger(input.pageId)) {
    throw new Error('pageId must be a positive integer');
  }
  if (!Number.isInteger(input.namespace) || input.namespace < 0) {
    throw new Error('namespace must be a non-negative integer');
  }
  if (!input.title.trim()) {
    throw new Error('title is required');
  }
  for (const chunk of input.chunks) {
    if (!isPositiveInteger(chunk.id)) {
      throw new Error('chunk id must be a positive integer');
    }
    if (!chunk.text.trim()) {
      throw new Error('chunk text is required');
    }
    if (chunk.chunkIndex !== undefined && !isNonNegativeInteger(chunk.chunkIndex)) {
      throw new Error('chunkIndex must be a non-negative integer');
    }
    if (chunk.totalChunks !== undefined && !isPositiveInteger(chunk.totalChunks)) {
      throw new Error('totalChunks must be a positive integer');
    }
  }
}

export function buildFtsQuery(input: string): string {
  return buildLexicalQueryPlan(input).ftsQuery;
}

function normalizeCandidateLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function levenshteinWithinOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

function getMatchedTerms(
  row: Pick<SearchChunkRow, 'title' | 'text'>,
  queryTerms: string[],
  options: Required<LexicalSearchOptions>
): string[] {
  const candidateTerms = tokenizeForFts(`${row.title} ${row.text}`)
    .map((term) => normalizeFtsTerm(term, options.normalizationMode));
  return queryTerms.filter((queryTerm) => candidateTerms.some((term) => (
    term.startsWith(queryTerm)
      || (
        options.editDistanceEnabled
        && queryTerm.length >= 4
        && levenshteinWithinOne(queryTerm, term.slice(0, queryTerm.length))
      )
  )));
}

function rowToChunk(row: SearchChunkRow, matchedTerms: string[]): LexicalSearchChunk {
  const id = Number(row.chunk_id);
  return {
    id,
    pageId: row.page_id,
    title: row.title,
    text: row.text,
    namespace: row.namespace,
    allowedGroups: parseAllowedGroups(row.allowed_groups_json),
    score: 0,
    sourceType: row.source_type,
    attachmentFilename: row.attachment_filename ?? undefined,
    attachmentMime: row.attachment_mime ?? undefined,
    attachmentProcessingMode: row.attachment_processing_mode ?? undefined,
    contentType: row.content_type ?? undefined,
    chunkIndex: row.chunk_index,
    totalChunks: row.total_chunks,
    lastModified: serializeOptionalTimestamp(row.last_modified),
    lexicalRank: row.lexical_rank,
    lexicalMatchedTerms: matchedTerms,
    lexicalMatchedTermCount: matchedTerms.length,
  };
}

function rowToAttachmentDiagnosticSample(row: SearchChunkRow): SearchIndexAttachmentDiagnostics['samples'][number] {
  return {
    id: Number(row.chunk_id),
    pageId: row.page_id,
    title: row.title,
    sourceType: row.source_type || undefined,
    attachmentFilename: row.attachment_filename ?? undefined,
    attachmentMime: row.attachment_mime ?? undefined,
    attachmentProcessingMode: row.attachment_processing_mode ?? undefined,
    chunkIndex: row.chunk_index,
    totalChunks: row.total_chunks,
  };
}

function buildPostgresTsQuery(terms: string[]): string {
  return uniqueTerms(terms)
    .map((term) => term.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((term) => term.length > 0)
    .map((term) => `${term}:*`)
    .join(' | ');
}

function buildTrigramTerms(input: string): string[] {
  const terms: string[] = [];
  for (const token of tokenizeForFts(input)) {
    if (token.length < 3) continue;
    if (token.length === 3) {
      terms.push(token);
      continue;
    }
    for (let index = 0; index <= token.length - 3; index += 1) {
      terms.push(token.slice(index, index + 3));
    }
  }
  return uniqueTerms(terms, 512);
}

function buildTrigramIndexText(title: string, text: string): string {
  return buildTrigramTerms(`${title} ${text}`).join(' ');
}

function deleteTrigramRowsByChunkIds(db: ReturnType<typeof getAdminSqliteDatabase>, chunkIds: string[]): void {
  if (chunkIds.length === 0) return;
  const deleteFts = db.prepare('DELETE FROM ai_search_chunks_trigram_fts WHERE chunk_id = ?');
  const deleteMeta = db.prepare('DELETE FROM ai_search_chunks_trigram WHERE chunk_id = ?');
  for (const chunkId of chunkIds) {
    deleteFts.run(chunkId);
    deleteMeta.run(chunkId);
  }
}

function deleteTrigramRowsByPage(db: ReturnType<typeof getAdminSqliteDatabase>, pageId: number): void {
  const rows = db
    .prepare('SELECT chunk_id FROM ai_search_chunks_trigram WHERE page_id = ?')
    .all(pageId) as Array<{ chunk_id: string }>;
  deleteTrigramRowsByChunkIds(db, rows.map((row) => row.chunk_id));
}

function upsertTrigramChunk(
  db: ReturnType<typeof getAdminSqliteDatabase>,
  input: Pick<SearchIndexPageInput, 'pageId' | 'title'>,
  chunk: SearchIndexChunkInput,
  now: string
): number {
  const chunkId = String(chunk.id);
  const gramsText = buildTrigramIndexText(input.title, chunk.text);
  db.prepare(
    `INSERT INTO ai_search_chunks_trigram (chunk_id, page_id, title, grams_text, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id) DO UPDATE SET
       page_id = excluded.page_id,
       title = excluded.title,
       grams_text = excluded.grams_text,
       updated_at = excluded.updated_at`
  ).run(chunkId, input.pageId, input.title, gramsText, now);
  db.prepare('DELETE FROM ai_search_chunks_trigram_fts WHERE chunk_id = ?').run(chunkId);
  db.prepare(
    `INSERT INTO ai_search_chunks_trigram_fts (chunk_id, title, grams_text)
     VALUES (?, ?, ?)`
  ).run(chunkId, input.title, gramsText);
  return gramsText ? gramsText.split(' ').length : 0;
}

async function deletePostgresTrigramRowsByPage(client: PostgresQueryClient, pageId: number): Promise<void> {
  await client.query('DELETE FROM ai_search_chunks_trigram WHERE page_id = $1', [pageId]);
}

async function deletePostgresTrigramRowsByChunkIds(client: PostgresQueryClient, chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  await client.query('DELETE FROM ai_search_chunks_trigram WHERE chunk_id = ANY($1::text[])', [chunkIds]);
}

async function upsertPostgresTrigramChunk(
  client: PostgresQueryClient,
  input: Pick<SearchIndexPageInput, 'pageId' | 'title'>,
  chunk: SearchIndexChunkInput,
  now: string
): Promise<number> {
  const chunkId = String(chunk.id);
  const gramsText = buildTrigramIndexText(input.title, chunk.text);
  await client.query(
    `INSERT INTO ai_search_chunks_trigram (chunk_id, page_id, title, grams_text, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(chunk_id) DO UPDATE SET
       page_id = excluded.page_id,
       title = excluded.title,
       grams_text = excluded.grams_text,
       updated_at = excluded.updated_at`,
    [chunkId, input.pageId, input.title, gramsText, now]
  );
  return gramsText ? gramsText.split(' ').length : 0;
}

async function upsertSearchIndexPagePostgres(input: SearchIndexPageInput): Promise<SearchIndexWriteResult> {
  const pg = await getAdminPostgresStore();
  const now = new Date().toISOString();
  const allowedGroups = normalizeAllowedGroups(input.allowedGroups);
  const replacePage = input.replacePage !== false;

  await pg.withTransaction(async (client) => {
    if (replacePage) {
      await deletePostgresTrigramRowsByPage(client, input.pageId);
      await client.query('DELETE FROM ai_search_chunks WHERE page_id = $1', [input.pageId]);
    }

    for (const chunk of input.chunks) {
      const chunkId = String(chunk.id);
      await deletePostgresTrigramRowsByChunkIds(client, [chunkId]);
      await client.query(
        `INSERT INTO ai_search_chunks
          (chunk_id, page_id, title, namespace, text, allowed_groups_json, chunk_index,
           total_chunks, source_type, attachment_filename, attachment_mime,
           attachment_processing_mode, content_type, last_modified, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT(chunk_id) DO UPDATE SET
           page_id = excluded.page_id,
           title = excluded.title,
           namespace = excluded.namespace,
           text = excluded.text,
           allowed_groups_json = excluded.allowed_groups_json,
           chunk_index = excluded.chunk_index,
           total_chunks = excluded.total_chunks,
           source_type = excluded.source_type,
           attachment_filename = excluded.attachment_filename,
           attachment_mime = excluded.attachment_mime,
           attachment_processing_mode = excluded.attachment_processing_mode,
           content_type = excluded.content_type,
           last_modified = excluded.last_modified,
           updated_at = excluded.updated_at`,
        [
          chunkId,
          input.pageId,
          input.title,
          input.namespace,
          chunk.text,
          JSON.stringify(allowedGroups),
          chunk.chunkIndex ?? 0,
          chunk.totalChunks ?? input.chunks.length,
          chunk.sourceType?.trim() || 'page',
          chunk.attachmentFilename?.trim() || null,
          chunk.mimeType?.trim() || null,
          chunk.processingMode?.trim() || null,
          chunk.contentType?.trim() || null,
          input.lastModified ?? null,
          now,
        ]
      );
      await upsertPostgresTrigramChunk(client, input, chunk, now);
    }
  });

  return {
    status: 'ok',
    pageId: input.pageId,
    replacedPage: replacePage,
    chunks: input.chunks.length,
  };
}

export async function upsertSearchIndexPage(input: SearchIndexPageInput): Promise<SearchIndexWriteResult> {
  validateSearchIndexPageInput(input);
  if (isPostgresDatabase()) {
    return upsertSearchIndexPagePostgres(input);
  }
  const db = getAdminSqliteDatabase();
  const now = new Date().toISOString();
  const allowedGroups = normalizeAllowedGroups(input.allowedGroups);
  const replacePage = input.replacePage !== false;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (replacePage) {
      deleteTrigramRowsByPage(db, input.pageId);
      db.prepare('DELETE FROM ai_search_chunks WHERE page_id = ?').run(input.pageId);
    }

    const statement = db.prepare(
      `INSERT INTO ai_search_chunks
        (chunk_id, page_id, title, namespace, text, allowed_groups_json, chunk_index,
         total_chunks, source_type, attachment_filename, attachment_mime,
         attachment_processing_mode, content_type, last_modified, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         page_id = excluded.page_id,
         title = excluded.title,
         namespace = excluded.namespace,
         text = excluded.text,
         allowed_groups_json = excluded.allowed_groups_json,
         chunk_index = excluded.chunk_index,
         total_chunks = excluded.total_chunks,
         source_type = excluded.source_type,
         attachment_filename = excluded.attachment_filename,
         attachment_mime = excluded.attachment_mime,
         attachment_processing_mode = excluded.attachment_processing_mode,
         content_type = excluded.content_type,
         last_modified = excluded.last_modified,
         updated_at = excluded.updated_at`
    );

    for (const chunk of input.chunks) {
      const chunkId = String(chunk.id);
      deleteTrigramRowsByChunkIds(db, [chunkId]);
      statement.run(
        chunkId,
        input.pageId,
        input.title,
        input.namespace,
        chunk.text,
        JSON.stringify(allowedGroups),
        chunk.chunkIndex ?? 0,
        chunk.totalChunks ?? input.chunks.length,
        chunk.sourceType?.trim() || 'page',
        chunk.attachmentFilename?.trim() || null,
        chunk.mimeType?.trim() || null,
        chunk.processingMode?.trim() || null,
        chunk.contentType?.trim() || null,
        input.lastModified ?? null,
        now
      );
      upsertTrigramChunk(db, input, chunk, now);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    status: 'ok',
    pageId: input.pageId,
    replacedPage: replacePage,
    chunks: input.chunks.length,
  };
}

export async function deleteSearchIndexPage(pageId: number): Promise<SearchIndexWriteResult> {
  if (!isPositiveInteger(pageId)) {
    throw new Error('pageId must be a positive integer');
  }
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    await pg.withTransaction(async (client) => {
      await deletePostgresTrigramRowsByPage(client, pageId);
      await client.query('DELETE FROM ai_search_chunks WHERE page_id = $1', [pageId]);
    });
    return {
      status: 'ok',
      pageId,
      replacedPage: true,
      chunks: 0,
    };
  }
  const db = getAdminSqliteDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    deleteTrigramRowsByPage(db, pageId);
    db.prepare('DELETE FROM ai_search_chunks WHERE page_id = ?').run(pageId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    status: 'ok',
    pageId,
    replacedPage: true,
    chunks: 0,
  };
}

function sqliteTableHasColumns(tableName: string, columns: string[]): boolean {
  const db = getAdminSqliteDatabase();
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  return columns.every((column) => existing.has(column));
}

async function postgresTableHasColumns(tableName: string, columns: string[]): Promise<boolean> {
  const pg = await getAdminPostgresStore();
  const result = await pg.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = $1
        AND column_name = ANY($2::text[])`,
    [tableName, columns]
  );
  const existing = new Set(result.rows.map((row) => row.column_name));
  return columns.every((column) => existing.has(column));
}

export async function getSearchIndexStatus(): Promise<SearchIndexStatus> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    const attachmentColumnsReady = await postgresTableHasColumns('ai_search_chunks', REQUIRED_ATTACHMENT_COLUMNS);
    const row = (await pg.query<SearchIndexStatusRow>(
      `SELECT
         COUNT(*) AS chunks,
         COUNT(DISTINCT page_id) AS pages,
         COUNT(*) FILTER (WHERE source_type = 'attachment' OR attachment_filename IS NOT NULL) AS attachment_chunks,
         COUNT(DISTINCT page_id) FILTER (WHERE source_type = 'attachment' OR attachment_filename IS NOT NULL) AS attachment_pages,
         MAX(updated_at) AS latest_updated_at
       FROM ai_search_chunks`
    )).rows[0];
    const attachmentRows = (await pg.query<AttachmentFilenameRow>(
      `SELECT
         attachment_filename,
         COUNT(*)::int AS chunks,
         COUNT(DISTINCT page_id)::int AS pages
       FROM ai_search_chunks
       WHERE attachment_filename IS NOT NULL
       GROUP BY attachment_filename
       ORDER BY chunks DESC, attachment_filename ASC
       LIMIT 20`
    )).rows;
    const trigramRow = (await pg.query<CountRow>(
      'SELECT COUNT(*) AS count FROM ai_search_chunks_trigram'
    )).rows[0];
    const chunks = Number(row?.chunks ?? 0);
    const trigramChunks = Number(trigramRow?.count ?? 0);
    return {
      chunks,
      ftsChunks: chunks,
      trigramChunks,
      trigramFtsChunks: trigramChunks,
      attachmentChunks: Number(row?.attachment_chunks ?? 0),
      attachmentPages: Number(row?.attachment_pages ?? 0),
      attachmentFilenames: attachmentFilenameRows(attachmentRows),
      attachmentColumnsReady,
      pages: Number(row?.pages ?? 0),
      latestUpdatedAt: serializeOptionalTimestamp(row?.latest_updated_at ?? null),
      populated: chunks > 0,
      backfillRecommended: chunks === 0,
      trigramPopulated: chunks > 0 && trigramChunks >= chunks,
      trigramBackfillRecommended: chunks > 0 && trigramChunks < chunks,
    };
  }
  const db = getAdminSqliteDatabase();
  const attachmentColumnsReady = sqliteTableHasColumns('ai_search_chunks', REQUIRED_ATTACHMENT_COLUMNS);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS chunks,
         COUNT(DISTINCT page_id) AS pages,
         COUNT(CASE WHEN source_type = 'attachment' OR attachment_filename IS NOT NULL THEN 1 END) AS attachment_chunks,
         COUNT(DISTINCT CASE WHEN source_type = 'attachment' OR attachment_filename IS NOT NULL THEN page_id END) AS attachment_pages,
         MAX(updated_at) AS latest_updated_at
       FROM ai_search_chunks`
    )
    .get() as SearchIndexStatusRow | undefined;
  const attachmentRows = db
    .prepare(
      `SELECT
         attachment_filename,
         COUNT(*) AS chunks,
         COUNT(DISTINCT page_id) AS pages
       FROM ai_search_chunks
       WHERE attachment_filename IS NOT NULL
       GROUP BY attachment_filename
       ORDER BY chunks DESC, attachment_filename ASC
       LIMIT 20`
    )
    .all() as AttachmentFilenameRow[];
  const ftsRow = db
    .prepare('SELECT COUNT(*) AS count FROM ai_search_chunks_fts')
    .get() as CountRow | undefined;
  const trigramRow = db
    .prepare('SELECT COUNT(*) AS count FROM ai_search_chunks_trigram')
    .get() as CountRow | undefined;
  const trigramFtsRow = db
    .prepare('SELECT COUNT(*) AS count FROM ai_search_chunks_trigram_fts')
    .get() as CountRow | undefined;
  const chunks = Number(row?.chunks ?? 0);
  const ftsChunks = Number(ftsRow?.count ?? 0);
  const trigramChunks = Number(trigramRow?.count ?? 0);
  const trigramFtsChunks = Number(trigramFtsRow?.count ?? 0);

  return {
    chunks,
    ftsChunks,
    trigramChunks,
    trigramFtsChunks,
    attachmentChunks: Number(row?.attachment_chunks ?? 0),
    attachmentPages: Number(row?.attachment_pages ?? 0),
    attachmentFilenames: attachmentFilenameRows(attachmentRows),
    attachmentColumnsReady,
    pages: Number(row?.pages ?? 0),
    latestUpdatedAt: serializeOptionalTimestamp(row?.latest_updated_at ?? null),
    populated: chunks > 0 && ftsChunks > 0,
    backfillRecommended: chunks === 0 || ftsChunks === 0,
    trigramPopulated: chunks > 0 && trigramChunks >= chunks && trigramFtsChunks >= chunks,
    trigramBackfillRecommended: chunks > 0 && (trigramChunks < chunks || trigramFtsChunks < chunks),
  };
}

export async function getSearchIndexAttachmentDiagnostics(
  filename: string,
  limit = 5
): Promise<SearchIndexAttachmentDiagnostics> {
  const normalizedFilename = filename.trim();
  const normalizedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    const summary = (await pg.query<{ chunks: number; pages: number }>(
      `SELECT
         COUNT(*)::int AS chunks,
         COUNT(DISTINCT page_id)::int AS pages
       FROM ai_search_chunks
       WHERE LOWER(attachment_filename) = LOWER($1)`,
      [normalizedFilename]
    )).rows[0];
    const samples = (await pg.query<SearchChunkRow>(
      `SELECT
         chunk_id::text,
         page_id,
         title,
         namespace,
         text,
         allowed_groups_json,
         chunk_index,
         total_chunks,
         source_type,
         attachment_filename,
         attachment_mime,
         attachment_processing_mode,
         content_type,
         last_modified,
         0 AS lexical_rank
       FROM ai_search_chunks
       WHERE LOWER(attachment_filename) = LOWER($1)
       ORDER BY page_id ASC, chunk_index ASC
       LIMIT $2`,
      [normalizedFilename, normalizedLimit]
    )).rows;
    const chunks = Number(summary?.chunks ?? 0);
    return {
      filename: normalizedFilename,
      chunks,
      pages: Number(summary?.pages ?? 0),
      found: chunks > 0,
      samples: samples.map(rowToAttachmentDiagnosticSample),
    };
  }

  const db = getAdminSqliteDatabase();
  const summary = db
    .prepare(
      `SELECT
         COUNT(*) AS chunks,
         COUNT(DISTINCT page_id) AS pages
       FROM ai_search_chunks
       WHERE LOWER(attachment_filename) = LOWER(?)`
    )
    .get(normalizedFilename) as { chunks?: number; pages?: number } | undefined;
  const samples = db
    .prepare(
      `SELECT
         CAST(chunk_id AS TEXT) AS chunk_id,
         page_id,
         title,
         namespace,
         text,
         allowed_groups_json,
         chunk_index,
         total_chunks,
         source_type,
         attachment_filename,
         attachment_mime,
         attachment_processing_mode,
         content_type,
         last_modified,
         0 AS lexical_rank
       FROM ai_search_chunks
       WHERE LOWER(attachment_filename) = LOWER(?)
       ORDER BY page_id ASC, chunk_index ASC
       LIMIT ?`
    )
    .all(normalizedFilename, normalizedLimit) as SearchChunkRow[];
  const chunks = Number(summary?.chunks ?? 0);
  return {
    filename: normalizedFilename,
    chunks,
    pages: Number(summary?.pages ?? 0),
    found: chunks > 0,
    samples: samples.map(rowToAttachmentDiagnosticSample),
  };
}

function rowToTrigramBackfillJob(row: TrigramBackfillJobRow): TrigramBackfillJobStatus {
  const status = ['queued', 'running', 'completed', 'failed', 'canceled'].includes(row.status)
    ? row.status as TrigramBackfillJobStatusValue
    : 'failed';
  return {
    id: row.id,
    type: 'trigram',
    status,
    totalChunks: row.total_chunks,
    processedChunks: row.processed_chunks,
    writtenChunks: row.written_chunks,
    grams: row.grams,
    requestedBy: row.requested_by ?? undefined,
    startedAt: serializeTimestamp(row.started_at),
    finishedAt: serializeOptionalTimestamp(row.finished_at),
    updatedAt: serializeTimestamp(row.updated_at),
    error: row.error ?? undefined,
  };
}

async function getLatestTrigramBackfillJobRow(): Promise<TrigramBackfillJobRow | undefined> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    return (await pg.query<TrigramBackfillJobRow>(
      `SELECT id, type, status, total_chunks, processed_chunks, written_chunks, grams,
              requested_by, started_at, finished_at, updated_at, error
       FROM ai_search_backfill_jobs
       WHERE type = 'trigram'
       ORDER BY started_at DESC
       LIMIT 1`
    )).rows[0];
  }
  return getAdminSqliteDatabase()
    .prepare(
      `SELECT id, type, status, total_chunks, processed_chunks, written_chunks, grams,
              requested_by, started_at, finished_at, updated_at, error
       FROM ai_search_backfill_jobs
       WHERE type = 'trigram'
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get() as TrigramBackfillJobRow | undefined;
}

async function getTrigramBackfillJobRow(id: string): Promise<TrigramBackfillJobRow | undefined> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    return (await pg.query<TrigramBackfillJobRow>(
      `SELECT id, type, status, total_chunks, processed_chunks, written_chunks, grams,
              requested_by, started_at, finished_at, updated_at, error
       FROM ai_search_backfill_jobs
       WHERE id = $1 AND type = 'trigram'`,
      [id]
    )).rows[0];
  }
  return getAdminSqliteDatabase()
    .prepare(
      `SELECT id, type, status, total_chunks, processed_chunks, written_chunks, grams,
              requested_by, started_at, finished_at, updated_at, error
       FROM ai_search_backfill_jobs
       WHERE id = ? AND type = 'trigram'`
    )
    .get(id) as TrigramBackfillJobRow | undefined;
}

async function updateTrigramBackfillJob(
  id: string,
  patch: Partial<Omit<TrigramBackfillJobStatus, 'id' | 'type'>>
): Promise<TrigramBackfillJobStatus> {
  const currentRow = await getTrigramBackfillJobRow(id);
  if (!currentRow) throw new Error(`Trigram backfill job '${id}' not found`);
  const current = rowToTrigramBackfillJob(currentRow);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    await pg.query(
      `UPDATE ai_search_backfill_jobs
       SET status = $1,
           total_chunks = $2,
           processed_chunks = $3,
           written_chunks = $4,
           grams = $5,
           finished_at = $6,
           updated_at = $7,
           error = $8
       WHERE id = $9`,
      [
        next.status,
        next.totalChunks,
        next.processedChunks,
        next.writtenChunks,
        next.grams,
        next.finishedAt ?? null,
        next.updatedAt,
        next.error ?? null,
        id,
      ]
    );
    return next;
  }
  getAdminSqliteDatabase()
    .prepare(
      `UPDATE ai_search_backfill_jobs
       SET status = ?,
           total_chunks = ?,
           processed_chunks = ?,
           written_chunks = ?,
           grams = ?,
           finished_at = ?,
           updated_at = ?,
           error = ?
       WHERE id = ?`
    )
    .run(
      next.status,
      next.totalChunks,
      next.processedChunks,
      next.writtenChunks,
      next.grams,
      next.finishedAt ?? null,
      next.updatedAt,
      next.error ?? null,
      id
    );
  return next;
}

async function reconcileStaleTrigramBackfillJob(): Promise<void> {
  const latest = await getLatestTrigramBackfillJobRow();
  if (!latest || latest.status !== 'running') return;
  if (activeTrigramBackfillJobId === latest.id) return;
  const updatedAtMs = Date.parse(serializeTimestamp(latest.updated_at));
  if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < TRIGRAM_BACKFILL_STALE_MS) return;
  const finishedAt = new Date().toISOString();
  await updateTrigramBackfillJob(latest.id, {
    status: 'failed',
    finishedAt,
    error: 'Gateway process no longer owns this running trigram backfill job',
  });
  recordTrigramBackfillJobMetric('failed');
}

export async function getTrigramBackfillJobStatus(): Promise<TrigramBackfillJobStatus | undefined> {
  await reconcileStaleTrigramBackfillJob();
  const row = await getLatestTrigramBackfillJobRow();
  return row ? rowToTrigramBackfillJob(row) : undefined;
}

async function selectTrigramBackfillBatch(offset: number, limit: number): Promise<TrigramChunkRow[]> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    return (await pg.query<TrigramChunkRow>(
      `SELECT c.chunk_id, c.page_id, c.title, c.text
       FROM ai_search_chunks c
       ORDER BY c.updated_at ASC, c.chunk_id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )).rows;
  }
  return getAdminSqliteDatabase()
    .prepare(
      `SELECT c.chunk_id, c.page_id, c.title, c.text
       FROM ai_search_chunks c
       ORDER BY c.rowid ASC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as TrigramChunkRow[];
}

async function writeTrigramBackfillBatch(rows: TrigramChunkRow[], now: string, clearExisting: boolean): Promise<number> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    let grams = 0;
    await pg.withTransaction(async (client) => {
      if (clearExisting) {
        await client.query('DELETE FROM ai_search_chunks_trigram');
      }
      for (const row of rows) {
        grams += await upsertPostgresTrigramChunk(client, {
          pageId: row.page_id,
          title: row.title,
        }, {
          id: Number(row.chunk_id),
          text: row.text,
        }, now);
      }
    });
    return grams;
  }
  const db = getAdminSqliteDatabase();
  let grams = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (clearExisting) {
      db.prepare('DELETE FROM ai_search_chunks_trigram_fts').run();
      db.prepare('DELETE FROM ai_search_chunks_trigram').run();
    }
    for (const row of rows) {
      grams += upsertTrigramChunk(db, {
        pageId: row.page_id,
        title: row.title,
      }, {
        id: Number(row.chunk_id),
        text: row.text,
      }, now);
    }
    db.exec('COMMIT');
    return grams;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function clearTrigramIndexForBackfill(): Promise<void> {
  if (isPostgresDatabase()) {
    const pg = await getAdminPostgresStore();
    await pg.query('DELETE FROM ai_search_chunks_trigram');
    return;
  }
  const db = getAdminSqliteDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM ai_search_chunks_trigram_fts').run();
    db.prepare('DELETE FROM ai_search_chunks_trigram').run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function isTrigramBackfillJobCanceled(jobId: string): Promise<boolean> {
  if (canceledTrigramBackfillJobs.has(jobId)) return true;
  return (await getTrigramBackfillJobRow(jobId))?.status === 'canceled';
}

async function runTrigramBackfillJob(jobId: string): Promise<void> {
  let processedChunks = 0;
  let writtenChunks = 0;
  let grams = 0;
  let cleared = false;

  try {
    const started = await getTrigramBackfillJobRow(jobId);
    if (!started) throw new Error(`Trigram backfill job '${jobId}' not found`);
    const totalChunks = started.total_chunks;
    if (totalChunks === 0) {
      await clearTrigramIndexForBackfill();
      const finishedAt = new Date().toISOString();
      await updateTrigramBackfillJob(jobId, {
        status: 'completed',
        finishedAt,
      });
      recordTrigramBackfillJobMetric('completed');
      recordTrigramBackfillProgress(0);
      logOperationalEvent('info', 'trigram.backfill.completed', { jobId, totalChunks: 0 });
      return;
    }

    while (processedChunks < totalChunks) {
      if (await isTrigramBackfillJobCanceled(jobId)) {
        const finishedAt = new Date().toISOString();
        await updateTrigramBackfillJob(jobId, {
          status: 'canceled',
          processedChunks,
          writtenChunks,
          grams,
          finishedAt,
        });
        logOperationalEvent('warn', 'trigram.backfill.canceled', { jobId, processedChunks, totalChunks });
        return;
      }

      const batch = await selectTrigramBackfillBatch(processedChunks, TRIGRAM_BACKFILL_BATCH_SIZE);
      if (batch.length === 0) break;
      const now = new Date().toISOString();
      grams += await writeTrigramBackfillBatch(batch, now, !cleared);
      cleared = true;
      processedChunks += batch.length;
      writtenChunks += batch.length;
      if (await isTrigramBackfillJobCanceled(jobId)) {
        const finishedAt = new Date().toISOString();
        await updateTrigramBackfillJob(jobId, {
          status: 'canceled',
          processedChunks,
          writtenChunks,
          grams,
          finishedAt,
        });
        logOperationalEvent('warn', 'trigram.backfill.canceled', { jobId, processedChunks, totalChunks });
        return;
      }
      await updateTrigramBackfillJob(jobId, {
        status: 'running',
        processedChunks,
        writtenChunks,
        grams,
      });
      recordTrigramBackfillProgress(processedChunks);
      logOperationalEvent('info', 'trigram.backfill.progress', {
        jobId,
        processedChunks,
        totalChunks,
        grams,
      });
      await yieldToEventLoop();
    }

    const finishedAt = new Date().toISOString();
    await updateTrigramBackfillJob(jobId, {
      status: 'completed',
      processedChunks,
      writtenChunks,
      grams,
      finishedAt,
    });
    recordTrigramBackfillJobMetric('completed');
    logOperationalEvent('info', 'trigram.backfill.completed', {
      jobId,
      processedChunks,
      totalChunks,
      grams,
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    await updateTrigramBackfillJob(jobId, {
      status: 'failed',
      processedChunks,
      writtenChunks,
      grams,
      finishedAt,
      error: err instanceof Error ? err.message : 'Unknown trigram backfill error',
    });
    recordTrigramBackfillJobMetric('failed');
    logOperationalError('trigram.backfill.failed', err, { jobId, processedChunks, grams });
  } finally {
    canceledTrigramBackfillJobs.delete(jobId);
    if (activeTrigramBackfillJobId === jobId) activeTrigramBackfillJobId = undefined;
  }
}

export async function startTrigramBackfillJob(actor?: string): Promise<TrigramBackfillJobStatus> {
  await reconcileStaleTrigramBackfillJob();
  const running = isPostgresDatabase()
    ? (await (await getAdminPostgresStore()).query<TrigramBackfillJobRow>(
      `SELECT id, type, status, total_chunks, processed_chunks, written_chunks, grams,
              requested_by, started_at, finished_at, updated_at, error
       FROM ai_search_backfill_jobs
       WHERE type = 'trigram' AND status IN ('queued', 'running')
       ORDER BY started_at DESC
       LIMIT 1`
    )).rows[0]
    : getAdminSqliteDatabase()
      .prepare(
      `SELECT id, type, status, total_chunks, processed_chunks, written_chunks, grams,
              requested_by, started_at, finished_at, updated_at, error
       FROM ai_search_backfill_jobs
       WHERE type = 'trigram' AND status IN ('queued', 'running')
       ORDER BY started_at DESC
       LIMIT 1`
      )
      .get() as TrigramBackfillJobRow | undefined;
  if (running) {
    throw new Error('Trigram backfill job is already running');
  }

  const totalRow = isPostgresDatabase()
    ? (await (await getAdminPostgresStore()).query<CountRow>('SELECT COUNT(*) AS count FROM ai_search_chunks')).rows[0]
    : getAdminSqliteDatabase()
      .prepare('SELECT COUNT(*) AS count FROM ai_search_chunks')
      .get() as CountRow | undefined;
  const totalChunks = Number(totalRow?.count ?? 0);
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  if (isPostgresDatabase()) {
    await (await getAdminPostgresStore()).query(
      `INSERT INTO ai_search_backfill_jobs
         (id, type, status, total_chunks, processed_chunks, written_chunks, grams,
          requested_by, started_at, updated_at)
       VALUES ($1, 'trigram', 'running', $2, 0, 0, 0, $3, $4, $5)`,
      [jobId, totalChunks, actor ?? null, startedAt, startedAt]
    );
  } else {
    getAdminSqliteDatabase()
      .prepare(
      `INSERT INTO ai_search_backfill_jobs
         (id, type, status, total_chunks, processed_chunks, written_chunks, grams,
          requested_by, started_at, updated_at)
       VALUES (?, 'trigram', 'running', ?, 0, 0, 0, ?, ?, ?)`
      )
      .run(jobId, totalChunks, actor ?? null, startedAt, startedAt);
  }

  activeTrigramBackfillJobId = jobId;
  recordTrigramBackfillJobMetric('running');
  recordTrigramBackfillProgress(0);
  logOperationalEvent('info', 'trigram.backfill.started', {
    jobId,
    totalChunks,
    requestedBy: actor,
  });
  void runTrigramBackfillJob(jobId);

  const row = await getTrigramBackfillJobRow(jobId);
  if (!row) throw new Error(`Trigram backfill job '${jobId}' was not created`);
  return rowToTrigramBackfillJob(row);
}

export async function cancelTrigramBackfillJob(): Promise<TrigramBackfillJobStatus | undefined> {
  const latest = await getTrigramBackfillJobStatus();
  if (!latest || latest.status !== 'running') return latest;
  canceledTrigramBackfillJobs.add(latest.id);
  const finishedAt = new Date().toISOString();
  const canceled = await updateTrigramBackfillJob(latest.id, {
    status: 'canceled',
    finishedAt,
  });
  recordTrigramBackfillJobMetric('canceled');
  logOperationalEvent('warn', 'trigram.backfill.cancel_requested', { jobId: latest.id });
  return canceled;
}

export async function backfillTrigramIndex(): Promise<TrigramBackfillResult> {
  const job = await startTrigramBackfillJob();
  let status = await getTrigramBackfillJobStatus();
  while (status?.id === job.id && status.status !== 'completed' && status.status !== 'failed' && status.status !== 'canceled') {
    await yieldToEventLoop();
    status = await getTrigramBackfillJobStatus();
  }
  if (!status || status.id !== job.id) throw new Error('Trigram backfill job status disappeared');
  if (status.status === 'completed') {
    return {
      status: 'ok',
      chunks: status.writtenChunks,
      grams: status.grams,
    };
  }
  throw new Error(status.error ?? `Trigram backfill ${status.status}`);
}

export async function searchLexicalChunks(
  query: string,
  limit: number,
  minMatchedTerms = 1
): Promise<LexicalSearchChunk[]> {
  return (await searchLexicalChunksWithDiagnostics(query, limit, minMatchedTerms)).chunks;
}

export async function searchLexicalChunksWithDiagnostics(
  query: string,
  limit: number,
  minMatchedTerms = 1,
  options: LexicalSearchOptions = {}
): Promise<LexicalSearchResult> {
  const normalizedOptions = normalizeLexicalOptions(options);
  const plan = buildLexicalQueryPlan(query, normalizedOptions);
  if (!plan.ftsQuery) {
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms: 0,
      queryTerms: plan.queryTerms,
      expandedTerms: plan.expandedTerms,
      synonymTerms: plan.synonymTerms,
      transliterationTerms: plan.transliterationTerms,
      editDistanceTerms: plan.editDistanceTerms,
      ftsQuery: plan.ftsQuery,
    };
  }

  const candidateLimit = normalizeCandidateLimit(limit);
  const sqlLimit = Math.min(candidateLimit * 4, 200);
  const requiredMatchedTerms = Math.min(
    Math.max(Math.trunc(minMatchedTerms), 1),
    plan.queryTerms.length
  );
  if (isPostgresDatabase()) {
    const tsQuery = buildPostgresTsQuery(plan.expandedTerms);
    if (!tsQuery) {
      return {
        chunks: [],
        rawCandidates: 0,
        requiredMatchedTerms,
        queryTerms: plan.queryTerms,
        expandedTerms: plan.expandedTerms,
        synonymTerms: plan.synonymTerms,
        transliterationTerms: plan.transliterationTerms,
        editDistanceTerms: plan.editDistanceTerms,
        ftsQuery: plan.ftsQuery,
      };
    }
    try {
      const pg = await getAdminPostgresStore();
      const rows = (await pg.query<SearchChunkRow>(
        `SELECT
           c.chunk_id,
           c.page_id,
           c.title,
           c.namespace,
           c.text,
           c.allowed_groups_json,
           c.chunk_index,
           c.total_chunks,
           c.source_type,
           c.attachment_filename,
           c.attachment_mime,
           c.attachment_processing_mode,
           c.content_type,
           c.last_modified,
           ts_rank_cd(c.search_vector, to_tsquery('simple', $1)) AS lexical_rank
         FROM ai_search_chunks c
         WHERE c.search_vector @@ to_tsquery('simple', $1)
         ORDER BY lexical_rank DESC
         LIMIT $2`,
        [tsQuery, sqlLimit]
      )).rows;
      const chunks = rows
        .map((row) => rowToChunk(
          row,
          getMatchedTerms(row, plan.expandedTerms, normalizedOptions)
        ))
        .filter((chunk) => chunk.lexicalMatchedTermCount >= requiredMatchedTerms)
        .slice(0, candidateLimit);
      return {
        chunks,
        rawCandidates: rows.length,
        requiredMatchedTerms,
        queryTerms: plan.queryTerms,
        expandedTerms: plan.expandedTerms,
        synonymTerms: plan.synonymTerms,
        transliterationTerms: plan.transliterationTerms,
        editDistanceTerms: plan.editDistanceTerms,
        ftsQuery: plan.ftsQuery,
      };
    } catch (err) {
      console.warn('Postgres lexical search failed:', err);
      return {
        chunks: [],
        rawCandidates: 0,
        requiredMatchedTerms,
        queryTerms: plan.queryTerms,
        expandedTerms: plan.expandedTerms,
        synonymTerms: plan.synonymTerms,
        transliterationTerms: plan.transliterationTerms,
        editDistanceTerms: plan.editDistanceTerms,
        ftsQuery: plan.ftsQuery,
      };
    }
  }
  const db = getAdminSqliteDatabase();
  try {
    const rows = db
      .prepare(
        `SELECT
           c.chunk_id,
           c.page_id,
           c.title,
           c.namespace,
           c.text,
           c.allowed_groups_json,
           c.chunk_index,
           c.total_chunks,
           c.source_type,
           c.attachment_filename,
           c.attachment_mime,
           c.attachment_processing_mode,
           c.content_type,
           c.last_modified,
           bm25(ai_search_chunks_fts) AS lexical_rank
         FROM ai_search_chunks_fts
         JOIN ai_search_chunks c ON c.rowid = ai_search_chunks_fts.rowid
         WHERE ai_search_chunks_fts MATCH ?
         ORDER BY lexical_rank ASC
         LIMIT ?`
      )
      .all(plan.ftsQuery, sqlLimit) as SearchChunkRow[];
    const chunks = rows
      .map((row) => rowToChunk(
        row,
        getMatchedTerms(row, plan.expandedTerms, normalizedOptions)
      ))
      .filter((chunk) => chunk.lexicalMatchedTermCount >= requiredMatchedTerms)
      .slice(0, candidateLimit);
    return {
      chunks,
      rawCandidates: rows.length,
      requiredMatchedTerms,
      queryTerms: plan.queryTerms,
      expandedTerms: plan.expandedTerms,
      synonymTerms: plan.synonymTerms,
      transliterationTerms: plan.transliterationTerms,
      editDistanceTerms: plan.editDistanceTerms,
      ftsQuery: plan.ftsQuery,
    };
  } catch (err) {
    console.warn('SQLite FTS search failed:', err);
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms,
      queryTerms: plan.queryTerms,
      expandedTerms: plan.expandedTerms,
      synonymTerms: plan.synonymTerms,
      transliterationTerms: plan.transliterationTerms,
      editDistanceTerms: plan.editDistanceTerms,
      ftsQuery: plan.ftsQuery,
    };
  }
}

export async function searchTrigramChunksWithDiagnostics(
  query: string,
  limit: number,
  minQueryLength = 4
): Promise<TrigramSearchResult> {
  const startedAt = Date.now();
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < minQueryLength) {
    const latencyMs = Date.now() - startedAt;
    recordTrigramSearchMetrics({ result: 'skipped', latencyMs, rawCandidates: 0 });
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms: 0,
      queryTerms: [],
      ftsQuery: '',
      latencyMs,
    };
  }
  const queryTerms = buildTrigramTerms(normalizedQuery).slice(0, 80);
  const ftsQuery = queryTerms.join(' OR ');
  if (!ftsQuery) {
    const latencyMs = Date.now() - startedAt;
    recordTrigramSearchMetrics({ result: 'skipped', latencyMs, rawCandidates: 0 });
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms: 0,
      queryTerms,
      ftsQuery,
      latencyMs,
    };
  }

  const candidateLimit = normalizeCandidateLimit(limit);
  const sqlLimit = Math.min(candidateLimit * 4, 200);
  const requiredMatchedTerms = Math.min(
    Math.max(Math.ceil(queryTerms.length * 0.45), 1),
    queryTerms.length
  );
  if (isPostgresDatabase()) {
    const tsQuery = buildPostgresTsQuery(queryTerms);
    if (!tsQuery) {
      const latencyMs = Date.now() - startedAt;
      recordTrigramSearchMetrics({ result: 'skipped', latencyMs, rawCandidates: 0 });
      return {
        chunks: [],
        rawCandidates: 0,
        requiredMatchedTerms,
        queryTerms,
        ftsQuery,
        latencyMs,
      };
    }
    try {
      const pg = await getAdminPostgresStore();
      const rows = (await pg.query<SearchChunkRow>(
        `SELECT
           c.chunk_id,
           c.page_id,
           c.title,
           c.namespace,
           c.text,
           c.allowed_groups_json,
           c.chunk_index,
           c.total_chunks,
           c.source_type,
           c.attachment_filename,
           c.attachment_mime,
           c.attachment_processing_mode,
           c.content_type,
           c.last_modified,
           ts_rank_cd(to_tsvector('simple', t.grams_text), to_tsquery('simple', $1)) AS lexical_rank
         FROM ai_search_chunks_trigram t
         JOIN ai_search_chunks c ON c.chunk_id = t.chunk_id
         WHERE to_tsvector('simple', t.grams_text) @@ to_tsquery('simple', $1)
         ORDER BY lexical_rank DESC
         LIMIT $2`,
        [tsQuery, sqlLimit]
      )).rows;
      const chunks = rows
        .map((row) => {
          const matchedTerms = buildTrigramTerms(`${row.title} ${row.text}`)
            .filter((term) => queryTerms.includes(term));
          return rowToChunk(row, matchedTerms);
        })
        .filter((chunk) => chunk.lexicalMatchedTermCount >= requiredMatchedTerms)
        .slice(0, candidateLimit);
      const latencyMs = Date.now() - startedAt;
      const result = chunks.length > 0 ? 'hit' : rows.length > 0 ? 'filtered' : 'miss';
      recordTrigramSearchMetrics({ result, latencyMs, rawCandidates: rows.length });
      if (latencyMs > TRIGRAM_SLOW_SEARCH_THRESHOLD_MS) {
        logOperationalEvent('warn', 'trigram.search.slow', {
          latencyMs,
          rawCandidates: rows.length,
          candidateLimit,
          queryTerms: queryTerms.length,
        });
      }
      return {
        chunks,
        rawCandidates: rows.length,
        requiredMatchedTerms,
        queryTerms,
        ftsQuery,
        latencyMs,
      };
    } catch (err) {
      console.warn('Postgres trigram search failed:', err);
      const latencyMs = Date.now() - startedAt;
      recordTrigramSearchMetrics({ result: 'error', latencyMs, rawCandidates: 0 });
      logOperationalError('trigram.search.failed', err, { latencyMs, queryTerms: queryTerms.length });
      return {
        chunks: [],
        rawCandidates: 0,
        requiredMatchedTerms,
        queryTerms,
        ftsQuery,
        latencyMs,
      };
    }
  }
  const db = getAdminSqliteDatabase();
  try {
    const rows = db
      .prepare(
        `SELECT
           c.chunk_id,
           c.page_id,
           c.title,
           c.namespace,
           c.text,
           c.allowed_groups_json,
           c.chunk_index,
           c.total_chunks,
           c.source_type,
           c.attachment_filename,
           c.attachment_mime,
           c.attachment_processing_mode,
           c.content_type,
           c.last_modified,
           bm25(ai_search_chunks_trigram_fts) AS lexical_rank
         FROM ai_search_chunks_trigram_fts
         JOIN ai_search_chunks c ON c.chunk_id = ai_search_chunks_trigram_fts.chunk_id
         WHERE ai_search_chunks_trigram_fts MATCH ?
         ORDER BY lexical_rank ASC
         LIMIT ?`
      )
      .all(ftsQuery, sqlLimit) as SearchChunkRow[];
    const chunks = rows
      .map((row) => {
        const matchedTerms = buildTrigramTerms(`${row.title} ${row.text}`)
          .filter((term) => queryTerms.includes(term));
        return rowToChunk(row, matchedTerms);
      })
      .filter((chunk) => chunk.lexicalMatchedTermCount >= requiredMatchedTerms)
      .slice(0, candidateLimit);
    const latencyMs = Date.now() - startedAt;
    const result = chunks.length > 0 ? 'hit' : rows.length > 0 ? 'filtered' : 'miss';
    recordTrigramSearchMetrics({ result, latencyMs, rawCandidates: rows.length });
    if (latencyMs > TRIGRAM_SLOW_SEARCH_THRESHOLD_MS) {
      logOperationalEvent('warn', 'trigram.search.slow', {
        latencyMs,
        rawCandidates: rows.length,
        candidateLimit,
        queryTerms: queryTerms.length,
      });
    }

    return {
      chunks,
      rawCandidates: rows.length,
      requiredMatchedTerms,
      queryTerms,
      ftsQuery,
      latencyMs,
    };
  } catch (err) {
    console.warn('SQLite trigram FTS search failed:', err);
    const latencyMs = Date.now() - startedAt;
    recordTrigramSearchMetrics({ result: 'error', latencyMs, rawCandidates: 0 });
    logOperationalError('trigram.search.failed', err, { latencyMs, queryTerms: queryTerms.length });
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms,
      queryTerms,
      ftsQuery,
      latencyMs,
    };
  }
}
