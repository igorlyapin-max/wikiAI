import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { ADMIN_MIGRATIONS, getAdminStore, parseDatabaseUrl } from '../db/admin-store.js';
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
  pinned: number;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  metadata_json: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  sources_json: string | null;
  metadata_json: string;
  created_at: string;
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

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null | undefined): unknown[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rowToSession(row: SessionRow): ChatSessionSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: fallbackSessionTitle(row.created_at),
    userId: Number(row.user_id),
    username: row.username ?? undefined,
    status: row.status as ChatSessionStatus,
    pinned: Boolean(row.pinned),
    messageCount: Number(row.message_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
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
    createdAt: row.created_at,
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

class SqliteChatStore {
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

let chatStore: SqliteChatStore | undefined;

function getChatStore(): SqliteChatStore {
  if (chatStore) return chatStore;

  getAdminStore();
  const parsed = parseDatabaseUrl(config.databaseUrl);
  if (parsed.dialect === 'postgres') {
    throw new Error('Postgres chat store is planned by the DAL contract but is not implemented in this build');
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
