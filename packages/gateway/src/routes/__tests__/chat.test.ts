import Fastify, { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRoutes } from '../chat.js';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import {
  getDefaultRetrievalProfiles,
  setChatRetentionAdminConfig,
  upsertRetrievalProfile,
} from '../../services/admin-platform-config.js';
import { setMediaWikiProfileConfig } from '../../services/mediawiki-profile-config.js';
import { getSqlChatHistory, recordChatMessage, resetChatStoreForTests } from '../../services/chat-store.js';
import { SearchChunk } from '../../types/index.js';

const redisStore = vi.hoisted(() => new Map<string, string>());
const appendCalls = vi.hoisted(() => [] as Array<{
  sessionId: string;
  conversationId: string;
  ttl: number;
  message: { role: string; content: string };
}>);
const getEmbedding = vi.hoisted(() => vi.fn());
const searchRagChunks = vi.hoisted(() => vi.fn());
const filterReadableChunks = vi.hoisted(() => vi.fn());
const callLiteLLM = vi.hoisted(() => vi.fn());
const detectConflictsForChat = vi.hoisted(() => vi.fn());
const buildConflictInstruction = vi.hoisted(() => vi.fn());
const fetchUserInfo = vi.hoisted(() => vi.fn(async () => ({
  username: 'ChatUser',
  userId: 77,
  groups: ['user', 'ai-it'],
})));

vi.mock('../../services/mediawiki.js', () => ({
  fetchUserInfo,
}));

vi.mock('../../services/redis.js', () => ({
  getCachedUserInfo: vi.fn(async () => null),
  cacheUserInfo: vi.fn(async () => undefined),
  getCachedUserGroups: vi.fn(async () => null),
  cacheUserGroups: vi.fn(async () => undefined),
  getChatHistory: vi.fn(async (sessionId: string, conversationId: string) => {
    const raw = redisStore.get(`chat:${sessionId}:${conversationId}`);
    return raw ? JSON.parse(raw) : [];
  }),
  appendChatMessage: vi.fn(async (
    sessionId: string,
    conversationId: string,
    message: { role: string; content: string },
    ttl: number
  ) => {
    const key = `chat:${sessionId}:${conversationId}`;
    const raw = redisStore.get(key);
    const history = raw ? JSON.parse(raw) as Array<{ role: string; content: string }> : [];
    history.push(message);
    redisStore.set(key, JSON.stringify(history));
    appendCalls.push({ sessionId, conversationId, message, ttl });
  }),
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    }),
    ping: vi.fn(async () => 'PONG'),
    quit: vi.fn(async () => 'OK'),
  },
}));

vi.mock('../../services/embedding.js', () => ({
  getEmbedding,
}));

vi.mock('../../services/hybrid-search.js', () => ({
  searchRagChunks,
}));

vi.mock('../../services/acl.js', () => ({
  filterReadableChunks,
  filterReadableChunksForPrincipal: vi.fn(async (chunks: SearchChunk[]) => chunks),
}));

vi.mock('../../services/litellm.js', () => ({
  callLiteLLM,
  streamChatCompletion: vi.fn(async function* streamChatCompletion() {
    yield {
      choices: [
        {
          delta: { content: 'stream answer' },
          index: 0,
          finish_reason: null,
        },
      ],
    };
  }),
}));

vi.mock('../../services/conflict-detection.js', () => ({
  detectConflictsForChat,
  buildConflictInstruction,
}));

describe('chat routes', () => {
  const chunks: SearchChunk[] = [
    {
      id: 1,
      pageId: 10,
      title: 'CorpIT:FAQ VPN',
      text: 'VPN access requires MFA.',
      namespace: 3030,
      allowedGroups: ['ai-it'],
      score: 0.91,
    },
  ];

  beforeEach(async () => {
    redisStore.clear();
    appendCalls.length = 0;
    resetChatStoreForTests();
    resetAdminStoreForTests();
    getEmbedding.mockReset();
    searchRagChunks.mockReset();
    filterReadableChunks.mockReset();
    callLiteLLM.mockReset();
    detectConflictsForChat.mockReset();
    buildConflictInstruction.mockReset();
    fetchUserInfo.mockReset();
    fetchUserInfo.mockResolvedValue({
      username: 'ChatUser',
      userId: 77,
      groups: ['user', 'ai-it'],
    });
    getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    searchRagChunks.mockResolvedValue({
      chunks,
      limit: 4,
      aclCandidateLimit: 20,
      showRawScores: false,
      mode: 'hybrid',
    });
    filterReadableChunks.mockResolvedValue(chunks);
    detectConflictsForChat.mockResolvedValue(null);
    buildConflictInstruction.mockReturnValue('Conflict instruction');
    callLiteLLM.mockResolvedValue({
      choices: [
        {
          message: { role: 'assistant', content: 'Use MFA for VPN.' },
          finish_reason: 'stop',
          index: 0,
        },
      ],
    });
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    if (!template) throw new Error('semantic_broad retrieval profile template is missing');
    await upsertRetrievalProfile({
      id: 'test_mediawiki_vector',
      name: 'Test MediaWiki vector',
      description: 'Test profile',
      enabled: true,
      apiEnabled: false,
      mcpEnabled: false,
      anonymousAllowed: false,
      maxTopK: 20,
      tags: ['test'],
      config: {
        ...template.config,
        searchMode: 'vector_only',
        rerankMode: 'none',
        colbertEnabled: false,
      },
    });
    await setMediaWikiProfileConfig({ defaultRetrievalProfileId: 'test_mediawiki_vector' });
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = Fastify();
    app.decorate('rateLimit', () => async () => undefined);
    await app.register(chatRoutes);
    return app;
  }

  it('uses configured chat retention TTL when appending chat history', async () => {
    await setChatRetentionAdminConfig({
      retentionMode: 'auto_delete',
      activeDays: 2,
      recentDays: 1,
      archiveDays: 30,
      maxPinnedChats: 10,
      maxActiveChats: 100,
      maxTotalChats: 500,
      onLimitExceeded: 'delete_oldest',
      exportOptions: {
        formats: ['json'],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Как подключить VPN?',
        conversationId: 'conv-retention',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      conversationId: 'conv-retention',
      message: 'Use MFA for VPN.',
      diagnostics: {
        originalMessage: 'Как подключить VPN?',
        retrievalQuery: 'Как подключить VPN?',
        historyMessagesUsed: 0,
        requestedTopK: null,
        retrievalTopK: 4,
        effectiveTopK: 4,
        contextTopK: 4,
        contextMaxChars: 12000,
        searchMode: 'hybrid',
        retrievalProfileId: 'test_mediawiki_vector',
        rawChunks: 1,
        readableChunks: 1,
        trustedChunks: 1,
        finalSources: 1,
        contextSources: 1,
      },
      sources: [
        {
          pageId: 10,
          title: 'CorpIT:FAQ VPN',
          namespace: 3030,
          pageUrl: 'http://127.0.0.1:8082/index.php/CorpIT:FAQ_VPN',
        },
      ],
    });
    expect(appendCalls).toHaveLength(2);
    expect(appendCalls.map((call) => call.ttl)).toEqual([2 * 24 * 60 * 60, 2 * 24 * 60 * 60]);
    expect(searchRagChunks).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Как подключить VPN?',
      vector: [0.1, 0.2, 0.3],
      fallbackTopK: 4,
      config: expect.objectContaining({ searchMode: 'vector_only' }),
    }));
    expect(filterReadableChunks).toHaveBeenCalledWith(chunks, 'mw=1', 20);
    expect(detectConflictsForChat).toHaveBeenCalledWith('Как подключить VPN?', [
      expect.objectContaining({
        title: 'CorpIT:FAQ VPN',
        trust: expect.objectContaining({ score: 0.7 }),
      }),
    ]);
    await expect(getSqlChatHistory('mw=1', 'conv-retention', 77)).resolves.toEqual([
      { role: 'user', content: 'Как подключить VPN?' },
      { role: 'assistant', content: 'Use MFA for VPN.' },
    ]);

    await app.close();
  });

  it('rejects legacy cached MediaWiki principals before storing chat history', async () => {
    fetchUserInfo.mockResolvedValueOnce({
      username: 'cached',
      userId: 0,
      groups: ['ai-it'],
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=legacy', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Проверка legacy cache',
        conversationId: 'conv-legacy',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: 'Invalid MediaWiki principal',
    });
    await expect(getSqlChatHistory('mw=legacy', 'conv-legacy', 0)).resolves.toEqual([]);
    expect(callLiteLLM).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses retrievalTopK for returned sources and contextTopK for the LLM prompt', async () => {
    const manyChunks: SearchChunk[] = [
      {
        id: 11,
        pageId: 101,
        title: 'CorpIT:FAQ VPN',
        text: 'VPN access requires MFA.',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.91,
      },
      {
        id: 12,
        pageId: 102,
        title: 'CorpIT:FAQ WiFi',
        text: 'WiFi access uses corporate credentials.',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.88,
      },
      {
        id: 13,
        pageId: 103,
        title: 'CorpIT:FAQ MFA',
        text: 'MFA enrollment is required.',
        namespace: 3030,
        allowedGroups: ['ai-it'],
        score: 0.86,
      },
    ];
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    if (!template) throw new Error('semantic_broad retrieval profile template is missing');
    await upsertRetrievalProfile({
      id: 'test_mediawiki_vector',
      name: 'Test MediaWiki vector',
      description: 'Test profile with split limits',
      enabled: true,
      apiEnabled: false,
      mcpEnabled: false,
      anonymousAllowed: false,
      maxTopK: 20,
      tags: ['test'],
      config: {
        ...template.config,
        retrievalTopK: 3,
        contextTopK: 1,
        contextMaxChars: 1000,
        topK: 3,
        maxContextChunks: 1,
        maxContextChars: 1000,
        searchMode: 'vector_only',
        rerankMode: 'none',
        colbertEnabled: false,
      },
    });
    searchRagChunks.mockResolvedValueOnce({
      chunks: manyChunks,
      limit: 3,
      aclCandidateLimit: 15,
      showRawScores: false,
      mode: 'hybrid',
    });
    filterReadableChunks.mockResolvedValueOnce(manyChunks);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Как подключить VPN?',
        conversationId: 'conv-split-limits',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toHaveLength(3);
    expect(res.json().diagnostics).toMatchObject({
      requestedTopK: null,
      retrievalTopK: 3,
      effectiveTopK: 3,
      contextTopK: 1,
      contextMaxChars: 1000,
      finalSources: 3,
      contextSources: 1,
    });
    expect(searchRagChunks).toHaveBeenCalledWith(expect.objectContaining({
      fallbackTopK: 3,
      config: expect.objectContaining({ retrievalTopK: 3, contextTopK: 1 }),
    }));
    const messages = callLiteLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const contextMessage = messages.find((messageItem) => messageItem.content.startsWith('Documents for answer:'));
    expect(contextMessage?.content).toContain('[1] CorpIT:FAQ VPN');
    expect(contextMessage?.content).not.toContain('CorpIT:FAQ WiFi');
    expect(contextMessage?.content).not.toContain('[2]');

    await app.close();
  });

  it('keeps active chat history in the LLM prompt without injecting it into retrieval', async () => {
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'conv-cuisine',
      userId: 77,
      username: 'ChatUser',
      role: 'user',
      content: 'Расскажи про молекулярную гастрономию',
    }, {
      retentionMode: 'archive',
      activeDays: 7,
      recentDays: 7,
      archiveDays: 365,
      maxPinnedChats: 20,
      maxActiveChats: 200,
      maxTotalChats: 1000,
      onLimitExceeded: 'delete_oldest',
      exportOptions: {
        formats: ['json'],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    });
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'conv-cuisine',
      userId: 77,
      username: 'ChatUser',
      role: 'assistant',
      content: 'Молекулярная гастрономия использует научные методы приготовления.',
    }, {
      retentionMode: 'archive',
      activeDays: 7,
      recentDays: 7,
      archiveDays: 365,
      maxPinnedChats: 20,
      maxActiveChats: 200,
      maxTotalChats: 1000,
      onLimitExceeded: 'delete_oldest',
      exportOptions: {
        formats: ['json'],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Еще раз про кухню?',
        conversationId: 'conv-cuisine',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const ragQuery = searchRagChunks.mock.calls[0][0].query as string;
    expect(ragQuery).toBe('Еще раз про кухню?');
    expect(res.json().diagnostics).toMatchObject({
      originalMessage: 'Еще раз про кухню?',
      historyMessagesUsed: 2,
      retrievalQueryMode: 'current_message',
      historyInjectedIntoRetrieval: false,
    });
    expect(res.json().diagnostics.retrievalQuery).toBe('Еще раз про кухню?');
    const llmMessages = callLiteLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(llmMessages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Расскажи про молекулярную гастрономию' },
      { role: 'assistant', content: 'Молекулярная гастрономия использует научные методы приготовления.' },
    ]));
    expect(llmMessages[llmMessages.length - 1]).toEqual({ role: 'user', content: 'Еще раз про кухню?' });

    await app.close();
  });

  it('can include active chat history in retrieval when the profile enables history_augmented', async () => {
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    if (!template) throw new Error('semantic_broad retrieval profile template is missing');
    await upsertRetrievalProfile({
      id: 'test_mediawiki_history_augmented',
      name: 'Test MediaWiki history augmented',
      description: 'Test profile with chat history in retrieval',
      enabled: true,
      apiEnabled: false,
      mcpEnabled: false,
      anonymousAllowed: false,
      maxTopK: 20,
      tags: ['test'],
      config: {
        ...template.config,
        chatRetrievalQueryMode: 'history_augmented',
        searchMode: 'vector_only',
        rerankMode: 'none',
        colbertEnabled: false,
      },
    });
    await setMediaWikiProfileConfig({ defaultRetrievalProfileId: 'test_mediawiki_history_augmented' });
    const retention = {
      retentionMode: 'archive' as const,
      activeDays: 7,
      recentDays: 7,
      archiveDays: 365,
      maxPinnedChats: 20,
      maxActiveChats: 200,
      maxTotalChats: 1000,
      onLimitExceeded: 'delete_oldest' as const,
      exportOptions: {
        formats: ['json' as const],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    };
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'conv-history-retrieval',
      userId: 77,
      username: 'ChatUser',
      role: 'user',
      content: 'Расскажи про молекулярную гастрономию',
    }, retention);
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'conv-history-retrieval',
      userId: 77,
      username: 'ChatUser',
      role: 'assistant',
      content: 'Молекулярная гастрономия использует научные методы приготовления.',
    }, retention);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Еще раз про кухню?',
        conversationId: 'conv-history-retrieval',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const ragQuery = searchRagChunks.mock.calls[0][0].query as string;
    expect(ragQuery).toContain('Еще раз про кухню?');
    expect(ragQuery).toContain('Предыдущий вопрос: Расскажи про молекулярную гастрономию');
    expect(ragQuery).toContain('Предыдущий ответ: Молекулярная гастрономия использует научные методы приготовления.');
    expect(res.json().diagnostics).toMatchObject({
      retrievalProfileId: 'test_mediawiki_history_augmented',
      chatProfileId: 'chat_followup_full',
      retrievalHistoryMode: 'current_session_questions_and_answers',
      retrievalHistoryMessagesUsed: 2,
      retrievalQueryMode: 'current_session_questions_and_answers',
      historyInjectedIntoRetrieval: true,
      historyMessagesUsed: 2,
    });
    expect(res.json().diagnostics.retrievalQuery).toBe(ragQuery);
    const llmMessages = callLiteLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(llmMessages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Расскажи про молекулярную гастрономию' },
      { role: 'assistant', content: 'Молекулярная гастрономия использует научные методы приготовления.' },
    ]));

    await app.close();
  });

  it('uses chat profile settings to add only previous user questions to retrieval', async () => {
    const template = (await getDefaultRetrievalProfiles()).find((profile) => profile.id === 'semantic_broad');
    if (!template) throw new Error('semantic_broad retrieval profile template is missing');
    await upsertRetrievalProfile({
      id: 'test_mediawiki_followup_questions',
      name: 'Test MediaWiki follow-up questions',
      description: 'Test profile with question-only retrieval history',
      enabled: true,
      apiEnabled: false,
      mcpEnabled: false,
      anonymousAllowed: false,
      maxTopK: 20,
      chatProfileId: 'chat_followup_questions',
      tags: ['test'],
      config: {
        ...template.config,
        chatRetrievalQueryMode: 'current_message',
        searchMode: 'vector_only',
        rerankMode: 'none',
        colbertEnabled: false,
      },
    });
    await setMediaWikiProfileConfig({ defaultRetrievalProfileId: 'test_mediawiki_followup_questions' });
    const retention = {
      retentionMode: 'archive' as const,
      activeDays: 7,
      recentDays: 7,
      archiveDays: 365,
      maxPinnedChats: 20,
      maxActiveChats: 200,
      maxTotalChats: 1000,
      onLimitExceeded: 'delete_oldest' as const,
      exportOptions: {
        formats: ['json' as const],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    };
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'conv-followup-questions',
      userId: 77,
      username: 'ChatUser',
      role: 'user',
      content: 'Расскажи про молекулярную гастрономию',
    }, retention);
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'conv-followup-questions',
      userId: 77,
      username: 'ChatUser',
      role: 'assistant',
      content: 'Молекулярная гастрономия использует научные методы приготовления.',
    }, retention);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Еще раз про кухню?',
        conversationId: 'conv-followup-questions',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const ragQuery = searchRagChunks.mock.calls[0][0].query as string;
    expect(ragQuery).toContain('Еще раз про кухню?');
    expect(ragQuery).toContain('Предыдущий вопрос: Расскажи про молекулярную гастрономию');
    expect(ragQuery).not.toContain('Предыдущий ответ:');
    expect(res.json().diagnostics).toMatchObject({
      retrievalProfileId: 'test_mediawiki_followup_questions',
      chatProfileId: 'chat_followup_questions',
      promptHistoryScope: 'current_session',
      promptHistoryMessagesUsed: 2,
      retrievalHistoryMode: 'current_session_questions',
      retrievalHistoryMessagesUsed: 1,
      retrievalQueryMode: 'current_session_questions',
      historyInjectedIntoRetrieval: true,
      historyMessagesUsed: 2,
    });
    expect(res.json().diagnostics.retrievalQuery).toBe(ragQuery);
    const llmMessages = callLiteLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(llmMessages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Расскажи про молекулярную гастрономию' },
      { role: 'assistant', content: 'Молекулярная гастрономия использует научные методы приготовления.' },
    ]));

    await app.close();
  });

  it('does not let MediaWiki chat request bodies override the admin-selected retrieval profile', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1' },
      payload: {
        message: 'Как подключить VPN?',
        conversationId: 'conv-profile-override',
        stream: false,
        retrievalProfileId: 'colbert_full_strict',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().diagnostics).toMatchObject({
      retrievalProfileId: 'test_mediawiki_vector',
      effectiveSearchMode: 'vector_only',
    });
    expect(searchRagChunks).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ searchMode: 'vector_only' }),
    }));
    await app.close();
  });

  it('returns conflict metadata and instructs the LLM to warn about contradictions', async () => {
    const conflict = {
      enabled: true,
      checked: true,
      hasConflict: true,
      lowTrust: true,
      confidence: 0.64,
      summary: 'Источники спорят о MFA.',
      conflictingSources: [{ title: 'CorpIT:FAQ VPN', claim: 'Можно без MFA.' }],
      metadata: {
        model: 'test-model',
        runMode: 'risk_only',
        sourceCount: 2,
      },
    };
    detectConflictsForChat.mockResolvedValue(conflict);

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1' },
      payload: {
        message: 'Можно ли VPN без MFA?',
        conversationId: 'conv-conflict',
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().conflict).toMatchObject({
      hasConflict: true,
      summary: 'Источники спорят о MFA.',
    });
    const messages = callLiteLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages.some((message) => message.content === 'Conflict instruction')).toBe(true);
    expect(buildConflictInstruction).toHaveBeenCalledWith(conflict);
    await app.close();
  });

  it('emits a streaming conflict event before sources', async () => {
    detectConflictsForChat.mockResolvedValue({
      enabled: true,
      checked: true,
      hasConflict: true,
      lowTrust: true,
      confidence: 0.5,
      summary: 'Конфликт.',
      conflictingSources: [],
      metadata: {
        model: 'test-model',
        runMode: 'risk_only',
        sourceCount: 2,
      },
    });

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: 'mw=1', origin: 'http://127.0.0.1:8082' },
      payload: {
        message: 'Можно ли VPN без MFA?',
        conversationId: 'conv-stream-conflict',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8082');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.payload).toContain('"type":"conversation"');
    expect(res.payload).toContain('"conversationId":"conv-stream-conflict"');
    expect(res.payload).toContain('"type":"conflict"');
    expect(res.payload).toContain('"type":"diagnostics"');
    expect(res.payload).toContain('"originalMessage":"Можно ли VPN без MFA?"');
    expect(res.payload).toContain('"historyMessagesUsed":0');
    expect(res.payload).toContain('"type":"sources"');
    expect(res.payload).toContain('"pageUrl":"http://127.0.0.1:8082/index.php/CorpIT:FAQ_VPN"');
    expect(res.payload.indexOf('"type":"conversation"')).toBeLessThan(res.payload.indexOf('"type":"conflict"'));
    expect(res.payload.indexOf('"type":"conflict"')).toBeLessThan(res.payload.indexOf('"type":"diagnostics"'));
    expect(res.payload.indexOf('"type":"diagnostics"')).toBeLessThan(res.payload.indexOf('"type":"sources"'));
    await app.close();
  });

  it('lists titled sessions, exports only the user archive and protects user-owned chat sessions', async () => {
    const retention = {
      retentionMode: 'archive' as const,
      activeDays: 7,
      recentDays: 7,
      archiveDays: 365,
      maxPinnedChats: 20,
      maxActiveChats: 200,
      maxTotalChats: 1000,
      onLimitExceeded: 'delete_oldest' as const,
      exportOptions: {
        formats: ['json' as const],
        includeMetadata: true,
        includeSources: true,
        includeMessages: true,
      },
    };
    const longQuestion = 'Как подключить корпоративный VPN из дома и какие шаги выполнить для многофакторной аутентификации в первый день работы?';
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'own-chat',
      userId: 77,
      username: 'ChatUser',
      role: 'user',
      content: longQuestion,
    }, retention);
    await recordChatMessage({
      sessionHash: 'mw=1',
      conversationId: 'active-chat',
      userId: 77,
      username: 'ChatUser',
      role: 'user',
      content: 'Активный чат не должен попасть в архивный экспорт',
    }, retention);
    const otherRecord = await recordChatMessage({
      sessionHash: 'mw=other',
      conversationId: 'other-chat',
      userId: 88,
      username: 'OtherUser',
      role: 'user',
      content: 'Чужой чат',
    }, retention);

    const app = await makeApp();
    const list = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions?limit=10',
      headers: { cookie: 'mw=1' },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().values).toHaveLength(2);
    const ownSummary = list.json().values.find((session: { conversationId: string }) => session.conversationId === 'own-chat');
    expect(ownSummary).toMatchObject({ conversationId: 'own-chat', userId: 77 });
    expect(ownSummary.title).toMatch(/^Как подключить корпоративный VPN/);
    expect(ownSummary.title.length).toBeLessThanOrEqual(80);

    const ownSessionId = ownSummary.id;
    const messages = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${ownSessionId}/messages`,
      headers: { cookie: 'mw=1' },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().values[0]).toMatchObject({ content: longQuestion });

    const forbiddenMessages = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${otherRecord.session.id}/messages`,
      headers: { cookie: 'mw=1' },
    });
    expect(forbiddenMessages.statusCode).toBe(404);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${ownSessionId}/archive`,
      headers: { cookie: 'mw=1' },
      payload: { reason: 'test' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().values.status).toBe('archived');

    const archivedList = await app.inject({
      method: 'GET',
      url: '/api/chat/sessions?status=archived&limit=10',
      headers: { cookie: 'mw=1' },
    });
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.json().values).toEqual([
      expect.objectContaining({ conversationId: 'own-chat', status: 'archived', title: ownSummary.title }),
    ]);

    const archiveExport = await app.inject({
      method: 'POST',
      url: '/api/chat/archive/export',
      headers: { cookie: 'mw=1' },
      payload: { format: 'json' },
    });
    expect(archiveExport.statusCode).toBe(200);
    expect(archiveExport.json().values.sessionCount).toBe(1);
    expect(archiveExport.json().values.content).toContain(longQuestion);
    expect(archiveExport.json().values.content).not.toContain('Активный чат не должен попасть');
    expect(archiveExport.json().values.content).not.toContain('Чужой чат');

    await app.close();
  });
});
