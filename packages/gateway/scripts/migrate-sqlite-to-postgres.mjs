#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;

function readArg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function sqliteFilename(value) {
  if (!value?.startsWith('sqlite://')) return value;
  const raw = value.slice('sqlite://'.length);
  if (!raw) throw new Error('sqlite DATABASE_URL filename is empty');
  return raw;
}

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function jsonParam(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return JSON.stringify(value);
  JSON.parse(value);
  return value;
}

const tableSpecs = [
  {
    table: 'ai_admin_config',
    columns: ['area', 'key', 'value_json', 'updated_at', 'updated_by'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_audit_log',
    columns: ['id', 'actor', 'action', 'entity_type', 'entity_id', 'old_value_json', 'new_value_json', 'created_at'],
    jsonColumns: ['old_value_json', 'new_value_json'],
    resetSequence: ['ai_audit_log', 'id'],
  },
  {
    table: 'ai_prompts',
    columns: ['id', 'name', 'value_json', 'active', 'created_at', 'updated_at'],
    jsonColumns: ['value_json'],
    booleanColumns: ['active'],
  },
  {
    table: 'ai_service_config',
    columns: ['id', 'value_json', 'updated_at', 'updated_by'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_rag_config',
    columns: ['id', 'value_json', 'updated_at', 'updated_by'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_indexing_profiles',
    columns: ['id', 'name', 'value_json', 'enabled', 'created_at', 'updated_at'],
    jsonColumns: ['value_json'],
    booleanColumns: ['enabled'],
  },
  {
    table: 'ai_chat_retention_config',
    columns: ['id', 'value_json', 'updated_at', 'updated_by'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_trust_models',
    columns: ['id', 'name', 'value_json', 'active', 'created_at', 'updated_at'],
    jsonColumns: ['value_json'],
    booleanColumns: ['active'],
  },
  {
    table: 'ai_trust_entities',
    columns: ['id', 'model_id', 'entity_type', 'value_json', 'created_at', 'updated_at'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_trust_rules',
    columns: ['id', 'model_id', 'entity_id', 'value_json', 'display_order', 'created_at', 'updated_at'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_trust_scores',
    columns: ['id', 'model_id', 'page_id', 'score', 'value_json', 'calculated_at'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_smw_ontology',
    columns: [
      'id',
      'property_name',
      'value_json',
      'vector_status',
      'vector_model',
      'vector_dimension',
      'vector_generated_at',
      'created_at',
      'updated_at',
    ],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_smw_clusters',
    columns: ['id', 'value_json', 'generated_at'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_chat_sessions',
    columns: [
      'id',
      'conversation_id',
      'user_id',
      'username',
      'session_hash',
      'status',
      'pinned',
      'message_count',
      'created_at',
      'updated_at',
      'last_message_at',
      'expires_at',
      'archived_at',
      'deleted_at',
      'metadata_json',
    ],
    jsonColumns: ['metadata_json'],
    booleanColumns: ['pinned'],
  },
  {
    table: 'ai_chat_messages',
    columns: ['id', 'session_id', 'role', 'content', 'sources_json', 'metadata_json', 'created_at'],
    jsonColumns: ['sources_json', 'metadata_json'],
  },
  {
    table: 'ai_chat_archives',
    columns: ['id', 'session_id', 'value_json', 'reason', 'archived_at'],
    jsonColumns: ['value_json'],
  },
  {
    table: 'ai_chat_exports',
    columns: ['id', 'session_id', 'format', 'value_text', 'metadata_json', 'created_at'],
    jsonColumns: ['metadata_json'],
  },
  {
    table: 'ai_search_chunks',
    columns: [
      'chunk_id',
      'page_id',
      'title',
      'namespace',
      'text',
      'allowed_groups_json',
      'chunk_index',
      'total_chunks',
      'source_type',
      'attachment_filename',
      'attachment_mime',
      'attachment_processing_mode',
      'content_type',
      'last_modified',
      'updated_at',
    ],
    jsonColumns: ['allowed_groups_json'],
  },
  {
    table: 'ai_smw_autofill_fields',
    columns: [
      'page_id',
      'property_name',
      'title',
      'state',
      'current_value',
      'last_ai_value',
      'last_ai_revision_id',
      'last_user_revision_id',
      'confidence',
      'reason',
      'evidence',
      'updated_at',
    ],
  },
  {
    table: 'ai_search_chunks_trigram',
    columns: ['chunk_id', 'page_id', 'title', 'grams_text', 'updated_at'],
  },
  {
    table: 'ai_search_backfill_jobs',
    columns: [
      'id',
      'type',
      'status',
      'total_chunks',
      'processed_chunks',
      'written_chunks',
      'grams',
      'requested_by',
      'started_at',
      'finished_at',
      'updated_at',
      'error',
    ],
  },
];

function tableExists(sqlite, table) {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function readRows(sqlite, spec) {
  if (!tableExists(sqlite, spec.table)) return [];
  const available = sqlite
    .prepare(`PRAGMA table_info(${spec.table})`)
    .all()
    .map((row) => row.name);
  const columns = spec.columns.filter((column) => available.includes(column));
  if (columns.length === 0) return [];
  const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${spec.table}`).all();
  return rows.map((row) => ({ row, columns }));
}

function convertValue(spec, column, value) {
  if (spec.jsonColumns?.includes(column)) return jsonParam(value);
  if (spec.booleanColumns?.includes(column)) return Boolean(value);
  return value;
}

async function copyTable(sqlite, pool, spec) {
  const entries = readRows(sqlite, spec);
  if (entries.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { row, columns } of entries) {
      const values = columns.map((column) => convertValue(spec, column, row[column]));
      const placeholders = columns.map((column, index) => {
        const placeholder = `$${index + 1}`;
        return spec.jsonColumns?.includes(column) ? `${placeholder}::jsonb` : placeholder;
      });
      await client.query(
        `INSERT INTO ${spec.table} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT DO NOTHING`,
        values
      );
    }
    if (spec.resetSequence) {
      const [table, column] = spec.resetSequence;
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${column}) FROM ${table}), 1), true)`,
        [table, column]
      );
    }
    await client.query('COMMIT');
    return entries.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const sqliteInput = readArg('sqlite') ?? process.env.SQLITE_DATABASE_URL ?? process.env.SQLITE_PATH;
const postgresUrl = readArg('postgres') ?? process.env.POSTGRES_DATABASE_URL ?? process.env.DATABASE_URL;

const sqlitePath = sqliteFilename(required(sqliteInput, 'SQLITE_DATABASE_URL or --sqlite'));
const pgUrl = required(postgresUrl, 'POSTGRES_DATABASE_URL or --postgres');

if (!pgUrl.startsWith('postgres://') && !pgUrl.startsWith('postgresql://')) {
  throw new Error('Postgres target URL must start with postgres:// or postgresql://');
}

const sqlite = new DatabaseSync(sqlitePath);
const pool = new Pool({ connectionString: pgUrl });

try {
  const counts = {};
  for (const spec of tableSpecs) {
    counts[spec.table] = await copyTable(sqlite, pool, spec);
  }
  console.log(JSON.stringify({ status: 'ok', copied: counts }, null, 2));
} finally {
  sqlite.close();
  await pool.end();
}
