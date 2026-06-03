import { getAdminSqliteDatabase } from '../db/admin-store.js';
import { SearchChunk } from '../types/index.js';

export interface SearchIndexChunkInput {
  id: number;
  text: string;
  chunkIndex?: number;
  totalChunks?: number;
  sourceType?: string;
  attachmentFilename?: string;
}

export interface SearchIndexPageInput {
  pageId: number;
  title: string;
  namespace: number;
  allowedGroups: string[];
  lastModified?: string;
  chunks: SearchIndexChunkInput[];
  replacePage?: boolean;
}

export interface SearchIndexWriteResult {
  status: 'ok';
  pageId: number;
  replacedPage: boolean;
  chunks: number;
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
}

export interface SearchIndexStatus {
  chunks: number;
  ftsChunks: number;
  pages: number;
  latestUpdatedAt?: string;
  populated: boolean;
  backfillRecommended: boolean;
}

interface SearchChunkRow {
  chunk_id: string;
  page_id: number;
  title: string;
  namespace: number;
  text: string;
  allowed_groups_json: string;
  chunk_index: number;
  total_chunks: number;
  source_type: string;
  attachment_filename: string | null;
  last_modified: string | null;
  lexical_rank: number;
}

interface SearchIndexStatusRow {
  chunks: number;
  pages: number;
  latest_updated_at: string | null;
}

interface CountRow {
  count: number;
}

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

function parseAllowedGroups(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? normalizeAllowedGroups(parsed.filter((item): item is string => typeof item === 'string'))
      : ['*'];
  } catch {
    return ['*'];
  }
}

function tokenizeForFts(input: string): string[] {
  return input
    .toLocaleLowerCase('ru')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((term) => term.trim())
    .filter((term) => term.length >= 2) ?? [];
}

function normalizeFtsTerm(term: string): string {
  if (/^\d+$/.test(term)) return term;
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

function buildFtsTerms(input: string): string[] {
  return Array.from(new Set(tokenizeForFts(input).map(normalizeFtsTerm))).slice(0, 12);
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
  return buildFtsTerms(input)
    .map((term) => `${term}*`)
    .join(' OR ');
}

function normalizeCandidateLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function getMatchedTerms(row: Pick<SearchChunkRow, 'title' | 'text'>, queryTerms: string[]): string[] {
  const candidateTerms = tokenizeForFts(`${row.title} ${row.text}`).map(normalizeFtsTerm);
  return queryTerms.filter((queryTerm) => candidateTerms.some((term) => term.startsWith(queryTerm)));
}

function rowToChunk(row: SearchChunkRow, queryTerms: string[]): LexicalSearchChunk {
  const id = Number(row.chunk_id);
  const lexicalMatchedTerms = getMatchedTerms(row, queryTerms);
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
    chunkIndex: row.chunk_index,
    totalChunks: row.total_chunks,
    lastModified: row.last_modified ?? undefined,
    lexicalRank: row.lexical_rank,
    lexicalMatchedTerms,
    lexicalMatchedTermCount: lexicalMatchedTerms.length,
  };
}

export async function upsertSearchIndexPage(input: SearchIndexPageInput): Promise<SearchIndexWriteResult> {
  validateSearchIndexPageInput(input);
  const db = getAdminSqliteDatabase();
  const now = new Date().toISOString();
  const allowedGroups = normalizeAllowedGroups(input.allowedGroups);
  const replacePage = input.replacePage !== false;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (replacePage) {
      db.prepare('DELETE FROM ai_search_chunks WHERE page_id = ?').run(input.pageId);
    }

    const statement = db.prepare(
      `INSERT INTO ai_search_chunks
        (chunk_id, page_id, title, namespace, text, allowed_groups_json, chunk_index,
         total_chunks, source_type, attachment_filename, last_modified, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         last_modified = excluded.last_modified,
         updated_at = excluded.updated_at`
    );

    for (const chunk of input.chunks) {
      statement.run(
        String(chunk.id),
        input.pageId,
        input.title,
        input.namespace,
        chunk.text,
        JSON.stringify(allowedGroups),
        chunk.chunkIndex ?? 0,
        chunk.totalChunks ?? input.chunks.length,
        chunk.sourceType?.trim() || 'page',
        chunk.attachmentFilename?.trim() || null,
        input.lastModified ?? null,
        now
      );
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
  const db = getAdminSqliteDatabase();
  db.prepare('DELETE FROM ai_search_chunks WHERE page_id = ?').run(pageId);
  return {
    status: 'ok',
    pageId,
    replacedPage: true,
    chunks: 0,
  };
}

export async function getSearchIndexStatus(): Promise<SearchIndexStatus> {
  const db = getAdminSqliteDatabase();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS chunks,
         COUNT(DISTINCT page_id) AS pages,
         MAX(updated_at) AS latest_updated_at
       FROM ai_search_chunks`
    )
    .get() as SearchIndexStatusRow | undefined;
  const ftsRow = db
    .prepare('SELECT COUNT(*) AS count FROM ai_search_chunks_fts')
    .get() as CountRow | undefined;
  const chunks = Number(row?.chunks ?? 0);
  const ftsChunks = Number(ftsRow?.count ?? 0);

  return {
    chunks,
    ftsChunks,
    pages: Number(row?.pages ?? 0),
    latestUpdatedAt: row?.latest_updated_at ?? undefined,
    populated: chunks > 0 && ftsChunks > 0,
    backfillRecommended: chunks === 0 || ftsChunks === 0,
  };
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
  minMatchedTerms = 1
): Promise<LexicalSearchResult> {
  const queryTerms = buildFtsTerms(query);
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms: 0,
      queryTerms,
    };
  }

  const candidateLimit = normalizeCandidateLimit(limit);
  const sqlLimit = Math.min(candidateLimit * 4, 200);
  const requiredMatchedTerms = Math.min(
    Math.max(Math.trunc(minMatchedTerms), 1),
    queryTerms.length
  );
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
           c.last_modified,
           bm25(ai_search_chunks_fts) AS lexical_rank
         FROM ai_search_chunks_fts
         JOIN ai_search_chunks c ON c.rowid = ai_search_chunks_fts.rowid
         WHERE ai_search_chunks_fts MATCH ?
         ORDER BY lexical_rank ASC
         LIMIT ?`
      )
      .all(ftsQuery, sqlLimit) as SearchChunkRow[];
    const chunks = rows
      .map((row) => rowToChunk(row, queryTerms))
      .filter((chunk) => chunk.lexicalMatchedTermCount >= requiredMatchedTerms)
      .slice(0, candidateLimit);
    return {
      chunks,
      rawCandidates: rows.length,
      requiredMatchedTerms,
      queryTerms,
    };
  } catch (err) {
    console.warn('SQLite FTS search failed:', err);
    return {
      chunks: [],
      rawCandidates: 0,
      requiredMatchedTerms,
      queryTerms,
    };
  }
}
