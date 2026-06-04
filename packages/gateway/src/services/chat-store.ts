import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import {
  ADMIN_MIGRATIONS,
  getAdminPostgresStore,
  getAdminStore,
  parseDatabaseUrl,
  type PostgresQueryClient,
} from '../db/admin-store.js';
import type { ChatExportFormat, ChatRetentionConfig } from './admin-platform-config.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const CHAT_REGISTRY_MIGRATION_VERSION = '002_chat_sessions_registry';

export type ChatSessionStatus = 'active' | 'archived' | 'deleted';
export type StoredChatRole = 'user' | 'assistant';

export interface ChatSessionSummary {
  id: string;
  conversationId: string;
  title: string;
  userId: number;
  username?: string;
  status: ChatSessionStatus;
  pinned: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  expiresAt?: string;
  archivedAt?: string;
  deletedAt?: string;
  metadata: Record<string, unknown>;
}

export interface StoredChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  sources?: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ChatRegistryStats {
  active: number;
  archived: number;
  deleted: number;
  total: number;
  messages: number;
  archives: number;
  exports: number;
  latestMessageAt?: string;
}

export interface ChatRetentionEnforcementResult {
  archivedSessionIds: string[];
  deletedSessionIds: string[];
  exportedSessionIds: string[];
}

export interface ChatMessageRecordInput {
  sessionHash: string;
  conversationId: string;
  userId: number;
  username?: string;
  role: StoredChatRole;
  content: string;
  sources?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface ChatExportResult {
  id: string;
  sessionId: string;
  format: ChatExportFormat;
  content: string;
  createdAt: string;
}

export interface ChatArchiveExportResult {
  id: string;
  userId: number;
  format: ChatExportFormat;
  sessionCount: number;
  content: string;
  createdAt: string;
}

interface SessionRow {
  id: string;
  conversation_id: string;
  user_id: number;
  username: string | null;
  status: string;
  pinned: boolean | number;
  message_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  last_message_at: Date | string | null;
  expires_at: Date | string | null;
  archived_at: Date | string | null;
  deleted_at: Date | string | null;
  metadata_json: unknown;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  sources_json: unknown;
  metadata_json: unknown;
  created_at: Date | string;
}

export class ChatRetentionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatRetentionLimitError';
  }
}

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * MILLISECONDS_PER_DAY).toISOString();
}

function subtractDays(value: Date, days: number): string {
  return new Date(value.getTime() - days * MILLISECONDS_PER_DAY).toISOString();
}

function serializeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeOptionalTimestamp(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return serializeTimestamp(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rowToSession(row: SessionRow): ChatSessionSummary {
  const createdAt = serializeTimestamp(row.created_at);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: fallbackSessionTitle(createdAt),
    userId: Number(row.user_id),
    username: row.username ?? undefined,
    status: row.status as ChatSessionStatus,
    pinned: row.pinned === true || row.pinned === 1,
    messageCount: Number(row.message_count),
    createdAt,
    updatedAt: serializeTimestamp(row.updated_at),
    lastMessageAt: serializeOptionalTimestamp(row.last_message_at),
    expiresAt: serializeOptionalTimestamp(row.expires_at),
    archivedAt: serializeOptionalTimestamp(row.archived_at),
    deletedAt: serializeOptionalTimestamp(row.deleted_at),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function fallbackSessionTitle(createdAt: string): string {
  const day = createdAt.slice(0, 10);
  return day ? `Чат от ${day}` : 'Чат';
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSessionTitle(value: string, maxLength = 80): string {
  const title = compactWhitespace(value);
  if (title.length <= maxLength) return title;
  if (maxLength <= 3) return title.slice(0, maxLength);
  return `${title.slice(0, maxLength - 3).trimEnd()}...`;
}

function rowToMessage(row: MessageRow): StoredChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    sources: parseJsonArray(row.sources_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: serializeTimestamp(row.created_at),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function runChatSchema(db: DatabaseSync): void {
  const migration = ADMIN_MIGRATIONS.find((item) => item.version === CHAT_REGISTRY_MIGRATION_VERSION);
  if (!migration) {
    throw new Error(`Missing ${CHAT_REGISTRY_MIGRATION_VERSION} migration`);
  }
  for (const statement of migration.sqlite) {
    db.exec(statement);
  }
}

interface ChatStore {
  close(): void;
  recordMessage(
    input: ChatMessageRecordInput,
    retention: ChatRetentionConfig
  ): Promise<{ session: ChatSessionSummary; enforcement: ChatRetentionEnforcementResult }> | { session: ChatSessionSummary; enforcement: ChatRetentionEnforcementResult };
  getHistory(
    sessionHash: string,
    conversationId: string,
    userId?: number
  ): Promise<Array<{ role: StoredChatRole; content: string }>> | Array<{ role: StoredChatRole; content: string }>;
  listSessions(status?: ChatSessionStatus, limit?: number): Promise<ChatSessionSummary[]> | ChatSessionSummary[];
  listSessionsForUser(userId: number, status?: ChatSessionStatus, limit?: number): Promise<ChatSessionSummary[]> | ChatSessionSummary[];
  getMessages(sessionId: string): Promise<StoredChatMessage[]> | StoredChatMessage[];
  getMessagesForUser(sessionId: string, userId: number): Promise<StoredChatMessage[]> | StoredChatMessage[];
  archiveSession(sessionId: string, reason?: string): Promise<ChatSessionSummary> | ChatSessionSummary;
  archiveSessionForUser(sessionId: string, userId: number, reason?: string): Promise<ChatSessionSummary> | ChatSessionSummary;
  exportSession(
    sessionId: string,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): Promise<ChatExportResult> | ChatExportResult;
  exportSessionForUser(
    sessionId: string,
    userId: number,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): Promise<ChatExportResult> | ChatExportResult;
  exportArchivedSessionsForUser(
    userId: number,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): Promise<ChatArchiveExportResult> | ChatArchiveExportResult;
  enforceRetention(retention: ChatRetentionConfig): Promise<ChatRetentionEnforcementResult> | ChatRetentionEnforcementResult;
  stats(): Promise<ChatRegistryStats> | ChatRegistryStats;
}

class SqliteChatStore implements ChatStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    runChatSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  recordMessage(
    input: ChatMessageRecordInput,
    retention: ChatRetentionConfig
  ): { session: ChatSessionSummary; enforcement: ChatRetentionEnforcementResult } {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = addDays(now, retention.retentionMode === 'auto_delete' ? retention.activeDays : retention.archiveDays);

    return this.withTransaction(() => {
      const enforcement: ChatRetentionEnforcementResult = {
        archivedSessionIds: [],
        deletedSessionIds: [],
        exportedSessionIds: [],
      };

      this.enforceAgeRetention(retention, now, enforcement);

      const existing = this.findSessionByUserConversation(input.userId, input.conversationId);
      const startsNewActiveSession = !existing || existing.status !== 'active';
      if (startsNewActiveSession) {
        this.prepareForNewActiveSession(retention, now, enforcement);
      }

      const sessionId = this.upsertActiveSession(input, existing, nowIso, expiresAt);
      this.db
        .prepare(
          `INSERT INTO ai_chat_messages
             (id, session_id, role, content, sources_json, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          sessionId,
          input.role,
          input.content,
          input.sources ? JSON.stringify(input.sources) : null,
          JSON.stringify(input.metadata ?? {}),
          nowIso
        );

      this.db
        .prepare(
          `UPDATE ai_chat_sessions
           SET message_count = (
             SELECT COUNT(*) FROM ai_chat_messages WHERE session_id = ?
           ),
             updated_at = ?,
             last_message_at = ?,
             expires_at = ?
           WHERE id = ?`
        )
        .run(sessionId, nowIso, nowIso, expiresAt, sessionId);

      this.enforceTotalLimit(retention, enforcement);

      const session = this.getSession(sessionId);
      if (!session) {
        throw new Error(`Chat session ${sessionId} was not found after write`);
      }
      return { session, enforcement };
    });
  }

  getHistory(sessionHash: string, conversationId: string, userId?: number): Array<{ role: StoredChatRole; content: string }> {
    const rows = userId === undefined
      ? this.db
        .prepare(
          `SELECT m.role, m.content
           FROM ai_chat_messages m
           JOIN ai_chat_sessions s ON s.id = m.session_id
           WHERE s.session_hash = ? AND s.conversation_id = ? AND s.status = 'active'
           ORDER BY m.created_at ASC`
        )
        .all(sessionHash, conversationId)
      : this.db
        .prepare(
          `SELECT m.role, m.content
           FROM ai_chat_messages m
           JOIN ai_chat_sessions s ON s.id = m.session_id
           WHERE (s.session_hash = ? OR s.user_id = ?) AND s.conversation_id = ? AND s.status = 'active'
           ORDER BY m.created_at ASC`
        )
        .all(sessionHash, userId, conversationId);

    return (rows as Array<{ role: string; content: string }>)
      .filter((row): row is { role: StoredChatRole; content: string } => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({ role: row.role, content: row.content }));
  }

  listSessions(status?: ChatSessionStatus, limit = 50): ChatSessionSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = status
      ? this.db
        .prepare(
          `SELECT * FROM ai_chat_sessions
           WHERE status = ?
           ORDER BY COALESCE(last_message_at, created_at) DESC
           LIMIT ?`
        )
        .all(status, safeLimit)
      : this.db
        .prepare(
          `SELECT * FROM ai_chat_sessions
           ORDER BY COALESCE(last_message_at, created_at) DESC
           LIMIT ?`
        )
        .all(safeLimit);

    return this.attachSessionTitles((rows as SessionRow[]).map(rowToSession));
  }

  listSessionsForUser(userId: number, status?: ChatSessionStatus, limit = 50): ChatSessionSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = status
      ? this.db
        .prepare(
          `SELECT * FROM ai_chat_sessions
           WHERE user_id = ? AND status = ?
           ORDER BY COALESCE(last_message_at, created_at) DESC
           LIMIT ?`
        )
        .all(userId, status, safeLimit)
      : this.db
        .prepare(
          `SELECT * FROM ai_chat_sessions
           WHERE user_id = ? AND status <> 'deleted'
           ORDER BY COALESCE(last_message_at, created_at) DESC
           LIMIT ?`
        )
        .all(userId, safeLimit);

    return this.attachSessionTitles((rows as SessionRow[]).map(rowToSession));
  }

  getMessages(sessionId: string): StoredChatMessage[] {
    return this.readMessages(sessionId);
  }

  getMessagesForUser(sessionId: string, userId: number): StoredChatMessage[] {
    const session = this.getOpenSessionForUser(sessionId, userId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} was not found`);
    }
    return this.readMessages(sessionId);
  }

  archiveSession(sessionId: string, reason = 'manual'): ChatSessionSummary {
    const nowIso = new Date().toISOString();
    return this.withTransaction(() => {
      this.archiveSessionInTransaction(sessionId, reason, nowIso);
      const session = this.getSession(sessionId);
      if (!session) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      return session;
    });
  }

  archiveSessionForUser(sessionId: string, userId: number, reason = 'manual'): ChatSessionSummary {
    const nowIso = new Date().toISOString();
    return this.withTransaction(() => {
      const existing = this.getOpenSessionForUser(sessionId, userId);
      if (!existing) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      this.archiveSessionInTransaction(sessionId, reason, nowIso);
      const session = this.getOpenSessionForUser(sessionId, userId);
      if (!session) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      return session;
    });
  }

  exportSession(
    sessionId: string,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): ChatExportResult {
    return this.withTransaction(() => this.exportSessionInTransaction(sessionId, format, retention, new Date().toISOString()));
  }

  exportSessionForUser(
    sessionId: string,
    userId: number,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): ChatExportResult {
    return this.withTransaction(() => {
      const existing = this.getOpenSessionForUser(sessionId, userId);
      if (!existing) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      return this.exportSessionInTransaction(sessionId, format, retention, new Date().toISOString());
    });
  }

  exportArchivedSessionsForUser(
    userId: number,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): ChatArchiveExportResult {
    return this.withTransaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      this.enforceAgeRetention(retention, now, {
        archivedSessionIds: [],
        deletedSessionIds: [],
        exportedSessionIds: [],
      });
      const rows = this.db
        .prepare(
          `SELECT * FROM ai_chat_sessions
           WHERE user_id = ? AND status = 'archived'
           ORDER BY COALESCE(archived_at, last_message_at, created_at) DESC`
        )
        .all(userId) as SessionRow[];
      const sessions = this.attachSessionTitles(rows.map(rowToSession));
      const payload = sessions.map((session) => ({
        session,
        messages: this.readMessages(session.id),
      }));
      return {
        id: randomUUID(),
        userId,
        format,
        sessionCount: sessions.length,
        content: this.renderArchiveExportContent(format, userId, payload, retention, nowIso),
        createdAt: nowIso,
      };
    });
  }

  enforceRetention(retention: ChatRetentionConfig): ChatRetentionEnforcementResult {
    return this.withTransaction(() => {
      const enforcement: ChatRetentionEnforcementResult = {
        archivedSessionIds: [],
        deletedSessionIds: [],
        exportedSessionIds: [],
      };
      this.enforceAgeRetention(retention, new Date(), enforcement);
      return enforcement;
    });
  }

  stats(): ChatRegistryStats {
    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM ai_chat_sessions GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    const stats: ChatRegistryStats = {
      active: 0,
      archived: 0,
      deleted: 0,
      total: 0,
      messages: this.countTable('ai_chat_messages'),
      archives: this.countTable('ai_chat_archives'),
      exports: this.countTable('ai_chat_exports'),
    };

    for (const row of statusRows) {
      const count = Number(row.count);
      if (row.status === 'active') stats.active = count;
      if (row.status === 'archived') stats.archived = count;
      if (row.status === 'deleted') stats.deleted = count;
      stats.total += count;
    }

    const latest = this.db
      .prepare('SELECT MAX(last_message_at) AS latest_message_at FROM ai_chat_sessions')
      .get() as { latest_message_at: string | null } | undefined;
    stats.latestMessageAt = latest?.latest_message_at ?? undefined;
    return stats;
  }

  private withTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private findSessionByUserConversation(userId: number, conversationId: string): ChatSessionSummary | undefined {
    const row = this.db
      .prepare('SELECT * FROM ai_chat_sessions WHERE user_id = ? AND conversation_id = ?')
      .get(userId, conversationId) as SessionRow | undefined;
    return row ? this.attachSessionTitle(rowToSession(row)) : undefined;
  }

  private getSession(sessionId: string): ChatSessionSummary | undefined {
    const row = this.db
      .prepare('SELECT * FROM ai_chat_sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    return row ? this.attachSessionTitle(rowToSession(row)) : undefined;
  }

  private getOpenSessionForUser(sessionId: string, userId: number): ChatSessionSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM ai_chat_sessions WHERE id = ? AND user_id = ? AND status <> 'deleted'")
      .get(sessionId, userId) as SessionRow | undefined;
    return row ? this.attachSessionTitle(rowToSession(row)) : undefined;
  }

  private attachSessionTitles(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
    return sessions.map((session) => this.attachSessionTitle(session));
  }

  private attachSessionTitle(session: ChatSessionSummary): ChatSessionSummary {
    const row = this.db
      .prepare(
        `SELECT content FROM ai_chat_messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(session.id) as { content: string } | undefined;
    return {
      ...session,
      title: row?.content ? truncateSessionTitle(row.content) : fallbackSessionTitle(session.createdAt),
    };
  }

  private upsertActiveSession(
    input: ChatMessageRecordInput,
    existing: ChatSessionSummary | undefined,
    nowIso: string,
    expiresAt: string
  ): string {
    if (!existing) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ai_chat_sessions
             (id, conversation_id, user_id, username, session_hash, status, pinned, message_count,
              created_at, updated_at, last_message_at, expires_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, NULL, ?, ?)`
        )
        .run(
          id,
          input.conversationId,
          input.userId,
          input.username ?? null,
          input.sessionHash,
          nowIso,
          nowIso,
          expiresAt,
          JSON.stringify({})
        );
      return id;
    }

    if (existing.status === 'deleted') {
      this.db
        .prepare(
          `UPDATE ai_chat_sessions
           SET username = ?,
             session_hash = ?,
             status = 'active',
             pinned = 0,
             message_count = 0,
             created_at = ?,
             updated_at = ?,
             last_message_at = NULL,
             expires_at = ?,
             archived_at = NULL,
             deleted_at = NULL,
             metadata_json = ?
           WHERE id = ?`
        )
        .run(input.username ?? null, input.sessionHash, nowIso, nowIso, expiresAt, JSON.stringify({}), existing.id);
      return existing.id;
    }

    this.db
      .prepare(
        `UPDATE ai_chat_sessions
         SET username = ?,
           session_hash = ?,
           status = 'active',
           updated_at = ?,
           expires_at = ?,
           archived_at = CASE WHEN status = 'archived' THEN NULL ELSE archived_at END
         WHERE id = ?`
      )
      .run(input.username ?? existing.username ?? null, input.sessionHash, nowIso, expiresAt, existing.id);
    return existing.id;
  }

  private enforceAgeRetention(
    retention: ChatRetentionConfig,
    now: Date,
    enforcement: ChatRetentionEnforcementResult
  ): void {
    const activeCutoff = subtractDays(now, retention.activeDays);
    const expiredActive = this.db
      .prepare(
        `SELECT id FROM ai_chat_sessions
         WHERE status = 'active' AND COALESCE(last_message_at, created_at) < ?
         ORDER BY COALESCE(last_message_at, created_at) ASC`
      )
      .all(activeCutoff) as Array<{ id: string }>;

    for (const row of expiredActive) {
      if (retention.retentionMode === 'auto_delete') {
        this.deleteSessionInTransaction(row.id, now.toISOString());
        enforcement.deletedSessionIds.push(row.id);
      } else {
        if (retention.retentionMode === 'export_then_archive') {
          for (const format of retention.exportOptions.formats) {
            this.exportSessionInTransaction(row.id, format, retention, now.toISOString());
          }
          enforcement.exportedSessionIds.push(row.id);
        }
        this.archiveSessionInTransaction(row.id, 'retention_expired', now.toISOString());
        enforcement.archivedSessionIds.push(row.id);
      }
    }

    const archiveCutoff = subtractDays(now, retention.archiveDays);
    const expiredArchived = this.db
      .prepare(
        `SELECT id FROM ai_chat_sessions
         WHERE status = 'archived' AND COALESCE(archived_at, updated_at) < ?
         ORDER BY COALESCE(archived_at, updated_at) ASC`
      )
      .all(archiveCutoff) as Array<{ id: string }>;
    for (const row of expiredArchived) {
      this.deleteSessionInTransaction(row.id, now.toISOString());
      enforcement.deletedSessionIds.push(row.id);
    }
  }

  private prepareForNewActiveSession(
    retention: ChatRetentionConfig,
    now: Date,
    enforcement: ChatRetentionEnforcementResult
  ): void {
    if (this.countSessionsByStatus('active') >= retention.maxActiveChats) {
      if (retention.onLimitExceeded === 'block_new') {
        throw new ChatRetentionLimitError('Active chat sessions limit exceeded');
      }

      while (this.countSessionsByStatus('active') >= retention.maxActiveChats) {
        const oldest = this.getOldestActiveUnpinnedSessionId();
        if (!oldest) {
          throw new ChatRetentionLimitError('Active chat sessions limit exceeded and no unpinned session can be rotated');
        }

        if (retention.onLimitExceeded === 'archive_oldest') {
          this.archiveSessionInTransaction(oldest, 'active_limit', now.toISOString());
          enforcement.archivedSessionIds.push(oldest);
        } else {
          this.deleteSessionInTransaction(oldest, now.toISOString());
          enforcement.deletedSessionIds.push(oldest);
        }
      }
    }

    if (this.countOpenSessions() >= retention.maxTotalChats) {
      if (retention.onLimitExceeded === 'block_new') {
        throw new ChatRetentionLimitError('Total chat sessions limit exceeded');
      }

      this.deleteOldestOpenSessionsUntilBelow(retention.maxTotalChats, now.toISOString(), enforcement);
    }
  }

  private enforceTotalLimit(retention: ChatRetentionConfig, enforcement: ChatRetentionEnforcementResult): void {
    if (this.countOpenSessions() <= retention.maxTotalChats) return;
    this.deleteOldestOpenSessionsUntilBelow(retention.maxTotalChats + 1, new Date().toISOString(), enforcement);
  }

  private deleteOldestOpenSessionsUntilBelow(
    maxTotal: number,
    nowIso: string,
    enforcement: ChatRetentionEnforcementResult
  ): void {
    while (this.countOpenSessions() >= maxTotal) {
      const oldest = this.getOldestOpenUnpinnedSessionId();
      if (!oldest) {
        throw new ChatRetentionLimitError('Total chat sessions limit exceeded and no unpinned session can be rotated');
      }
      this.deleteSessionInTransaction(oldest, nowIso);
      enforcement.deletedSessionIds.push(oldest);
    }
  }

  private countSessionsByStatus(status: ChatSessionStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_chat_sessions WHERE status = ?')
      .get(status) as { count: number };
    return Number(row.count);
  }

  private countOpenSessions(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM ai_chat_sessions WHERE status <> 'deleted'")
      .get() as { count: number };
    return Number(row.count);
  }

  private countTable(tableName: 'ai_chat_messages' | 'ai_chat_archives' | 'ai_chat_exports'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return Number(row.count);
  }

  private getOldestActiveUnpinnedSessionId(): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM ai_chat_sessions
         WHERE status = 'active' AND pinned = 0
         ORDER BY COALESCE(last_message_at, created_at) ASC
         LIMIT 1`
      )
      .get() as { id: string } | undefined;
    return row?.id;
  }

  private getOldestOpenUnpinnedSessionId(): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM ai_chat_sessions
         WHERE status <> 'deleted' AND pinned = 0
         ORDER BY CASE status WHEN 'archived' THEN 0 ELSE 1 END,
           COALESCE(last_message_at, created_at) ASC
         LIMIT 1`
      )
      .get() as { id: string } | undefined;
    return row?.id;
  }

  private archiveSessionInTransaction(sessionId: string, reason: string, nowIso: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} was not found`);
    }
    if (session.status === 'deleted' || session.status === 'archived') return;

    const payload = {
      session,
      messages: this.readMessages(sessionId),
      reason,
      archivedAt: nowIso,
    };
    this.db
      .prepare(
        `INSERT INTO ai_chat_archives (id, session_id, value_json, reason, archived_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), sessionId, JSON.stringify(payload), reason, nowIso);
    this.db
      .prepare(
        `UPDATE ai_chat_sessions
         SET status = 'archived', archived_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso, nowIso, sessionId);
  }

  private deleteSessionInTransaction(sessionId: string, nowIso: string): void {
    this.db.prepare('DELETE FROM ai_chat_messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM ai_chat_archives WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM ai_chat_exports WHERE session_id = ?').run(sessionId);
    this.db
      .prepare(
        `UPDATE ai_chat_sessions
         SET status = 'deleted',
           message_count = 0,
           updated_at = ?,
           deleted_at = ?,
           archived_at = NULL
         WHERE id = ?`
      )
      .run(nowIso, nowIso, sessionId);
  }

  private exportSessionInTransaction(
    sessionId: string,
    format: ChatExportFormat,
    retention: ChatRetentionConfig,
    nowIso: string
  ): ChatExportResult {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'deleted') {
      throw new Error(`Chat session ${sessionId} is unavailable for export`);
    }

    const messages = this.readMessages(sessionId);
    const content = this.renderExportContent(format, session, messages, retention);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ai_chat_exports (id, session_id, format, value_text, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        sessionId,
        format,
        content,
        JSON.stringify({
          includeMetadata: retention.exportOptions.includeMetadata,
          includeSources: retention.exportOptions.includeSources,
          includeMessages: retention.exportOptions.includeMessages,
        }),
        nowIso
      );
    return { id, sessionId, format, content, createdAt: nowIso };
  }

  private readMessages(sessionId: string): StoredChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_chat_messages
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  private renderExportContent(
    format: ChatExportFormat,
    session: ChatSessionSummary,
    messages: StoredChatMessage[],
    retention: ChatRetentionConfig
  ): string {
    const options = retention.exportOptions;
    const exportMessages = options.includeMessages
      ? messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(options.includeSources ? { sources: message.sources ?? [] } : {}),
        ...(options.includeMetadata ? { id: message.id, metadata: message.metadata } : {}),
      }))
      : [];

    if (format === 'json') {
      return JSON.stringify({
        session: options.includeMetadata
          ? session
          : {
            id: session.id,
            conversationId: session.conversationId,
            status: session.status,
            messageCount: session.messageCount,
          },
        messages: exportMessages,
      }, null, 2);
    }

    if (format === 'csv') {
      if (!options.includeMessages) {
        return [
          'session_id,conversation_id,status,message_count',
          [session.id, session.conversationId, session.status, session.messageCount].map(escapeCsv).join(','),
        ].join('\n');
      }
      const header = ['created_at', 'role', 'content'];
      if (options.includeSources) header.push('sources_json');
      const rows = exportMessages.map((message) => {
        const record = message as Record<string, unknown>;
        const columns = [record.createdAt, record.role, record.content];
        if (options.includeSources) columns.push(JSON.stringify(record.sources ?? []));
        return columns.map(escapeCsv).join(',');
      });
      return [header.join(','), ...rows].join('\n');
    }

    const messageHtml = options.includeMessages
      ? exportMessages.map((message) => {
        const record = message as Record<string, unknown>;
        const sources = options.includeSources ? `<pre>${escapeHtml(JSON.stringify(record.sources ?? [], null, 2))}</pre>` : '';
        return `<article><h3>${escapeHtml(String(record.role))}</h3><time>${escapeHtml(String(record.createdAt))}</time><p>${escapeHtml(String(record.content))}</p>${sources}</article>`;
      }).join('\n')
      : '<p>Messages were excluded by export policy.</p>';

    return [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>Chat export</title></head><body>',
      `<h1>Chat ${escapeHtml(session.conversationId)}</h1>`,
      `<p>Status: ${escapeHtml(session.status)}; messages: ${session.messageCount}</p>`,
      messageHtml,
      '</body></html>',
    ].join('\n');
  }

  private renderArchiveExportContent(
    format: ChatExportFormat,
    userId: number,
    sessions: Array<{ session: ChatSessionSummary; messages: StoredChatMessage[] }>,
    retention: ChatRetentionConfig,
    exportedAt: string
  ): string {
    const options = retention.exportOptions;
    const exportMessages = (messages: StoredChatMessage[]): Array<Record<string, unknown>> => options.includeMessages
      ? messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(options.includeSources ? { sources: message.sources ?? [] } : {}),
        ...(options.includeMetadata ? { id: message.id, metadata: message.metadata } : {}),
      }))
      : [];

    if (format === 'json') {
      return JSON.stringify({
        userId,
        exportedAt,
        sessionCount: sessions.length,
        sessions: sessions.map(({ session, messages }) => ({
          session: options.includeMetadata
            ? session
            : {
              id: session.id,
              conversationId: session.conversationId,
              title: session.title,
              status: session.status,
              messageCount: session.messageCount,
              archivedAt: session.archivedAt,
            },
          messages: exportMessages(messages),
        })),
      }, null, 2);
    }

    if (format === 'csv') {
      if (!options.includeMessages) {
        const header = 'session_id,conversation_id,title,status,message_count,archived_at';
        const rows = sessions.map(({ session }) => [
          session.id,
          session.conversationId,
          session.title,
          session.status,
          session.messageCount,
          session.archivedAt ?? '',
        ].map(escapeCsv).join(','));
        return [header, ...rows].join('\n');
      }

      const header = ['session_id', 'conversation_id', 'title', 'created_at', 'role', 'content'];
      if (options.includeSources) header.push('sources_json');
      const rows = sessions.flatMap(({ session, messages }) => exportMessages(messages).map((message) => {
        const columns = [
          session.id,
          session.conversationId,
          session.title,
          message.createdAt,
          message.role,
          message.content,
        ];
        if (options.includeSources) columns.push(JSON.stringify(message.sources ?? []));
        return columns.map(escapeCsv).join(',');
      }));
      return [header.join(','), ...rows].join('\n');
    }

    const sessionsHtml = sessions.map(({ session, messages }) => {
      const messageHtml = options.includeMessages
        ? exportMessages(messages).map((message) => {
          const sources = options.includeSources ? `<pre>${escapeHtml(JSON.stringify(message.sources ?? [], null, 2))}</pre>` : '';
          return `<article><h4>${escapeHtml(String(message.role))}</h4><time>${escapeHtml(String(message.createdAt))}</time><p>${escapeHtml(String(message.content))}</p>${sources}</article>`;
        }).join('\n')
        : '<p>Messages were excluded by export policy.</p>';
      return [
        '<section>',
        `<h2>${escapeHtml(session.title)}</h2>`,
        `<p>Status: ${escapeHtml(session.status)}; messages: ${session.messageCount}</p>`,
        messageHtml,
        '</section>',
      ].join('\n');
    }).join('\n');

    return [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>Chat archive export</title></head><body>',
      `<h1>Chat archive for user ${escapeHtml(String(userId))}</h1>`,
      `<p>Exported at: ${escapeHtml(exportedAt)}; sessions: ${sessions.length}</p>`,
      sessionsHtml,
      '</body></html>',
    ].join('\n');
  }
}

class PostgresChatStore implements ChatStore {
  close(): void {
    // The shared Postgres pool is owned by PostgresAdminStore.
  }

  async recordMessage(
    input: ChatMessageRecordInput,
    retention: ChatRetentionConfig
  ): Promise<{ session: ChatSessionSummary; enforcement: ChatRetentionEnforcementResult }> {
    const pg = await getAdminPostgresStore();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = addDays(now, retention.retentionMode === 'auto_delete' ? retention.activeDays : retention.archiveDays);

    return pg.withTransaction(async (client) => {
      const enforcement: ChatRetentionEnforcementResult = {
        archivedSessionIds: [],
        deletedSessionIds: [],
        exportedSessionIds: [],
      };

      await this.enforceAgeRetention(client, retention, now, enforcement);

      const existing = await this.findSessionByUserConversation(client, input.userId, input.conversationId);
      const startsNewActiveSession = !existing || existing.status !== 'active';
      if (startsNewActiveSession) {
        await this.prepareForNewActiveSession(client, retention, now, enforcement);
      }

      const sessionId = await this.upsertActiveSession(client, input, existing, nowIso, expiresAt);
      await client.query(
        `INSERT INTO ai_chat_messages
           (id, session_id, role, content, sources_json, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [
          randomUUID(),
          sessionId,
          input.role,
          input.content,
          input.sources ? JSON.stringify(input.sources) : null,
          JSON.stringify(input.metadata ?? {}),
          nowIso,
        ]
      );

      await client.query(
        `UPDATE ai_chat_sessions
         SET message_count = (
           SELECT COUNT(*) FROM ai_chat_messages WHERE session_id = $1
         ),
           updated_at = $2,
           last_message_at = $3,
           expires_at = $4
         WHERE id = $5`,
        [sessionId, nowIso, nowIso, expiresAt, sessionId]
      );

      await this.enforceTotalLimit(client, retention, enforcement);

      const session = await this.getSession(client, sessionId);
      if (!session) {
        throw new Error(`Chat session ${sessionId} was not found after write`);
      }
      return { session, enforcement };
    });
  }

  async getHistory(sessionHash: string, conversationId: string, userId?: number): Promise<Array<{ role: StoredChatRole; content: string }>> {
    const pg = await getAdminPostgresStore();
    const result = userId === undefined
      ? await pg.query<{ role: string; content: string }>(
        `SELECT m.role, m.content
         FROM ai_chat_messages m
         JOIN ai_chat_sessions s ON s.id = m.session_id
         WHERE s.session_hash = $1 AND s.conversation_id = $2 AND s.status = 'active'
         ORDER BY m.created_at ASC`,
        [sessionHash, conversationId]
      )
      : await pg.query<{ role: string; content: string }>(
        `SELECT m.role, m.content
         FROM ai_chat_messages m
         JOIN ai_chat_sessions s ON s.id = m.session_id
         WHERE (s.session_hash = $1 OR s.user_id = $2) AND s.conversation_id = $3 AND s.status = 'active'
         ORDER BY m.created_at ASC`,
        [sessionHash, userId, conversationId]
      );

    return result.rows
      .filter((row): row is { role: StoredChatRole; content: string } => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({ role: row.role, content: row.content }));
  }

  async listSessions(status?: ChatSessionStatus, limit = 50): Promise<ChatSessionSummary[]> {
    const pg = await getAdminPostgresStore();
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = status
      ? await pg.query<SessionRow>(
        `SELECT * FROM ai_chat_sessions
         WHERE status = $1
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT $2`,
        [status, safeLimit]
      )
      : await pg.query<SessionRow>(
        `SELECT * FROM ai_chat_sessions
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT $1`,
        [safeLimit]
      );

    return this.attachSessionTitles(pg, result.rows.map(rowToSession));
  }

  async listSessionsForUser(userId: number, status?: ChatSessionStatus, limit = 50): Promise<ChatSessionSummary[]> {
    const pg = await getAdminPostgresStore();
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = status
      ? await pg.query<SessionRow>(
        `SELECT * FROM ai_chat_sessions
         WHERE user_id = $1 AND status = $2
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT $3`,
        [userId, status, safeLimit]
      )
      : await pg.query<SessionRow>(
        `SELECT * FROM ai_chat_sessions
         WHERE user_id = $1 AND status <> 'deleted'
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT $2`,
        [userId, safeLimit]
      );

    return this.attachSessionTitles(pg, result.rows.map(rowToSession));
  }

  async getMessages(sessionId: string): Promise<StoredChatMessage[]> {
    const pg = await getAdminPostgresStore();
    return this.readMessages(pg, sessionId);
  }

  async getMessagesForUser(sessionId: string, userId: number): Promise<StoredChatMessage[]> {
    const pg = await getAdminPostgresStore();
    const session = await this.getOpenSessionForUser(pg, sessionId, userId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} was not found`);
    }
    return this.readMessages(pg, sessionId);
  }

  async archiveSession(sessionId: string, reason = 'manual'): Promise<ChatSessionSummary> {
    const pg = await getAdminPostgresStore();
    const nowIso = new Date().toISOString();
    return pg.withTransaction(async (client) => {
      await this.archiveSessionInTransaction(client, sessionId, reason, nowIso);
      const session = await this.getSession(client, sessionId);
      if (!session) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      return session;
    });
  }

  async archiveSessionForUser(sessionId: string, userId: number, reason = 'manual'): Promise<ChatSessionSummary> {
    const pg = await getAdminPostgresStore();
    const nowIso = new Date().toISOString();
    return pg.withTransaction(async (client) => {
      const existing = await this.getOpenSessionForUser(client, sessionId, userId);
      if (!existing) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      await this.archiveSessionInTransaction(client, sessionId, reason, nowIso);
      const session = await this.getOpenSessionForUser(client, sessionId, userId);
      if (!session) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      return session;
    });
  }

  async exportSession(
    sessionId: string,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): Promise<ChatExportResult> {
    const pg = await getAdminPostgresStore();
    return pg.withTransaction(async (client) => this.exportSessionInTransaction(client, sessionId, format, retention, new Date().toISOString()));
  }

  async exportSessionForUser(
    sessionId: string,
    userId: number,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): Promise<ChatExportResult> {
    const pg = await getAdminPostgresStore();
    return pg.withTransaction(async (client) => {
      const existing = await this.getOpenSessionForUser(client, sessionId, userId);
      if (!existing) {
        throw new Error(`Chat session ${sessionId} was not found`);
      }
      return this.exportSessionInTransaction(client, sessionId, format, retention, new Date().toISOString());
    });
  }

  async exportArchivedSessionsForUser(
    userId: number,
    format: ChatExportFormat,
    retention: ChatRetentionConfig
  ): Promise<ChatArchiveExportResult> {
    const pg = await getAdminPostgresStore();
    return pg.withTransaction(async (client) => {
      const now = new Date();
      const nowIso = now.toISOString();
      await this.enforceAgeRetention(client, retention, now, {
        archivedSessionIds: [],
        deletedSessionIds: [],
        exportedSessionIds: [],
      });
      const result = await client.query<SessionRow>(
        `SELECT * FROM ai_chat_sessions
         WHERE user_id = $1 AND status = 'archived'
         ORDER BY COALESCE(archived_at, last_message_at, created_at) DESC`,
        [userId]
      );
      const sessions = await this.attachSessionTitles(client, result.rows.map(rowToSession));
      const payload = await Promise.all(sessions.map(async (session) => ({
        session,
        messages: await this.readMessages(client, session.id),
      })));
      return {
        id: randomUUID(),
        userId,
        format,
        sessionCount: sessions.length,
        content: this.renderArchiveExportContent(format, userId, payload, retention, nowIso),
        createdAt: nowIso,
      };
    });
  }

  async enforceRetention(retention: ChatRetentionConfig): Promise<ChatRetentionEnforcementResult> {
    const pg = await getAdminPostgresStore();
    return pg.withTransaction(async (client) => {
      const enforcement: ChatRetentionEnforcementResult = {
        archivedSessionIds: [],
        deletedSessionIds: [],
        exportedSessionIds: [],
      };
      await this.enforceAgeRetention(client, retention, new Date(), enforcement);
      return enforcement;
    });
  }

  async stats(): Promise<ChatRegistryStats> {
    const pg = await getAdminPostgresStore();
    const statusRows = await pg.query<{ status: string; count: string | number }>(
      'SELECT status, COUNT(*) AS count FROM ai_chat_sessions GROUP BY status'
    );
    const stats: ChatRegistryStats = {
      active: 0,
      archived: 0,
      deleted: 0,
      total: 0,
      messages: await this.countTable(pg, 'ai_chat_messages'),
      archives: await this.countTable(pg, 'ai_chat_archives'),
      exports: await this.countTable(pg, 'ai_chat_exports'),
    };

    for (const row of statusRows.rows) {
      const count = Number(row.count);
      if (row.status === 'active') stats.active = count;
      if (row.status === 'archived') stats.archived = count;
      if (row.status === 'deleted') stats.deleted = count;
      stats.total += count;
    }

    const latest = await pg.query<{ latest_message_at: Date | string | null }>(
      'SELECT MAX(last_message_at) AS latest_message_at FROM ai_chat_sessions'
    );
    stats.latestMessageAt = serializeOptionalTimestamp(latest.rows[0]?.latest_message_at);
    return stats;
  }

  private async findSessionByUserConversation(
    client: PostgresQueryClient,
    userId: number,
    conversationId: string
  ): Promise<ChatSessionSummary | undefined> {
    const result = await client.query<SessionRow>(
      'SELECT * FROM ai_chat_sessions WHERE user_id = $1 AND conversation_id = $2',
      [userId, conversationId]
    );
    const row = result.rows[0];
    return row ? this.attachSessionTitle(client, rowToSession(row)) : undefined;
  }

  private async getSession(client: PostgresQueryClient, sessionId: string): Promise<ChatSessionSummary | undefined> {
    const result = await client.query<SessionRow>('SELECT * FROM ai_chat_sessions WHERE id = $1', [sessionId]);
    const row = result.rows[0];
    return row ? this.attachSessionTitle(client, rowToSession(row)) : undefined;
  }

  private async getOpenSessionForUser(
    client: PostgresQueryClient,
    sessionId: string,
    userId: number
  ): Promise<ChatSessionSummary | undefined> {
    const result = await client.query<SessionRow>(
      "SELECT * FROM ai_chat_sessions WHERE id = $1 AND user_id = $2 AND status <> 'deleted'",
      [sessionId, userId]
    );
    const row = result.rows[0];
    return row ? this.attachSessionTitle(client, rowToSession(row)) : undefined;
  }

  private async attachSessionTitles(
    client: PostgresQueryClient,
    sessions: ChatSessionSummary[]
  ): Promise<ChatSessionSummary[]> {
    return Promise.all(sessions.map((session) => this.attachSessionTitle(client, session)));
  }

  private async attachSessionTitle(
    client: PostgresQueryClient,
    session: ChatSessionSummary
  ): Promise<ChatSessionSummary> {
    const result = await client.query<{ content: string }>(
      `SELECT content FROM ai_chat_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY created_at ASC
       LIMIT 1`,
      [session.id]
    );
    return {
      ...session,
      title: result.rows[0]?.content ? truncateSessionTitle(result.rows[0].content) : fallbackSessionTitle(session.createdAt),
    };
  }

  private async upsertActiveSession(
    client: PostgresQueryClient,
    input: ChatMessageRecordInput,
    existing: ChatSessionSummary | undefined,
    nowIso: string,
    expiresAt: string
  ): Promise<string> {
    if (!existing) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO ai_chat_sessions
           (id, conversation_id, user_id, username, session_hash, status, pinned, message_count,
            created_at, updated_at, last_message_at, expires_at, metadata_json)
         VALUES ($1, $2, $3, $4, $5, 'active', FALSE, 0, $6, $7, NULL, $8, $9::jsonb)`,
        [
          id,
          input.conversationId,
          input.userId,
          input.username ?? null,
          input.sessionHash,
          nowIso,
          nowIso,
          expiresAt,
          JSON.stringify({}),
        ]
      );
      return id;
    }

    if (existing.status === 'deleted') {
      await client.query(
        `UPDATE ai_chat_sessions
         SET username = $1,
           session_hash = $2,
           status = 'active',
           pinned = FALSE,
           message_count = 0,
           created_at = $3,
           updated_at = $4,
           last_message_at = NULL,
           expires_at = $5,
           archived_at = NULL,
           deleted_at = NULL,
           metadata_json = $6::jsonb
         WHERE id = $7`,
        [input.username ?? null, input.sessionHash, nowIso, nowIso, expiresAt, JSON.stringify({}), existing.id]
      );
      return existing.id;
    }

    await client.query(
      `UPDATE ai_chat_sessions
       SET username = $1,
         session_hash = $2,
         status = 'active',
         updated_at = $3,
         expires_at = $4,
         archived_at = CASE WHEN status = 'archived' THEN NULL ELSE archived_at END
       WHERE id = $5`,
      [input.username ?? existing.username ?? null, input.sessionHash, nowIso, expiresAt, existing.id]
    );
    return existing.id;
  }

  private async enforceAgeRetention(
    client: PostgresQueryClient,
    retention: ChatRetentionConfig,
    now: Date,
    enforcement: ChatRetentionEnforcementResult
  ): Promise<void> {
    const activeCutoff = subtractDays(now, retention.activeDays);
    const expiredActive = await client.query<{ id: string }>(
      `SELECT id FROM ai_chat_sessions
       WHERE status = 'active' AND COALESCE(last_message_at, created_at) < $1
       ORDER BY COALESCE(last_message_at, created_at) ASC`,
      [activeCutoff]
    );

    for (const row of expiredActive.rows) {
      if (retention.retentionMode === 'auto_delete') {
        await this.deleteSessionInTransaction(client, row.id, now.toISOString());
        enforcement.deletedSessionIds.push(row.id);
      } else {
        if (retention.retentionMode === 'export_then_archive') {
          for (const format of retention.exportOptions.formats) {
            await this.exportSessionInTransaction(client, row.id, format, retention, now.toISOString());
          }
          enforcement.exportedSessionIds.push(row.id);
        }
        await this.archiveSessionInTransaction(client, row.id, 'retention_expired', now.toISOString());
        enforcement.archivedSessionIds.push(row.id);
      }
    }

    const archiveCutoff = subtractDays(now, retention.archiveDays);
    const expiredArchived = await client.query<{ id: string }>(
      `SELECT id FROM ai_chat_sessions
       WHERE status = 'archived' AND COALESCE(archived_at, updated_at) < $1
       ORDER BY COALESCE(archived_at, updated_at) ASC`,
      [archiveCutoff]
    );
    for (const row of expiredArchived.rows) {
      await this.deleteSessionInTransaction(client, row.id, now.toISOString());
      enforcement.deletedSessionIds.push(row.id);
    }
  }

  private async prepareForNewActiveSession(
    client: PostgresQueryClient,
    retention: ChatRetentionConfig,
    now: Date,
    enforcement: ChatRetentionEnforcementResult
  ): Promise<void> {
    if (await this.countSessionsByStatus(client, 'active') >= retention.maxActiveChats) {
      if (retention.onLimitExceeded === 'block_new') {
        throw new ChatRetentionLimitError('Active chat sessions limit exceeded');
      }

      while (await this.countSessionsByStatus(client, 'active') >= retention.maxActiveChats) {
        const oldest = await this.getOldestActiveUnpinnedSessionId(client);
        if (!oldest) {
          throw new ChatRetentionLimitError('Active chat sessions limit exceeded and no unpinned session can be rotated');
        }

        if (retention.onLimitExceeded === 'archive_oldest') {
          await this.archiveSessionInTransaction(client, oldest, 'active_limit', now.toISOString());
          enforcement.archivedSessionIds.push(oldest);
        } else {
          await this.deleteSessionInTransaction(client, oldest, now.toISOString());
          enforcement.deletedSessionIds.push(oldest);
        }
      }
    }

    if (await this.countOpenSessions(client) >= retention.maxTotalChats) {
      if (retention.onLimitExceeded === 'block_new') {
        throw new ChatRetentionLimitError('Total chat sessions limit exceeded');
      }

      await this.deleteOldestOpenSessionsUntilBelow(client, retention.maxTotalChats, now.toISOString(), enforcement);
    }
  }

  private async enforceTotalLimit(
    client: PostgresQueryClient,
    retention: ChatRetentionConfig,
    enforcement: ChatRetentionEnforcementResult
  ): Promise<void> {
    if (await this.countOpenSessions(client) <= retention.maxTotalChats) return;
    await this.deleteOldestOpenSessionsUntilBelow(client, retention.maxTotalChats + 1, new Date().toISOString(), enforcement);
  }

  private async deleteOldestOpenSessionsUntilBelow(
    client: PostgresQueryClient,
    maxTotal: number,
    nowIso: string,
    enforcement: ChatRetentionEnforcementResult
  ): Promise<void> {
    while (await this.countOpenSessions(client) >= maxTotal) {
      const oldest = await this.getOldestOpenUnpinnedSessionId(client);
      if (!oldest) {
        throw new ChatRetentionLimitError('Total chat sessions limit exceeded and no unpinned session can be rotated');
      }
      await this.deleteSessionInTransaction(client, oldest, nowIso);
      enforcement.deletedSessionIds.push(oldest);
    }
  }

  private async countSessionsByStatus(client: PostgresQueryClient, status: ChatSessionStatus): Promise<number> {
    const result = await client.query<{ count: string | number }>(
      'SELECT COUNT(*) AS count FROM ai_chat_sessions WHERE status = $1',
      [status]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async countOpenSessions(client: PostgresQueryClient): Promise<number> {
    const result = await client.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM ai_chat_sessions WHERE status <> 'deleted'"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async countTable(
    client: PostgresQueryClient,
    tableName: 'ai_chat_messages' | 'ai_chat_archives' | 'ai_chat_exports'
  ): Promise<number> {
    const result = await client.query<{ count: string | number }>(`SELECT COUNT(*) AS count FROM ${tableName}`);
    return Number(result.rows[0]?.count ?? 0);
  }

  private async getOldestActiveUnpinnedSessionId(client: PostgresQueryClient): Promise<string | undefined> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM ai_chat_sessions
       WHERE status = 'active' AND pinned = FALSE
       ORDER BY COALESCE(last_message_at, created_at) ASC
       LIMIT 1`
    );
    return result.rows[0]?.id;
  }

  private async getOldestOpenUnpinnedSessionId(client: PostgresQueryClient): Promise<string | undefined> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM ai_chat_sessions
       WHERE status <> 'deleted' AND pinned = FALSE
       ORDER BY CASE status WHEN 'archived' THEN 0 ELSE 1 END,
         COALESCE(last_message_at, created_at) ASC
       LIMIT 1`
    );
    return result.rows[0]?.id;
  }

  private async archiveSessionInTransaction(
    client: PostgresQueryClient,
    sessionId: string,
    reason: string,
    nowIso: string
  ): Promise<void> {
    const session = await this.getSession(client, sessionId);
    if (!session) {
      throw new Error(`Chat session ${sessionId} was not found`);
    }
    if (session.status === 'deleted' || session.status === 'archived') return;

    const payload = {
      session,
      messages: await this.readMessages(client, sessionId),
      reason,
      archivedAt: nowIso,
    };
    await client.query(
      `INSERT INTO ai_chat_archives (id, session_id, value_json, reason, archived_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [randomUUID(), sessionId, JSON.stringify(payload), reason, nowIso]
    );
    await client.query(
      `UPDATE ai_chat_sessions
       SET status = 'archived', archived_at = $1, updated_at = $2
       WHERE id = $3`,
      [nowIso, nowIso, sessionId]
    );
  }

  private async deleteSessionInTransaction(client: PostgresQueryClient, sessionId: string, nowIso: string): Promise<void> {
    await client.query('DELETE FROM ai_chat_messages WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM ai_chat_archives WHERE session_id = $1', [sessionId]);
    await client.query('DELETE FROM ai_chat_exports WHERE session_id = $1', [sessionId]);
    await client.query(
      `UPDATE ai_chat_sessions
       SET status = 'deleted',
         message_count = 0,
         updated_at = $1,
         deleted_at = $2,
         archived_at = NULL
       WHERE id = $3`,
      [nowIso, nowIso, sessionId]
    );
  }

  private async exportSessionInTransaction(
    client: PostgresQueryClient,
    sessionId: string,
    format: ChatExportFormat,
    retention: ChatRetentionConfig,
    nowIso: string
  ): Promise<ChatExportResult> {
    const session = await this.getSession(client, sessionId);
    if (!session || session.status === 'deleted') {
      throw new Error(`Chat session ${sessionId} is unavailable for export`);
    }

    const messages = await this.readMessages(client, sessionId);
    const content = this.renderExportContent(format, session, messages, retention);
    const id = randomUUID();
    await client.query(
      `INSERT INTO ai_chat_exports (id, session_id, format, value_text, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        id,
        sessionId,
        format,
        content,
        JSON.stringify({
          includeMetadata: retention.exportOptions.includeMetadata,
          includeSources: retention.exportOptions.includeSources,
          includeMessages: retention.exportOptions.includeMessages,
        }),
        nowIso,
      ]
    );
    return { id, sessionId, format, content, createdAt: nowIso };
  }

  private async readMessages(client: PostgresQueryClient, sessionId: string): Promise<StoredChatMessage[]> {
    const result = await client.query<MessageRow>(
      `SELECT * FROM ai_chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );
    return result.rows.map(rowToMessage);
  }

  private renderExportContent(
    format: ChatExportFormat,
    session: ChatSessionSummary,
    messages: StoredChatMessage[],
    retention: ChatRetentionConfig
  ): string {
    const options = retention.exportOptions;
    const exportMessages = options.includeMessages
      ? messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(options.includeSources ? { sources: message.sources ?? [] } : {}),
        ...(options.includeMetadata ? { id: message.id, metadata: message.metadata } : {}),
      }))
      : [];

    if (format === 'json') {
      return JSON.stringify({
        session: options.includeMetadata
          ? session
          : {
            id: session.id,
            conversationId: session.conversationId,
            status: session.status,
            messageCount: session.messageCount,
          },
        messages: exportMessages,
      }, null, 2);
    }

    if (format === 'csv') {
      if (!options.includeMessages) {
        return [
          'session_id,conversation_id,status,message_count',
          [session.id, session.conversationId, session.status, session.messageCount].map(escapeCsv).join(','),
        ].join('\n');
      }
      const header = ['created_at', 'role', 'content'];
      if (options.includeSources) header.push('sources_json');
      const rows = exportMessages.map((message) => {
        const record = message as Record<string, unknown>;
        const columns = [record.createdAt, record.role, record.content];
        if (options.includeSources) columns.push(JSON.stringify(record.sources ?? []));
        return columns.map(escapeCsv).join(',');
      });
      return [header.join(','), ...rows].join('\n');
    }

    const messageHtml = options.includeMessages
      ? exportMessages.map((message) => {
        const record = message as Record<string, unknown>;
        const sources = options.includeSources ? `<pre>${escapeHtml(JSON.stringify(record.sources ?? [], null, 2))}</pre>` : '';
        return `<article><h3>${escapeHtml(String(record.role))}</h3><time>${escapeHtml(String(record.createdAt))}</time><p>${escapeHtml(String(record.content))}</p>${sources}</article>`;
      }).join('\n')
      : '<p>Messages were excluded by export policy.</p>';

    return [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>Chat export</title></head><body>',
      `<h1>Chat ${escapeHtml(session.conversationId)}</h1>`,
      `<p>Status: ${escapeHtml(session.status)}; messages: ${session.messageCount}</p>`,
      messageHtml,
      '</body></html>',
    ].join('\n');
  }

  private renderArchiveExportContent(
    format: ChatExportFormat,
    userId: number,
    sessions: Array<{ session: ChatSessionSummary; messages: StoredChatMessage[] }>,
    retention: ChatRetentionConfig,
    exportedAt: string
  ): string {
    const options = retention.exportOptions;
    const exportMessages = (messages: StoredChatMessage[]): Array<Record<string, unknown>> => options.includeMessages
      ? messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(options.includeSources ? { sources: message.sources ?? [] } : {}),
        ...(options.includeMetadata ? { id: message.id, metadata: message.metadata } : {}),
      }))
      : [];

    if (format === 'json') {
      return JSON.stringify({
        userId,
        exportedAt,
        sessionCount: sessions.length,
        sessions: sessions.map(({ session, messages }) => ({
          session: options.includeMetadata
            ? session
            : {
              id: session.id,
              conversationId: session.conversationId,
              title: session.title,
              status: session.status,
              messageCount: session.messageCount,
              archivedAt: session.archivedAt,
            },
          messages: exportMessages(messages),
        })),
      }, null, 2);
    }

    if (format === 'csv') {
      if (!options.includeMessages) {
        const header = 'session_id,conversation_id,title,status,message_count,archived_at';
        const rows = sessions.map(({ session }) => [
          session.id,
          session.conversationId,
          session.title,
          session.status,
          session.messageCount,
          session.archivedAt ?? '',
        ].map(escapeCsv).join(','));
        return [header, ...rows].join('\n');
      }

      const header = ['session_id', 'conversation_id', 'title', 'created_at', 'role', 'content'];
      if (options.includeSources) header.push('sources_json');
      const rows = sessions.flatMap(({ session, messages }) => exportMessages(messages).map((message) => {
        const columns = [
          session.id,
          session.conversationId,
          session.title,
          message.createdAt,
          message.role,
          message.content,
        ];
        if (options.includeSources) columns.push(JSON.stringify(message.sources ?? []));
        return columns.map(escapeCsv).join(',');
      }));
      return [header.join(','), ...rows].join('\n');
    }

    const sessionsHtml = sessions.map(({ session, messages }) => {
      const messageHtml = options.includeMessages
        ? exportMessages(messages).map((message) => {
          const sources = options.includeSources ? `<pre>${escapeHtml(JSON.stringify(message.sources ?? [], null, 2))}</pre>` : '';
          return `<article><h4>${escapeHtml(String(message.role))}</h4><time>${escapeHtml(String(message.createdAt))}</time><p>${escapeHtml(String(message.content))}</p>${sources}</article>`;
        }).join('\n')
        : '<p>Messages were excluded by export policy.</p>';
      return [
        '<section>',
        `<h2>${escapeHtml(session.title)}</h2>`,
        `<p>Status: ${escapeHtml(session.status)}; messages: ${session.messageCount}</p>`,
        messageHtml,
        '</section>',
      ].join('\n');
    }).join('\n');

    return [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>Chat archive export</title></head><body>',
      `<h1>Chat archive for user ${escapeHtml(String(userId))}</h1>`,
      `<p>Exported at: ${escapeHtml(exportedAt)}; sessions: ${sessions.length}</p>`,
      sessionsHtml,
      '</body></html>',
    ].join('\n');
  }
}

let chatStore: ChatStore | undefined;

function getChatStore(): ChatStore {
  if (chatStore) return chatStore;

  getAdminStore();
  const parsed = parseDatabaseUrl(config.databaseUrl);
  if (parsed.dialect === 'postgres') {
    chatStore = new PostgresChatStore();
    return chatStore;
  }
  if (!parsed.filename) {
    throw new Error('SQLite DATABASE_URL did not resolve to a filename');
  }

  chatStore = new SqliteChatStore(parsed.filename);
  return chatStore;
}

export function resetChatStoreForTests(): void {
  chatStore?.close();
  chatStore = undefined;
}

export async function recordChatMessage(
  input: ChatMessageRecordInput,
  retention: ChatRetentionConfig
): Promise<{ session: ChatSessionSummary; enforcement: ChatRetentionEnforcementResult }> {
  return getChatStore().recordMessage(input, retention);
}

export async function getSqlChatHistory(
  sessionHash: string,
  conversationId: string,
  userId?: number
): Promise<Array<{ role: StoredChatRole; content: string }>> {
  return getChatStore().getHistory(sessionHash, conversationId, userId);
}

export async function listChatSessions(status?: ChatSessionStatus, limit?: number): Promise<ChatSessionSummary[]> {
  return getChatStore().listSessions(status, limit);
}

export async function listUserChatSessions(
  userId: number,
  status?: ChatSessionStatus,
  limit?: number
): Promise<ChatSessionSummary[]> {
  return getChatStore().listSessionsForUser(userId, status, limit);
}

export async function getChatSessionMessages(sessionId: string): Promise<StoredChatMessage[]> {
  return getChatStore().getMessages(sessionId);
}

export async function getUserChatSessionMessages(sessionId: string, userId: number): Promise<StoredChatMessage[]> {
  return getChatStore().getMessagesForUser(sessionId, userId);
}

export async function archiveChatSession(sessionId: string, reason?: string): Promise<ChatSessionSummary> {
  return getChatStore().archiveSession(sessionId, reason);
}

export async function archiveUserChatSession(
  sessionId: string,
  userId: number,
  reason?: string
): Promise<ChatSessionSummary> {
  return getChatStore().archiveSessionForUser(sessionId, userId, reason);
}

export async function exportChatSession(
  sessionId: string,
  format: ChatExportFormat,
  retention: ChatRetentionConfig
): Promise<ChatExportResult> {
  return getChatStore().exportSession(sessionId, format, retention);
}

export async function exportUserChatSession(
  sessionId: string,
  userId: number,
  format: ChatExportFormat,
  retention: ChatRetentionConfig
): Promise<ChatExportResult> {
  return getChatStore().exportSessionForUser(sessionId, userId, format, retention);
}

export async function exportUserChatArchive(
  userId: number,
  format: ChatExportFormat,
  retention: ChatRetentionConfig
): Promise<ChatArchiveExportResult> {
  return getChatStore().exportArchivedSessionsForUser(userId, format, retention);
}

export async function enforceChatRetention(
  retention: ChatRetentionConfig
): Promise<ChatRetentionEnforcementResult> {
  return getChatStore().enforceRetention(retention);
}

export async function getChatRegistryStats(): Promise<ChatRegistryStats> {
  return getChatStore().stats();
}
