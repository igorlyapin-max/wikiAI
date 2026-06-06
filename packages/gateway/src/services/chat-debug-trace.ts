import { z } from 'zod';
import { callLiteLLM, type ChatCompletionResponse } from './litellm.js';
import { logOperationalEvent } from './logging.js';
import { type WikiPageUrlOptions } from './mediawiki-url.js';
import { prepareRuntimeChat, type RuntimeChatDebugTrace } from './runtime-chat.js';
import { AuthenticatedPrincipal, SearchChunk } from '../types/index.js';

const chatDebugTraceSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  retrievalProfileId: z.string().trim().min(1).max(120).optional(),
  topK: z.number().int().min(1).max(20).optional(),
  verbosity: z.enum(['basic', 'verbose', 'full']).default('full'),
  runConflictDetection: z.boolean().default(true),
}).strict();

type ChatDebugTraceInput = z.infer<typeof chatDebugTraceSchema>;
type ChatDebugTraceVerbosity = ChatDebugTraceInput['verbosity'];
type LlmMessage = { role: string; content: string };

interface LlmRequestTrace {
  model: string;
  timeoutMs: number;
  body: {
    model: string;
    messages: LlmMessage[];
    stream: false;
    temperature: number;
    max_tokens: number;
  };
}

interface SerializedChunk {
  id: number;
  pageId: number;
  title: string;
  namespace: number;
  score: number;
  scores?: SearchChunk['scores'];
  sourceType?: string;
  chunkIndex?: number;
  totalChunks?: number;
  lastModified?: string;
  lexicalRank?: number;
  lexicalMatchedTerms?: string[];
  trust?: SearchChunk['trust'];
  semanticFacts?: SearchChunk['semanticFacts'];
  text?: string;
}

export interface ChatDebugTraceResponse {
  traceId: string;
  verbosity: ChatDebugTraceVerbosity;
  answer: string;
  diagnostics: Record<string, unknown>;
  finalLlm: {
    request: LlmRequestTrace;
    status: 'ok' | 'error';
    response?: ChatCompletionResponse;
    error?: string;
  };
  retrieval: {
    ragConfig: RuntimeChatDebugTrace['ragConfig'];
    chatProfile: RuntimeChatDebugTrace['chatProfile'];
    search: RuntimeChatDebugTrace['search'];
    chunks: Record<keyof RuntimeChatDebugTrace['chunks'], SerializedChunk[]>;
    contextText?: string;
  };
  conflict?: RuntimeChatDebugTrace['conflictTrace'];
  promptText: string;
}

function traceId(): string {
  return `chat-debug-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function limitText(value: string, maxChars: number | undefined): string {
  if (maxChars === undefined || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function messageForVerbosity(message: LlmMessage, verbosity: ChatDebugTraceVerbosity): LlmMessage {
  if (verbosity !== 'basic') return message;
  return {
    role: message.role,
    content: limitText(message.content, 500),
  };
}

function chunkTextLimit(verbosity: ChatDebugTraceVerbosity): number | undefined {
  if (verbosity === 'full') return undefined;
  if (verbosity === 'verbose') return 4000;
  return 0;
}

function serializeChunk(chunk: SearchChunk, verbosity: ChatDebugTraceVerbosity): SerializedChunk {
  const extra = chunk as SearchChunk & {
    lexicalRank?: number;
    lexicalMatchedTerms?: string[];
  };
  const textLimit = chunkTextLimit(verbosity);
  return {
    id: chunk.id,
    pageId: chunk.pageId,
    title: chunk.title,
    namespace: chunk.namespace,
    score: chunk.score,
    scores: chunk.scores,
    sourceType: chunk.sourceType,
    chunkIndex: chunk.chunkIndex,
    totalChunks: chunk.totalChunks,
    lastModified: chunk.lastModified,
    lexicalRank: extra.lexicalRank,
    lexicalMatchedTerms: extra.lexicalMatchedTerms,
    trust: chunk.trust,
    semanticFacts: verbosity === 'basic' ? undefined : chunk.semanticFacts,
    text: textLimit === 0 ? undefined : limitText(chunk.text, textLimit),
  };
}

function serializeChunks(
  chunks: RuntimeChatDebugTrace['chunks'],
  verbosity: ChatDebugTraceVerbosity
): Record<keyof RuntimeChatDebugTrace['chunks'], SerializedChunk[]> {
  return {
    raw: chunks.raw.map((chunk) => serializeChunk(chunk, verbosity)),
    readable: chunks.readable.map((chunk) => serializeChunk(chunk, verbosity)),
    trusted: chunks.trusted.map((chunk) => serializeChunk(chunk, verbosity)),
    reranked: chunks.reranked.map((chunk) => serializeChunk(chunk, verbosity)),
    context: chunks.context.map((chunk) => serializeChunk(chunk, verbosity)),
  };
}

function promptText(messages: LlmMessage[]): string {
  return messages
    .map((message, index) => `### ${index + 1}. ${message.role}\n${message.content}`)
    .join('\n\n');
}

export async function runAdminChatDebugTrace(input: unknown, options: {
  principal: AuthenticatedPrincipal;
  wikiUrlOptions?: WikiPageUrlOptions;
}): Promise<ChatDebugTraceResponse> {
  const parsed = chatDebugTraceSchema.parse(input);
  const id = traceId();
  const prepared = await prepareRuntimeChat({
    message: parsed.message,
    conversationId: id,
    principal: options.principal,
    wikiUrlOptions: options.wikiUrlOptions,
    topK: parsed.topK,
    retrievalProfileId: parsed.retrievalProfileId,
    retrievalProfileSurface: 'mediawiki',
    aclMode: 'mediawiki_check',
    dryRun: true,
    disableHistory: true,
    runConflictDetection: parsed.runConflictDetection,
    includeDebugTrace: true,
  });

  const request: LlmRequestTrace = {
    model: prepared.runtime.litellmModel,
    timeoutMs: prepared.runtime.timeoutMs,
    body: {
      model: prepared.runtime.litellmModel,
      messages: prepared.messages.map((message) => messageForVerbosity(message, parsed.verbosity)),
      stream: false,
      temperature: prepared.runtime.temperature,
      max_tokens: prepared.runtime.maxTokens,
    },
  };

  let response: ChatCompletionResponse | undefined;
  let llmError: string | undefined;
  try {
    response = await callLiteLLM(
      prepared.messages,
      prepared.runtime.litellmModel,
      prepared.runtime.timeoutMs
    );
  } catch (err) {
    llmError = err instanceof Error ? err.message : 'Unknown LiteLLM error';
  }
  const answer = response?.choices[0]?.message?.content ?? '';
  const debug = prepared.debugTrace;
  if (!debug) {
    throw new Error('Debug trace was not collected');
  }

  logOperationalEvent('debug', 'chat.admin_debug_trace', {
    traceId: id,
    verbosity: parsed.verbosity,
    messageChars: parsed.message.length,
    retrievalProfileId: parsed.retrievalProfileId ?? null,
    topK: parsed.topK ?? null,
    runConflictDetection: parsed.runConflictDetection,
    promptMessageCount: prepared.messages.length,
    contextChunks: debug.chunks.context.length,
    llmStatus: response ? 'ok' : 'error',
  });

  return {
    traceId: id,
    verbosity: parsed.verbosity,
    answer,
    diagnostics: prepared.retrievalDiagnostics,
    finalLlm: {
      request,
      status: response ? 'ok' : 'error',
      ...(response ? { response } : {}),
      ...(llmError ? { error: llmError } : {}),
    },
    retrieval: {
      ragConfig: debug.ragConfig,
      chatProfile: debug.chatProfile,
      search: debug.search,
      chunks: serializeChunks(debug.chunks, parsed.verbosity),
      contextText: parsed.verbosity === 'basic' ? undefined : debug.contextText,
    },
    conflict: debug.conflictTrace,
    promptText: promptText(prepared.messages.map((message) => messageForVerbosity(message, parsed.verbosity))),
  };
}
