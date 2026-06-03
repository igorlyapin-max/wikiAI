import { getEmbedding } from './embedding.js';
import { streamChatCompletion, callLiteLLM } from './litellm.js';
import { getChatHistory, appendChatMessage } from './redis.js';
import { getRuntimeConfig, type RuntimeConfig } from './config.js';
import { filterReadableChunks, filterReadableChunksForPrincipal, type PrincipalAclMode } from './acl.js';
import { formatChunksForPrompt } from './prompt-context.js';
import {
  calculateChatRetentionRedisTtlSeconds,
  getChatRetentionAdminConfig,
  getRagAdminConfig,
  type ChatRetentionConfig,
} from './admin-platform-config.js';
import { applyTrustPolicyToChunks } from './trust-runtime.js';
import { buildConflictInstruction, detectConflictsForChat } from './conflict-detection.js';
import {
  ChatRetentionLimitError,
  getSqlChatHistory,
  recordChatMessage,
} from './chat-store.js';
import { buildWikiPageUrl, type WikiPageUrlOptions } from './mediawiki-url.js';
import { RagSearchResult, searchRagChunks } from './hybrid-search.js';
import {
  getColbertCandidateLimit,
  isColbertFullSearchEnabled,
  rerankChunksWithColbert,
  searchColbertIndex,
} from './colbert-reranker.js';
import { principalSessionHash } from './principal-auth.js';
import { RuntimeHttpError } from './runtime-errors.js';
import { AuthenticatedPrincipal, SearchChunk } from '../types/index.js';

type RetrievalHistoryMessage = { role: string; content: string };
type LlmMessage = { role: string; content: string };

export interface RuntimeChatInput {
  message: string;
  conversationId?: string;
  principal: AuthenticatedPrincipal;
  wikiUrlOptions?: WikiPageUrlOptions;
  topK?: number;
  maxTopK?: number;
  aclMode?: PrincipalAclMode;
}

export interface RuntimeChatSource {
  pageId: number;
  title: string;
  namespace: number;
  pageUrl: string;
  trust: SearchChunk['trust'];
}

export interface PreparedRuntimeChat {
  conversationId: string;
  message: string;
  sessionHash: string;
  principal: AuthenticatedPrincipal;
  runtime: RuntimeConfig;
  retention: ChatRetentionConfig;
  chatTtlSeconds: number;
  messages: LlmMessage[];
  sources: RuntimeChatSource[];
  conflict: Awaited<ReturnType<typeof detectConflictsForChat>>;
}

export interface RuntimeChatCompletionResponse {
  conversationId: string;
  message: string;
  sources?: RuntimeChatSource[];
  conflict?: PreparedRuntimeChat['conflict'];
  llmAvailable?: boolean;
}

export type RuntimeChatSseWriter = (payload: Record<string, unknown> | '[DONE]') => void;

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const compact = compactText(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

export function buildChatRetrievalQuery(
  currentMessage: string,
  history: RetrievalHistoryMessage[],
  maxChars = 1200
): string {
  const parts = [compactText(currentMessage)].filter(Boolean);
  const recent = history
    .filter((historyMessage) => historyMessage.role === 'user' || historyMessage.role === 'assistant')
    .slice(-4);

  for (const historyMessage of recent) {
    const label = historyMessage.role === 'user' ? 'Предыдущий вопрос' : 'Предыдущий ответ';
    const content = truncateText(historyMessage.content, historyMessage.role === 'user' ? 320 : 220);
    if (content) parts.push(`${label}: ${content}`);
  }

  const result = parts.join('\n');
  return result.length <= maxChars ? result : result.slice(0, maxChars).trimEnd();
}

function clampTopK(topK: number | undefined, maxTopK: number | undefined): number | undefined {
  if (topK === undefined) return undefined;
  const normalized = Math.max(1, Math.trunc(topK));
  return maxTopK === undefined ? normalized : Math.min(normalized, maxTopK);
}

function chunkToSource(chunk: SearchChunk, wikiUrlOptions: WikiPageUrlOptions): RuntimeChatSource {
  return {
    pageId: chunk.pageId,
    title: chunk.title,
    namespace: chunk.namespace,
    pageUrl: chunk.pageUrl ?? buildWikiPageUrl(chunk.title, wikiUrlOptions),
    trust: chunk.trust,
  };
}

async function runCurrentSearch(query: string, topK: number | undefined, fallbackTopK: number): Promise<RagSearchResult> {
  const embedding = await getEmbedding(query);
  return searchRagChunks({
    query,
    vector: embedding,
    topK,
    fallbackTopK,
  });
}

async function runSearchWithColbertFallback(input: {
  query: string;
  topK?: number;
  fallbackTopK: number;
}): Promise<RagSearchResult | Awaited<ReturnType<typeof searchColbertIndex>>> {
  const ragConfig = await getRagAdminConfig();
  if (!isColbertFullSearchEnabled(ragConfig)) {
    return runCurrentSearch(input.query, input.topK, input.fallbackTopK);
  }

  try {
    return await searchColbertIndex({
      query: input.query,
      topK: input.topK,
      fallbackTopK: input.fallbackTopK,
      config: ragConfig,
    });
  } catch (err) {
    if (ragConfig.colbertFailMode === 'fail_search') {
      throw new RuntimeHttpError(502, {
        error: 'ColBERT search failed',
        message: err instanceof Error ? err.message : 'Unknown ColBERT search error',
      });
    }
    return runCurrentSearch(input.query, input.topK, input.fallbackTopK);
  }
}

async function filterRuntimeReadableChunks(input: {
  chunks: SearchChunk[];
  principal: AuthenticatedPrincipal;
  limit: number;
  aclMode: PrincipalAclMode;
}): Promise<SearchChunk[]> {
  if (input.aclMode === 'mediawiki_check' && input.principal.authMode !== 'oidc') {
    return filterReadableChunks(input.chunks, input.principal.sessionCookie ?? '', input.limit);
  }
  return filterReadableChunksForPrincipal(input.chunks, input.principal, input.limit, input.aclMode);
}

export async function prepareRuntimeChat(input: RuntimeChatInput): Promise<PreparedRuntimeChat> {
  const message = input.message.trim();
  const convId = input.conversationId ?? `${input.principal.userId}-${Date.now()}`;
  const sessionHash = principalSessionHash(input.principal);
  const runtime = await getRuntimeConfig();
  const chatRetention = await getChatRetentionAdminConfig();
  const chatTtlSeconds = calculateChatRetentionRedisTtlSeconds(chatRetention);

  const sqlHistory = await getSqlChatHistory(sessionHash, convId, input.principal.userId);
  const fullHistory = sqlHistory.length > 0 ? sqlHistory : await getChatHistory(sessionHash, convId);
  const history = fullHistory.slice(-4);
  const retrievalQuery = buildChatRetrievalQuery(message, history);

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
    console.error('Chat SQL history write error:', err);
  }

  const ragConfig = await getRagAdminConfig();
  const topK = clampTopK(input.topK, input.maxTopK);
  const search = await runSearchWithColbertFallback({
    query: retrievalQuery,
    topK,
    fallbackTopK: runtime.topK,
  });
  const aclMode = input.aclMode ?? 'mediawiki_check';
  const readableChunks = await filterRuntimeReadableChunks({
    chunks: search.chunks,
    principal: input.principal,
    limit: search.aclCandidateLimit,
    aclMode,
  });
  const trustedChunks = await applyTrustPolicyToChunks(
    readableChunks,
    getColbertCandidateLimit(ragConfig, search.limit)
  );
  const reranked = await rerankChunksWithColbert({
    query: retrievalQuery,
    chunks: trustedChunks,
    topK: search.limit,
    config: ragConfig,
  });
  const verifiedChunks = reranked.chunks;

  const sources = verifiedChunks.map((chunk) => chunkToSource(chunk, input.wikiUrlOptions ?? {}));
  const conflict = await detectConflictsForChat(retrievalQuery, verifiedChunks);

  await appendChatMessage(sessionHash, convId, { role: 'user', content: message }, chatTtlSeconds);

  const contextText = formatChunksForPrompt(verifiedChunks);
  const messages: LlmMessage[] = [
    { role: 'system', content: runtime.systemPrompt },
    ...(contextText ? [{ role: 'system', content: `Documents for answer:\n${contextText}` }] : []),
    ...(conflict ? [{ role: 'system', content: buildConflictInstruction(conflict) }] : []),
    ...history,
    { role: 'user', content: message },
  ];

  return {
    conversationId: convId,
    message,
    sessionHash,
    principal: input.principal,
    runtime,
    retention: chatRetention,
    chatTtlSeconds,
    messages,
    sources,
    conflict,
  };
}

export async function completeRuntimeChat(prepared: PreparedRuntimeChat): Promise<RuntimeChatCompletionResponse> {
  try {
    const response = await callLiteLLM(
      prepared.messages,
      prepared.runtime.litellmModel,
      prepared.runtime.timeoutMs
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
        console.error('Chat SQL assistant history write error:', err);
      });
    }
    return {
      conversationId: prepared.conversationId,
      message: content,
      sources: prepared.runtime.showSources ? prepared.sources : undefined,
      conflict: prepared.conflict ?? undefined,
    };
  } catch (err) {
    console.error('Chat non-streaming error:', err);
    return {
      llmAvailable: false,
      conversationId: prepared.conversationId,
      message: 'AI model temporarily unavailable. Here are the found documents:',
      sources: prepared.sources,
      conflict: prepared.conflict ?? undefined,
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

    if (prepared.conflict) {
      writeEvent({ type: 'conflict', conflict: prepared.conflict });
    }

    for await (const chunk of streamChatCompletion(
      prepared.messages,
      prepared.runtime.litellmModel,
      prepared.runtime.timeoutMs
    )) {
      const content = chunk.choices[0]?.delta?.content ?? '';
      if (content) {
        fullResponse += content;
        writeEvent({ type: 'token', content });
      }
    }

    if (prepared.runtime.showSources) {
      writeEvent({ type: 'sources', sources: prepared.sources });
    }
    writeEvent('[DONE]');
  } catch (err) {
    console.error('Chat stream error:', err);
    const errorMsg = 'AI model temporarily unavailable. Here are the found documents:';
    writeEvent({ type: 'token', content: errorMsg });
    writeEvent({ type: 'token', content: '\n\n' });

    for (const source of prepared.sources) {
      writeEvent({ type: 'token', content: `• ${source.title}\n` });
    }

    if (prepared.runtime.showSources) {
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
        console.error('Chat SQL stream history write error:', err);
      });
    }
  }
}
