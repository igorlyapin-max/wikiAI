import { afterEach, describe, expect, it, vi } from 'vitest';

const pgConnect = vi.hoisted(() => vi.fn());
const pgPoolQuery = vi.hoisted(() => vi.fn());
const pgPoolEnd = vi.hoisted(() => vi.fn());

vi.mock('pg', () => ({
  Pool: vi.fn(function Pool() {
    return {
      connect: pgConnect,
      query: pgPoolQuery,
      end: pgPoolEnd,
    };
  }),
}));

import {
  ADMIN_MIGRATIONS,
  PostgresAdminStore,
  parseDatabaseUrl,
  resetAdminStoreForTests,
  SqliteAdminStore,
} from '../admin-store.js';

describe('admin store', () => {
  afterEach(() => {
    resetAdminStoreForTests();
    pgConnect.mockReset();
    pgPoolQuery.mockReset();
    pgPoolEnd.mockReset();
  });

  it('parses sqlite and postgres DATABASE_URL values', () => {
    expect(parseDatabaseUrl('sqlite://:memory:')).toMatchObject({
      dialect: 'sqlite',
      filename: ':memory:',
    });

    expect(parseDatabaseUrl('postgres://user:secret@db.local/wiki_ai')).toMatchObject({
      dialect: 'postgres',
      redactedUrl: 'postgres://***:***@db.local/wiki_ai',
    });
  });

  it('keeps sqlite and postgres migration definitions aligned', () => {
    for (const migration of ADMIN_MIGRATIONS) {
      expect(migration.sqlite.length).toBe(migration.postgres.length);
      expect(migration.sqlite.length).toBeGreaterThan(0);
    }
  });

  it('stores JSON values and writes audit log entries', async () => {
    const store = new SqliteAdminStore(':memory:');

    await store.setJson('service-config', 'default', { llm: { model: 'test-model' } }, {
      actor: 'Admin',
      action: 'service-config.update',
      entityType: 'service-config',
    });

    await expect(store.getJson('service-config', 'default')).resolves.toEqual({
      llm: { model: 'test-model' },
    });
    await store.appendAuditLog({
      actor: 'Admin',
      action: 'chat-session.archive',
      entityType: 'chat-sessions',
      entityId: 'chat-1',
      newValue: { reason: 'test' },
    });

    const audit = await store.listAuditLog();
    expect(audit[0]).toMatchObject({
      actor: 'Admin',
      action: 'chat-session.archive',
      entityType: 'chat-sessions',
      entityId: 'chat-1',
      newValue: { reason: 'test' },
    });
    expect(audit[1]).toMatchObject({
      actor: 'Admin',
      action: 'service-config.update',
      entityType: 'service-config',
      entityId: 'service-config:default',
      newValue: { llm: { model: 'test-model' } },
    });

    store.close();
  });

  it('runs postgres migrations and reads JSONB values through pg pool', async () => {
    const migrationClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    pgConnect.mockResolvedValueOnce(migrationClient);
    pgPoolQuery.mockResolvedValueOnce({
      rows: [{ value_json: { llm: { model: 'pg-model' } } }],
      rowCount: 1,
    });

    const store = new PostgresAdminStore('postgres://user:secret@db.local/wiki_ai');
    await store.waitUntilReady();

    expect(migrationClient.query).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS ai_schema_migrations'));
    expect(migrationClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ai_schema_migrations'),
      expect.arrayContaining(['001_admin_platform_base'])
    );
    await expect(store.getJson('service-config', 'default')).resolves.toEqual({
      llm: { model: 'pg-model' },
    });

    store.close();
    expect(pgPoolEnd).toHaveBeenCalled();
  });
});
