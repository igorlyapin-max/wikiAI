import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import type { ChatRetentionConfig } from '../admin-platform-config.js';
import {
  ChatRetentionLimitError,
  archiveChatSession,
  exportChatSession,
  getChatRegistryStats,
  getChatSessionMessages,
  getSqlChatHistory,
  listChatSessions,
  recordChatMessage,
  resetChatStoreForTests,
} from '../chat-store.js';

function retentionConfig(patch: Partial<ChatRetentionConfig> = {}): ChatRetentionConfig {
  return {
    retentionMode: 'archive',
    activeDays: 7,
    recentDays: 7,
    archiveDays: 365,
    maxPinnedChats: 20,
    maxActiveChats: 200,
    maxTotalChats: 1000,
    onLimitExceeded: 'delete_oldest',
    ...patch,
    exportOptions: {
      formats: patch.exportOptions?.formats ?? ['json'],
      includeMetadata: patch.exportOptions?.includeMetadata ?? true,
      includeSources: patch.exportOptions?.includeSources ?? true,
      includeMessages: patch.exportOptions?.includeMessages ?? true,
    },
  };
}

describe('chat store', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    resetAdminStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records SQL chat sessions, messages and runtime history', async () => {
    const retention = retentionConfig();

    await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-1',
      userId: 10,
      username: 'User One',
      role: 'user',
      content: 'Как подключить VPN?',
    }, retention);
    const saved = await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-1',
      userId: 10,
      username: 'User One',
      role: 'assistant',
      content: 'Используйте MFA.',
      sources: [{ pageId: 1, title: 'VPN FAQ' }],
    }, retention);

    expect(saved.session).toMatchObject({
      conversationId: 'conv-1',
      title: 'Как подключить VPN?',
      userId: 10,
      username: 'User One',
      status: 'active',
      messageCount: 2,
    });

    await expect(getSqlChatHistory('session-a', 'conv-1', 10)).resolves.toEqual([
      { role: 'user', content: 'Как подключить VPN?' },
      { role: 'assistant', content: 'Используйте MFA.' },
    ]);
    await expect(getChatSessionMessages(saved.session.id)).resolves.toHaveLength(2);
  });

  it('blocks new sessions when retention policy requires block_new', async () => {
    const retention = retentionConfig({
      maxActiveChats: 1,
      maxTotalChats: 1,
      onLimitExceeded: 'block_new',
    });

    await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-1',
      userId: 10,
      role: 'user',
      content: 'Первый чат',
    }, retention);

    await expect(recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-2',
      userId: 10,
      role: 'user',
      content: 'Второй чат',
    }, retention)).rejects.toBeInstanceOf(ChatRetentionLimitError);

    const stats = await getChatRegistryStats();
    expect(stats.active).toBe(1);
  });

  it('archives the oldest active session when active limit is exceeded', async () => {
    const retention = retentionConfig({
      retentionMode: 'archive',
      maxActiveChats: 1,
      maxTotalChats: 10,
      onLimitExceeded: 'archive_oldest',
    });

    const first = await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-1',
      userId: 10,
      role: 'user',
      content: 'Первый чат',
    }, retention);
    const second = await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-2',
      userId: 10,
      role: 'user',
      content: 'Второй чат',
    }, retention);

    expect(second.enforcement.archivedSessionIds).toContain(first.session.id);
    const sessions = await listChatSessions(undefined, 10);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: 'conv-1', status: 'archived' }),
        expect.objectContaining({ conversationId: 'conv-2', status: 'active' }),
      ])
    );
  });

  it('archives active sessions older than activeDays', async () => {
    const retention = retentionConfig({
      retentionMode: 'archive',
      activeDays: 7,
      archiveDays: 365,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const old = await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-old',
      userId: 10,
      role: 'user',
      content: 'Старый чат для архива',
    }, retention);

    vi.setSystemTime(new Date('2026-01-09T00:00:01.000Z'));
    const fresh = await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-fresh',
      userId: 10,
      role: 'user',
      content: 'Новый чат',
    }, retention);

    expect(fresh.enforcement.archivedSessionIds).toContain(old.session.id);
    const sessions = await listChatSessions(undefined, 10);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: 'conv-old', status: 'archived', title: 'Старый чат для архива' }),
        expect.objectContaining({ conversationId: 'conv-fresh', status: 'active', title: 'Новый чат' }),
      ])
    );
  });

  it('exports and manually archives a chat session', async () => {
    const retention = retentionConfig({
      retentionMode: 'export_then_archive',
      exportOptions: {
        formats: ['json', 'csv', 'html'],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    });

    const saved = await recordChatMessage({
      sessionHash: 'session-a',
      conversationId: 'conv-export',
      userId: 10,
      role: 'assistant',
      content: 'Экспортируемое сообщение',
      sources: [{ pageId: 9 }],
    }, retention);

    const exported = await exportChatSession(saved.session.id, 'json', retention);
    expect(exported.content).toContain('Экспортируемое сообщение');
    expect(exported.content).toContain('pageId');

    const archived = await archiveChatSession(saved.session.id, 'test');
    expect(archived.status).toBe('archived');
    const stats = await getChatRegistryStats();
    expect(stats.archives).toBe(1);
    expect(stats.exports).toBe(1);
  });
});
