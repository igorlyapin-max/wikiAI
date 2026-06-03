import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

export type DatabaseDialect = 'sqlite' | 'postgres';

export interface ParsedDatabaseUrl {
  dialect: DatabaseDialect;
  url: string;
  filename?: string;
  redactedUrl: string;
}

export interface AuditLogEntry {
  id: number;
  actor?: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  createdAt: string;
}

export interface AdminStoreSetOptions {
  actor?: string;
  action?: string;
  entityType?: string;
}

export interface AdminStore {
  getJson<T>(area: string, key: string): Promise<T | null>;
  setJson<T>(area: string, key: string, value: T, options?: AdminStoreSetOptions): Promise<void>;
  appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void>;
  listAuditLog(limit?: number): Promise<AuditLogEntry[]>;
  close(): void;
}

interface Migration {
  version: string;
  sqlite: string[];
  postgres: string[];
}

export const ADMIN_MIGRATIONS: Migration[] = [
  {
    version: '001_admin_platform_base',
    sqlite: [
      `CREATE TABLE IF NOT EXISTS ai_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_admin_config (
        area TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (area, key)
      )`,
      `CREATE TABLE IF NOT EXISTS ai_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        old_value_json TEXT,
        new_value_json TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_service_config (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ai_rag_config (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ai_indexing_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_chat_retention_config (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_entities (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_rules (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        entity_id TEXT,
        value_json TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_scores (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        page_id INTEGER NOT NULL,
        score REAL NOT NULL,
        value_json TEXT NOT NULL,
        calculated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_smw_ontology (
        id TEXT PRIMARY KEY,
        property_name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        vector_status TEXT NOT NULL DEFAULT 'missing',
        vector_model TEXT,
        vector_dimension INTEGER,
        vector_generated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_smw_clusters (
        id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      )`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS ai_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_admin_config (
        area TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (area, key)
      )`,
      `CREATE TABLE IF NOT EXISTS ai_audit_log (
        id BIGSERIAL PRIMARY KEY,
        actor TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        old_value_json JSONB,
        new_value_json JSONB,
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value_json JSONB NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_service_config (
        id TEXT PRIMARY KEY,
        value_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ai_rag_config (
        id TEXT PRIMARY KEY,
        value_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ai_indexing_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value_json JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_chat_retention_config (
        id TEXT PRIMARY KEY,
        value_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value_json JSONB NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_entities (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        value_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_rules (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        entity_id TEXT,
        value_json JSONB NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_trust_scores (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        page_id BIGINT NOT NULL,
        score DOUBLE PRECISION NOT NULL,
        value_json JSONB NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_smw_ontology (
        id TEXT PRIMARY KEY,
        property_name TEXT NOT NULL,
        value_json JSONB NOT NULL,
        vector_status TEXT NOT NULL DEFAULT 'missing',
        vector_model TEXT,
        vector_dimension INTEGER,
        vector_generated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_smw_clusters (
        id TEXT PRIMARY KEY,
        value_json JSONB NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL
      )`,
    ],
  },
  {
    version: '002_chat_sessions_registry',
    sqlite: [
      `CREATE TABLE IF NOT EXISTS ai_chat_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        session_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT,
        expires_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (user_id, conversation_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_status_last
        ON ai_chat_sessions (status, last_message_at)`,
      `CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources_json TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session_created
        ON ai_chat_messages (session_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS ai_chat_archives (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        reason TEXT,
        archived_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_archives_session
        ON ai_chat_archives (session_id, archived_at)`,
      `CREATE TABLE IF NOT EXISTS ai_chat_exports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        format TEXT NOT NULL,
        value_text TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_exports_session
        ON ai_chat_exports (session_id, created_at)`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS ai_chat_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        username TEXT,
        session_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_message_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        UNIQUE (user_id, conversation_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_status_last
        ON ai_chat_sessions (status, last_message_at)`,
      `CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources_json JSONB,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session_created
        ON ai_chat_messages (session_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS ai_chat_archives (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        value_json JSONB NOT NULL,
        reason TEXT,
        archived_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_archives_session
        ON ai_chat_archives (session_id, archived_at)`,
      `CREATE TABLE IF NOT EXISTS ai_chat_exports (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        format TEXT NOT NULL,
        value_text TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_chat_exports_session
        ON ai_chat_exports (session_id, created_at)`,
    ],
  },
  {
    version: '003_search_fts_index',
    sqlite: [
      `CREATE TABLE IF NOT EXISTS ai_search_chunks (
        chunk_id TEXT PRIMARY KEY,
        page_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        namespace INTEGER NOT NULL,
        text TEXT NOT NULL,
        allowed_groups_json TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        total_chunks INTEGER NOT NULL DEFAULT 1,
        source_type TEXT NOT NULL DEFAULT 'page',
        attachment_filename TEXT,
        last_modified TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_page
        ON ai_search_chunks (page_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_namespace
        ON ai_search_chunks (namespace)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS ai_search_chunks_fts USING fts5(
        title,
        text,
        content='ai_search_chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      )`,
      `CREATE TRIGGER IF NOT EXISTS ai_search_chunks_ai
        AFTER INSERT ON ai_search_chunks
        BEGIN
          INSERT INTO ai_search_chunks_fts(rowid, title, text)
          VALUES (new.rowid, new.title, new.text);
        END`,
      `CREATE TRIGGER IF NOT EXISTS ai_search_chunks_ad
        AFTER DELETE ON ai_search_chunks
        BEGIN
          INSERT INTO ai_search_chunks_fts(ai_search_chunks_fts, rowid, title, text)
          VALUES('delete', old.rowid, old.title, old.text);
        END`,
      `CREATE TRIGGER IF NOT EXISTS ai_search_chunks_au
        AFTER UPDATE ON ai_search_chunks
        BEGIN
          INSERT INTO ai_search_chunks_fts(ai_search_chunks_fts, rowid, title, text)
          VALUES('delete', old.rowid, old.title, old.text);
          INSERT INTO ai_search_chunks_fts(rowid, title, text)
          VALUES (new.rowid, new.title, new.text);
        END`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS ai_search_chunks (
        chunk_id TEXT PRIMARY KEY,
        page_id BIGINT NOT NULL,
        title TEXT NOT NULL,
        namespace INTEGER NOT NULL,
        text TEXT NOT NULL,
        allowed_groups_json JSONB NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        total_chunks INTEGER NOT NULL DEFAULT 1,
        source_type TEXT NOT NULL DEFAULT 'page',
        attachment_filename TEXT,
        last_modified TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        search_vector tsvector GENERATED ALWAYS AS (
          to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(text, ''))
        ) STORED
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_page
        ON ai_search_chunks (page_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_namespace
        ON ai_search_chunks (namespace)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_source_type
        ON ai_search_chunks (source_type)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_updated_at
        ON ai_search_chunks (updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_title
        ON ai_search_chunks (title)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_search_chunks_vector
        ON ai_search_chunks USING GIN (search_vector)`,
    ],
  },
  {
    version: '004_smw_autofill_fields',
    sqlite: [
      `CREATE TABLE IF NOT EXISTS ai_smw_autofill_fields (
        page_id INTEGER NOT NULL,
        property_name TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'auto',
        current_value TEXT,
        last_ai_value TEXT,
        last_ai_revision_id INTEGER,
        last_user_revision_id INTEGER,
        confidence REAL,
        reason TEXT,
        evidence TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (page_id, property_name)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_smw_autofill_state
        ON ai_smw_autofill_fields (state, updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_smw_autofill_title
        ON ai_smw_autofill_fields (title)`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS ai_smw_autofill_fields (
        page_id BIGINT NOT NULL,
        property_name TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'auto',
        current_value TEXT,
        last_ai_value TEXT,
        last_ai_revision_id BIGINT,
        last_user_revision_id BIGINT,
        confidence DOUBLE PRECISION,
        reason TEXT,
        evidence TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (page_id, property_name)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_smw_autofill_state
        ON ai_smw_autofill_fields (state, updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_smw_autofill_title
        ON ai_smw_autofill_fields (title)`,
    ],
  },
];

function redactUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return value;
  }
}

export function parseDatabaseUrl(databaseUrl: string): ParsedDatabaseUrl {
  if (databaseUrl.startsWith('sqlite://')) {
    const rawFilename = databaseUrl.slice('sqlite://'.length);
    if (!rawFilename) {
      throw new Error('DATABASE_URL sqlite filename is empty');
    }

    const filename = rawFilename === ':memory:' || path.isAbsolute(rawFilename)
      ? rawFilename
      : path.resolve(process.cwd(), rawFilename);

    return {
      dialect: 'sqlite',
      url: databaseUrl,
      filename,
      redactedUrl: databaseUrl,
    };
  }

  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return {
      dialect: 'postgres',
      url: databaseUrl,
      redactedUrl: redactUrlCredentials(databaseUrl),
    };
  }

  throw new Error('DATABASE_URL must start with sqlite://, postgres:// or postgresql://');
}

function parseJson(value: string | null): unknown | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export class SqliteAdminStore implements AdminStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      const directory = path.dirname(filename);
      mkdirSync(directory, { recursive: true });
    }

    this.db = new DatabaseSync(filename);
    this.runMigrations();
  }

  async getJson<T>(area: string, key: string): Promise<T | null> {
    const row = this.db
      .prepare('SELECT value_json FROM ai_admin_config WHERE area = ? AND key = ?')
      .get(area, key) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as T;
  }

  async setJson<T>(area: string, key: string, value: T, options: AdminStoreSetOptions = {}): Promise<void> {
    const now = new Date().toISOString();
    const oldRow = this.db
      .prepare('SELECT value_json FROM ai_admin_config WHERE area = ? AND key = ?')
      .get(area, key) as { value_json: string } | undefined;
    const oldValueJson = oldRow?.value_json ?? null;
    const newValueJson = JSON.stringify(value);
    const action = options.action ?? `${area}.update`;
    const entityType = options.entityType ?? area;
    const entityId = `${area}:${key}`;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO ai_admin_config (area, key, value_json, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(area, key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`
        )
        .run(area, key, newValueJson, now, options.actor ?? null);

      this.db
        .prepare(
          `INSERT INTO ai_audit_log
             (actor, action, entity_type, entity_id, old_value_json, new_value_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(options.actor ?? null, action, entityType, entityId, oldValueJson, newValueJson, now);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async listAuditLog(limit = 50): Promise<AuditLogEntry[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare(
        `SELECT id, actor, action, entity_type, entity_id, old_value_json, new_value_json, created_at
         FROM ai_audit_log
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(safeLimit) as Array<{
      id: number;
      actor: string | null;
      action: string;
      entity_type: string;
      entity_id: string;
      old_value_json: string | null;
      new_value_json: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      actor: row.actor ?? undefined,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      oldValue: parseJson(row.old_value_json),
      newValue: parseJson(row.new_value_json),
      createdAt: row.created_at,
    }));
  }

  async appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ai_audit_log
           (actor, action, entity_type, entity_id, old_value_json, new_value_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.actor ?? null,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
        entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
        new Date().toISOString()
      );
  }

  close(): void {
    this.db.close();
  }

  getDatabase(): DatabaseSync {
    return this.db;
  }

  private runMigrations(): void {
    const now = new Date().toISOString();
    for (const migration of ADMIN_MIGRATIONS) {
      for (const statement of migration.sqlite) {
        this.db.exec(statement);
      }
      this.db
        .prepare('INSERT OR IGNORE INTO ai_schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, now);
    }
  }
}

let adminStore: AdminStore | undefined;

export function getAdminStore(): AdminStore {
  if (adminStore) return adminStore;

  const parsed = parseDatabaseUrl(config.databaseUrl);
  if (parsed.dialect === 'postgres') {
    throw new Error('Postgres admin store is planned by the DAL contract but is not implemented in this build');
  }
  if (!parsed.filename) {
    throw new Error('SQLite DATABASE_URL did not resolve to a filename');
  }

  adminStore = new SqliteAdminStore(parsed.filename);
  return adminStore;
}

export function getAdminSqliteDatabase(): DatabaseSync {
  const store = getAdminStore();
  if (!(store instanceof SqliteAdminStore)) {
    throw new Error('SQLite admin database is not available for the configured admin store');
  }
  return store.getDatabase();
}

export function resetAdminStoreForTests(): void {
  adminStore?.close();
  adminStore = undefined;
}
