import { streamChatCompletion, callLiteLLM } from './litellm.js';
import { getChatHistory, appendChatMessage } from './redis.js';
import { getRuntimeConfig, type RuntimeConfig } from './config.js';
import { type PrincipalAclMode } from './acl.js';
import { formatChunksForPrompt } from './prompt-context.js';
import {
  calculateChatRetentionRedisTtlSeconds,
  getEffectiveContextMaxChars,
  getEffectiveContextTopK,
  getEffectiveRetrievalTopK,
  getChatRetentionAdminConfig,
  getConflictDetectionConfig,
  getRagAdminConfig,
  type AssistantUiMode,
  type ChatRetentionConfig,
  type RagAdminConfig,
} from './admin-platform-config.js';
import {
  buildConflictInstruction,
  detectConflictsForChat,
  detectConflictsWithTrace,
  type ConflictDetectionTrace,
} from './conflict-detection.js';
import {
  ChatRetentionLimitError,
  getUserChatSessionMessages,
  getSqlChatHistory,
  listUserChatSessions,
  recordChatMessage,
} from './chat-store.js';
import { type WikiPageUrlOptions } from './mediawiki-url.js';
import { principalSessionHash } from './principal-auth.js';
import { RuntimeHttpError } from './runtime-errors.js';
import { logOperationalError, logOperationalEvent } from './logging.js';
import { AuthenticatedPrincipal, DocumentChunk, SearchChunk } from '../types/index.js';
import {
  resolveRuntimeRetrievalProfile,
  type RetrievalProfileSurface,
  type ResolvedRetrievalProfile,
} from './retrieval-profiles.js';
import {
  resolveChatProfileForRetrievalProfile,
  type ChatProfile,
  type RetrievalHistoryMode,
} from './chat-profiles.js';
import {
  type KnowledgeSourceFanoutTrace,
  type KnowledgeSourceFailurePolicy,
  type KnowledgeSourceWarning,
} from './knowledge-sources.js';
import { executeKnowledgeSourceFanout } from './knowledge-source-runtime.js';

type RetrievalHistoryMessage = { role: string; content: string };
type LlmMessage = { role: string; content: string };
type RetrievalQueryMode = RagAdminConfig['chatRetrievalQueryMode'];

function assertChatPrincipalCanPersist(principal: AuthenticatedPrincipal): void {
  if (principal.authMode !== 'mediawiki_cookie') return;
  if (principal.userId > 0 && principal.username !== 'cached' && principal.username !== 'anonymous') return;

  logOperationalEvent('warn', 'chat.invalid_mediawiki_principal', {
    authMode: principal.authMode,
    userId: principal.userId,
    usernameState: principal.username === 'cached' ? 'legacy_cached' : principal.username === 'anonymous' ? 'anonymous' : 'invalid',
  });
  throw new RuntimeHttpError(401, {
    error: 'Invalid MediaWiki principal',
    message: 'Refresh MediaWiki session and retry',
  });
}

export interface RuntimeChatInput {
  message: string;
  conversationId?: string;
  principal: AuthenticatedPrincipal;
  wikiUrlOptions?: WikiPageUrlOptions;
  topK?: number;
  maxTopK?: number;
  aclMode?: PrincipalAclMode;
  retrievalProfileId?: string;
  retrievalProfileSurface?: RetrievalProfileSurface;
  knowledgeSourceProfileId?: string;
  sourceIds?: string[];
  sourceFailurePolicy?: KnowledgeSourceFailurePolicy;
  dryRun?: boolean;
  disableHistory?: boolean;
  runConflictDetection?: boolean;
  includeDebugTrace?: boolean;
}

export interface RuntimeChatSource {
  sourceId: string;
  documentId: string;
  displayTitle: string;
  sourceUrl: string;
  spaceKey: string;
  pageId: number;
  title: string;
  namespace: number;
  pageUrl: string;
  trust: SearchChunk['trust'];
}

export interface RuntimeChatResponseSettings {
  litellmModel: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  showSources: boolean;
  assistantUiMode: AssistantUiMode;
}

export interface PreparedRuntimeChat {
  conversationId: string;
  message: string;
  sessionHash: string;
  principal: AuthenticatedPrincipal;
  runtime: RuntimeConfig;
  responseSettings: RuntimeChatResponseSettings;
  retention: ChatRetentionConfig;
  chatTtlSeconds: number;
  messages: LlmMessage[];
  sources: RuntimeChatSource[];
  conflict: Awaited<ReturnType<typeof detectConflictsForChat>>;
  retrievalDiagnostics: Record<string, unknown>;
  debugTrace?: RuntimeChatDebugTrace;
}

export interface RuntimeChatCompletionResponse {
  conversationId: string;
  message: string;
  sources?: RuntimeChatSource[];
  conflict?: PreparedRuntimeChat['conflict'];
  diagnostics?: Record<string, unknown>;
  llmAvailable?: boolean;
  assistantUiMode?: AssistantUiMode;
}

export type RuntimeChatSseWriter = (payload: Record<string, unknown> | '[DONE]') => void;

export interface RuntimeChatDebugTrace {
  ragConfig: RagAdminConfig;
  chatProfile: Pick<
    ChatProfile,
    | 'id'
    | 'name'
    | 'promptHistoryScope'
    | 'promptHistoryTurns'
    | 'retrievalHistoryMode'
    | 'retrievalHistoryTurns'
  >;
  search: {
    mode: string;
    limit: number;
    aclCandidateLimit: number;
    diagnostics: Record<string, unknown>;
  };
  sourceFanout: KnowledgeSourceFanoutTrace[];
  knowledgeSourceWarnings: KnowledgeSourceWarning[];
  chunks: {
    raw: DocumentChunk[];
    readable: DocumentChunk[];
    trusted: DocumentChunk[];
    reranked: DocumentChunk[];
    context: DocumentChunk[];
  };
  contextText: string;
  conflictTrace?: ConflictDetectionTrace | {
    skippedReason: 'disabled_by_request' | 'show_conflict_block_disabled';
  } | {
    error: string;
  };
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const compact = compactText(value);
  if (maxChars <= 0) return '';
  if (compact.length <= maxChars) return compact;
  if (maxChars <= 3) return compact.slice(0, maxChars);
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

export interface ChatRetrievalQuery {
  query: string;
  mode: RetrievalQueryMode | RetrievalHistoryMode;
  historyInjected: boolean;
}

export function buildChatRetrievalQuery(
  currentMessage: string,
  history: RetrievalHistoryMessage[],
  mode: RetrievalQueryMode = 'current_message',
  maxChars = 1200
): ChatRetrievalQuery {
  if (mode === 'current_message') {
    const query = truncateText(currentMessage, maxChars);
    return {
      query,
      mode,
      historyInjected: false,
    };
  }

  const parts = [compactText(currentMessage)].filter(Boolean);
  const recent = history
    .filter((historyMessage) => historyMessage.role === 'user' || historyMessage.role === 'assistant')
    .slice(-4);

  let historyInjected = false;
  for (const historyMessage of recent) {
    const label = historyMessage.role === 'user' ? 'Предыдущий вопрос' : 'Предыдущий ответ';
    const content = truncateText(historyMessage.content, historyMessage.role === 'user' ? 320 : 220);
    if (content) {
      parts.push(`${label}: ${content}`);
      historyInjected = true;
    }
  }

  const result = parts.join('\n');
  return {
    query: result.length <= maxChars ? result : result.slice(0, maxChars).trimEnd(),
    mode,
    historyInjected,
  };
}

function countRetrievalHistoryMessages(history: RetrievalHistoryMessage[]): number {
  return history
    .filter((historyMessage) => historyMessage.role === 'user' || historyMessage.role === 'assistant')
    .length;
}

function selectHistoryMessages(
  history: RetrievalHistoryMessage[],
  roles: Set<string>,
  turns: number,
  maxChars: number
): RetrievalHistoryMessage[] {
  if (turns <= 0 || maxChars <= 0) return [];
  const recent = history
    .filter((historyMessage) => roles.has(historyMessage.role) && compactText(historyMessage.content))
    .slice(-turns);
  const selected: RetrievalHistoryMessage[] = [];
  let remaining = maxChars;

  for (const historyMessage of recent.slice().reverse()) {
    if (remaining <= 0) break;
    const content = truncateText(historyMessage.content, remaining);
    if (!content) continue;
    selected.push({ role: historyMessage.role, content });
    remaining -= content.length;
  }

  return selected.reverse();
}

function selectRetrievalHistory(
  history: RetrievalHistoryMessage[],
  profile: ChatProfile
): RetrievalHistoryMessage[] {
  if (profile.retrievalHistoryMode === 'current_message') return [];
  const roles = profile.retrievalHistoryMode === 'current_session_questions'
    ? new Set<string>(['user'])
    : new Set<string>(['user', 'assistant']);
  return selectHistoryMessages(
    history,
    roles,
    profile.retrievalHistoryTurns,
    profile.maxRetrievalHistoryChars
  );
}

function buildChatRetrievalQueryForProfile(
  currentMessage: string,
  history: RetrievalHistoryMessage[],
  profile: ChatProfile
): ChatRetrievalQuery {
  const maxChars = profile.maxRetrievalHistoryChars || 1200;
  if (profile.retrievalHistoryMode === 'current_message') {
    return {
      query: truncateText(currentMessage, maxChars),
      mode: profile.retrievalHistoryMode,
      historyInjected: false,
    };
  }

  const selected = selectRetrievalHistory(history, profile);
  const parts = [compactText(currentMessage)].filter(Boolean);
  for (const historyMessage of selected) {
    const label = historyMessage.role === 'user' ? 'Предыдущий вопрос' : 'Предыдущий ответ';
    parts.push(`${label}: ${historyMessage.content}`);
  }

  const result = parts.join('\n');
  return {
    query: result.length <= maxChars ? result : result.slice(0, maxChars).trimEnd(),
    mode: profile.retrievalHistoryMode,
    historyInjected: selected.length > 0,
  };
}

async function loadPromptHistory(input: {
  profile: ChatProfile;
  currentHistory: RetrievalHistoryMessage[];
  principal: AuthenticatedPrincipal;
  conversationId: string;
}): Promise<RetrievalHistoryMessage[]> {
  const roles = new Set<string>(['user', 'assistant']);
  if (input.profile.promptHistoryScope === 'current_session' || input.principal.userId <= 0) {
    return selectHistoryMessages(
      input.currentHistory,
      roles,
      input.profile.promptHistoryTurns,
      input.profile.maxPromptHistoryChars
    );
  }

  const activeSessions = await listUserChatSessions(input.principal.userId, 'active', 10).catch(() => []);
  const activeMessages: Array<RetrievalHistoryMessage & { createdAt: string }> = [];
  for (const session of activeSessions) {
    if (session.conversationId === input.conversationId) continue;
    const messages = await getUserChatSessionMessages(session.id, input.principal.userId).catch(() => []);
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      activeMessages.push({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      });
    }
  }

  const combined = [
    ...activeMessages
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map(({ role, content }) => ({ role, content })),
    ...input.currentHistory,
  ];
  return selectHistoryMessages(
    combined,
    roles,
    input.profile.promptHistoryTurns,
    input.profile.maxPromptHistoryChars
  );
}

function clampTopK(topK: number | undefined, maxTopK: number | undefined): number | undefined {
  if (topK === undefined) return undefined;
  const normalized = Math.max(1, Math.trunc(topK));
  return maxTopK === undefined ? normalized : Math.min(normalized, maxTopK);
}

function chunkToSource(chunk: DocumentChunk): RuntimeChatSource {
  return {
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    displayTitle: chunk.displayTitle,
    sourceUrl: chunk.sourceUrl,
    spaceKey: chunk.spaceKey,
    pageId: chunk.pageId,
    title: chunk.title,
    namespace: chunk.namespace,
    pageUrl: chunk.pageUrl ?? chunk.sourceUrl,
    trust: chunk.trust,
  };
}

function buildRuntimeChatResponseSettings(
  runtime: RuntimeConfig,
  profileSelection: ResolvedRetrievalProfile | undefined
): RuntimeChatResponseSettings {
  const profileConfig = profileSelection?.profile.config;
  return {
    litellmModel: profileConfig?.llmModel ?? runtime.litellmModel,
    temperature: profileConfig?.llmTemperature ?? runtime.temperature,
    maxTokens: profileConfig?.llmMaxTokens ?? runtime.maxTokens,
    timeoutMs: profileConfig?.llmTimeoutMs ?? runtime.timeoutMs,
    showSources: profileConfig?.showSources ?? runtime.showSources,
    assistantUiMode: profileConfig?.assistantUiMode ?? 'standard',
  };
}

function profileDiagnostics(selection: ResolvedRetrievalProfile | undefined): Record<string, unknown> {
  if (!selection) return { retrievalProfileId: null };
  return {
    retrievalProfileId: selection.profile.id,
    retrievalProfileReadiness: selection.readiness.status,
    retrievalProfileReasons: selection.readiness.reasons,
    retrievalProfileRequiredIndexTargets: selection.readiness.requiredIndexTargets ?? [],
    retrievalProfileMissingIndexTargets: selection.readiness.missingIndexTargets ?? [],
    effectiveSearchMode: selection.effectiveConfig.searchMode,
    effectiveLexicalBackend: selection.effectiveConfig.lexicalBackend,
  };
}

export async function prepareRuntimeChat(input: RuntimeChatInput): Promise<PreparedRuntimeChat> {
  assertChatPrincipalCanPersist(input.principal);
  const message = input.message.trim();
  const convId = input.conversationId ?? `${input.principal.userId}-${Date.now()}`;
  const sessionHash = principalSessionHash(input.principal);
  const runtime = await getRuntimeConfig();
  const chatRetention = await getChatRetentionAdminConfig();
  const chatTtlSeconds = calculateChatRetentionRedisTtlSeconds(chatRetention);
  const profileSelection = await resolveRuntimeRetrievalProfile(
    input.retrievalProfileId,
    input.retrievalProfileSurface ?? 'api'
  );
  const ragConfig = profileSelection?.effectiveConfig ?? await getRagAdminConfig();
  const chatProfile = await resolveChatProfileForRetrievalProfile(profileSelection?.profile);
  const responseSettings = buildRuntimeChatResponseSettings(runtime, profileSelection);

  const sqlHistory = input.disableHistory
    ? []
    : await getSqlChatHistory(sessionHash, convId, input.principal.userId);
  const fullHistory = input.disableHistory
    ? []
    : sqlHistory.length > 0 ? sqlHistory : await getChatHistory(sessionHash, convId);
  const promptHistory = input.disableHistory
    ? []
    : await loadPromptHistory({
      profile: chatProfile,
      currentHistory: fullHistory,
      principal: input.principal,
      conversationId: convId,
    });
  const retrievalHistory = input.disableHistory ? [] : selectRetrievalHistory(fullHistory, chatProfile);
  const retrievalQueryDecision = buildChatRetrievalQueryForProfile(message, fullHistory, chatProfile);
  const retrievalQuery = retrievalQueryDecision.query;

  if (!input.dryRun) {
    try {
      await recordChatMessage({
        sessionHash,
        conversationId: convId,
        userId: input.principal.userId,
        username: input.principal.username,
        role: 'user',
        content: message,
      }, chatRetention);
    } catch (err) {
      if (err instanceof ChatRetentionLimitError) {
        throw new RuntimeHttpError(429, {
          error: 'Chat retention limit exceeded',
          message: err.message,
        });
      }
      logOperationalError('chat.sql_user_history_write_error', err);
    }
  }

  const topKLimit = profileSelection
    ? Math.min(input.maxTopK ?? profileSelection.profile.maxTopK, profileSelection.profile.maxTopK)
    : input.maxTopK;
  const topK = clampTopK(input.topK, topKLimit);
  const fallbackTopK = getEffectiveRetrievalTopK(ragConfig, runtime.topK);
  const effectiveTopK = topK ?? fallbackTopK;
  const aclMode = input.aclMode ?? 'mediawiki_check';
  const failurePolicy = input.sourceFailurePolicy ?? 'partial_with_warning';
  const sourceSearch = await executeKnowledgeSourceFanout({
    sourceIds: input.sourceIds,
    query: retrievalQuery,
    topK,
    fallbackTopK,
    effectiveTopK,
    ragConfig,
    profileConfig: profileSelection?.effectiveConfig,
    principal: input.principal,
    aclMode,
    failurePolicy,
    wikiUrlOptions: input.wikiUrlOptions ?? {},
  });
  const verifiedChunks = sourceSearch.mergedChunks;
  const sources = verifiedChunks.map((chunk) => chunkToSource(chunk));
  const contextTopK = getEffectiveContextTopK(ragConfig, effectiveTopK);
  const contextMaxChars = getEffectiveContextMaxChars(ragConfig);
  const contextChunks = verifiedChunks.slice(0, contextTopK);
  let conflict: Awaited<ReturnType<typeof detectConflictsForChat>> = null;
  let conflictTrace: RuntimeChatDebugTrace['conflictTrace'];
  if (input.runConflictDetection === false) {
    if (input.includeDebugTrace) conflictTrace = { skippedReason: 'disabled_by_request' };
  } else if (input.includeDebugTrace) {
    const conflictConfig = await getConflictDetectionConfig();
    if (!conflictConfig.showConflictBlock) {
      conflictTrace = { skippedReason: 'show_conflict_block_disabled' };
    } else {
      try {
        const checked = await detectConflictsWithTrace(retrievalQuery, verifiedChunks, { config: conflictConfig });
        conflictTrace = checked.trace;
        if (checked.result.checked && (checked.result.hasConflict || checked.result.lowTrust)) {
          conflict = checked.result;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown conflict detection error';
        conflictTrace = { error };
        logOperationalError('conflict_detection.error', err);
      }
    }
  } else {
    conflict = await detectConflictsForChat(retrievalQuery, verifiedChunks);
  }

  if (!input.dryRun) {
    await appendChatMessage(sessionHash, convId, { role: 'user', content: message }, chatTtlSeconds);
  }

  const contextText = formatChunksForPrompt(contextChunks, { maxChars: contextMaxChars });
  const messages: LlmMessage[] = [
    { role: 'system', content: runtime.systemPrompt },
    ...(contextText ? [{ role: 'system', content: `Documents for answer:\n${contextText}` }] : []),
    ...(conflict ? [{ role: 'system', content: buildConflictInstruction(conflict) }] : []),
    ...promptHistory,
    { role: 'user', content: message },
  ];

  return {
    conversationId: convId,
    message,
    sessionHash,
    principal: input.principal,
    runtime,
    responseSettings,
    retention: chatRetention,
    chatTtlSeconds,
    messages,
    sources,
    conflict,
    retrievalDiagnostics: {
      ...sourceSearch.diagnostics,
      ...profileDiagnostics(profileSelection),
      knowledgeSourceProfileId: input.knowledgeSourceProfileId ?? null,
      knowledgeSourceIds: sourceSearch.sourceIds,
      knowledgeSourceFailurePolicy: failurePolicy,
      knowledgeSourceWarnings: sourceSearch.sourceWarnings,
      sourceFanout: sourceSearch.sourceFanout,
      aclMode,
      authMode: input.principal.authMode,
      chatProfileId: chatProfile.id,
      chatProfileName: chatProfile.name,
      promptHistoryScope: chatProfile.promptHistoryScope,
      promptHistoryMessagesUsed: countRetrievalHistoryMessages(promptHistory),
      retrievalHistoryMode: chatProfile.retrievalHistoryMode,
      retrievalHistoryMessagesUsed: countRetrievalHistoryMessages(retrievalHistory),
      originalMessage: message,
      retrievalQuery,
      retrievalQueryMode: retrievalQueryDecision.mode,
      historyInjectedIntoRetrieval: retrievalQueryDecision.historyInjected,
      historyMessagesUsed: countRetrievalHistoryMessages(promptHistory),
      requestedTopK: input.topK ?? null,
      retrievalTopK: fallbackTopK,
      effectiveTopK,
      contextTopK,
      contextMaxChars,
      searchMode: sourceSearch.searchMode,
      rawChunks: sourceSearch.rawChunks.length,
      readableChunks: sourceSearch.readableChunks.length,
      trustedChunks: sourceSearch.trustedChunks.length,
      finalSources: sources.length,
      contextSources: contextChunks.length,
      llmModel: responseSettings.litellmModel,
      llmTemperature: responseSettings.temperature,
      llmMaxTokens: responseSettings.maxTokens,
      llmTimeoutMs: responseSettings.timeoutMs,
      showSources: responseSettings.showSources,
      assistantUiMode: responseSettings.assistantUiMode,
    },
    debugTrace: input.includeDebugTrace ? {
      ragConfig,
      chatProfile: {
        id: chatProfile.id,
        name: chatProfile.name,
        promptHistoryScope: chatProfile.promptHistoryScope,
        promptHistoryTurns: chatProfile.promptHistoryTurns,
        retrievalHistoryMode: chatProfile.retrievalHistoryMode,
        retrievalHistoryTurns: chatProfile.retrievalHistoryTurns,
      },
      search: {
        mode: sourceSearch.searchMode,
        limit: sourceSearch.firstSearch?.limit ?? effectiveTopK,
        aclCandidateLimit: sourceSearch.firstSearch?.aclCandidateLimit ?? 0,
        diagnostics: { ...sourceSearch.diagnostics },
      },
      sourceFanout: sourceSearch.sourceFanout,
      knowledgeSourceWarnings: sourceSearch.sourceWarnings,
      chunks: {
        raw: sourceSearch.rawChunks,
        readable: sourceSearch.readableChunks,
        trusted: sourceSearch.trustedChunks,
        reranked: verifiedChunks,
        context: contextChunks,
      },
      contextText,
      ...(conflictTrace ? { conflictTrace } : {}),
    } : undefined,
  };
}

export async function completeRuntimeChat(prepared: PreparedRuntimeChat): Promise<RuntimeChatCompletionResponse> {
  try {
    const response = await callLiteLLM(
      prepared.messages,
      prepared.responseSettings.litellmModel,
      prepared.responseSettings.timeoutMs,
      {
        temperature: prepared.responseSettings.temperature,
        maxTokens: prepared.responseSettings.maxTokens,
      }
    );
    const content = response.choices[0]?.message?.content ?? '';
    if (content) {
      await appendChatMessage(
        prepared.sessionHash,
        prepared.conversationId,
        { role: 'assistant', content },
        prepared.chatTtlSeconds
      );
      await recordChatMessage({
        sessionHash: prepared.sessionHash,
        conversationId: prepared.conversationId,
        userId: prepared.principal.userId,
        username: prepared.principal.username,
        role: 'assistant',
        content,
        sources: prepared.sources,
      }, prepared.retention).catch((err: unknown) => {
        logOperationalError('chat.sql_assistant_history_write_error', err);
      });
    }
    return {
      conversationId: prepared.conversationId,
      message: content,
      sources: prepared.responseSettings.showSources ? prepared.sources : undefined,
      conflict: prepared.conflict ?? undefined,
      diagnostics: prepared.retrievalDiagnostics,
      assistantUiMode: prepared.responseSettings.assistantUiMode,
    };
  } catch (err) {
    logOperationalError('chat.non_streaming_error', err);
    const showSources = prepared.responseSettings.showSources;
    return {
      llmAvailable: false,
      conversationId: prepared.conversationId,
      message: showSources
        ? 'AI model temporarily unavailable. Here are the found documents:'
        : 'AI model temporarily unavailable.',
      sources: showSources ? prepared.sources : undefined,
      conflict: prepared.conflict ?? undefined,
      diagnostics: prepared.retrievalDiagnostics,
      assistantUiMode: prepared.responseSettings.assistantUiMode,
    };
  }
}

export async function streamRuntimeChat(
  prepared: PreparedRuntimeChat,
  writeEvent: RuntimeChatSseWriter
): Promise<void> {
  let fullResponse = '';

  try {
    writeEvent({ type: 'conversation', conversationId: prepared.conversationId });
    writeEvent({ type: 'ui', assistantUiMode: prepared.responseSettings.assistantUiMode });

    if (prepared.conflict) {
      writeEvent({ type: 'conflict', conflict: prepared.conflict });
    }

    writeEvent({ type: 'diagnostics', diagnostics: prepared.retrievalDiagnostics });

    for await (const chunk of streamChatCompletion(
      prepared.messages,
      prepared.responseSettings.litellmModel,
      prepared.responseSettings.timeoutMs,
      {
        temperature: prepared.responseSettings.temperature,
        maxTokens: prepared.responseSettings.maxTokens,
      }
    )) {
      const content = chunk.choices[0]?.delta?.content ?? '';
      if (content) {
        fullResponse += content;
        writeEvent({ type: 'token', content });
      }
    }

    if (prepared.responseSettings.showSources) {
      writeEvent({ type: 'sources', sources: prepared.sources });
    }
    writeEvent('[DONE]');
  } catch (err) {
    logOperationalError('chat.stream_error', err);
    const showSources = prepared.responseSettings.showSources;
    const errorMsg = showSources
      ? 'AI model temporarily unavailable. Here are the found documents:'
      : 'AI model temporarily unavailable.';
    writeEvent({ type: 'token', content: errorMsg });
    if (showSources) {
      writeEvent({ type: 'token', content: '\n\n' });

      for (const source of prepared.sources) {
        writeEvent({ type: 'token', content: `• ${source.title}\n` });
      }
    }

    if (showSources) {
      writeEvent({ type: 'sources', sources: prepared.sources });
    }
    writeEvent('[DONE]');
  } finally {
    if (fullResponse) {
      await appendChatMessage(
        prepared.sessionHash,
        prepared.conversationId,
        { role: 'assistant', content: fullResponse },
        prepared.chatTtlSeconds
      );
      await recordChatMessage({
        sessionHash: prepared.sessionHash,
        conversationId: prepared.conversationId,
        userId: prepared.principal.userId,
        username: prepared.principal.username,
        role: 'assistant',
        content: fullResponse,
        sources: prepared.sources,
      }, prepared.retention).catch((err: unknown) => {
        logOperationalError('chat.sql_stream_history_write_error', err);
      });
    }
  }
}
