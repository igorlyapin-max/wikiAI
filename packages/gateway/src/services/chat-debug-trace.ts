import { z } from 'zod';
import {
  callLiteLLMWithTrace,
  type ChatCompletionResponse,
  type LiteLLMChatTrace,
} from './litellm.js';
import { logOperationalEvent } from './logging.js';
import { type WikiPageUrlOptions } from './mediawiki-url.js';
import {
  getOpenSearchAttachmentDiagnostics,
  type OpenSearchAttachmentDiagnostics,
} from './opensearch.js';
import { prepareRuntimeChat, type RuntimeChatDebugTrace } from './runtime-chat.js';
import { getKnowledgeSourceProfileConfig } from './knowledge-sources.js';
import {
  getSearchIndexAttachmentDiagnostics,
  type SearchIndexAttachmentDiagnostics,
} from './search-index.js';
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

interface PromptStackItem {
  index: number;
  role: string;
  label: string;
  chars: number;
  content: string;
}

interface AttachmentIndexCoverage {
  filename: string;
  searchIndex: SearchIndexAttachmentDiagnostics;
  opensearch: OpenSearchAttachmentDiagnostics;
  mismatch: boolean;
}

interface SerializedChunk {
  id: number;
  sourceId?: string;
  documentId?: string;
  displayTitle?: string;
  sourceUrl?: string;
  spaceKey?: string;
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
  attachmentFilename?: string;
  attachmentMime?: string;
  attachmentProcessingMode?: string;
  contentType?: string;
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
    trace: LiteLLMChatTrace;
    request: LiteLLMChatTrace['request'];
    status: 'ok' | 'error';
    response?: ChatCompletionResponse;
    error?: string;
  };
  retrieval: {
    ragConfig: RuntimeChatDebugTrace['ragConfig'];
    chatProfile: RuntimeChatDebugTrace['chatProfile'];
    search: RuntimeChatDebugTrace['search'];
    sourceFanout: RuntimeChatDebugTrace['sourceFanout'];
    knowledgeSourceWarnings: RuntimeChatDebugTrace['knowledgeSourceWarnings'];
    chunks: Record<keyof RuntimeChatDebugTrace['chunks'], SerializedChunk[]>;
    attachmentIndexCoverage: AttachmentIndexCoverage[];
    contextText?: string;
  };
  conflict?: RuntimeChatDebugTrace['conflictTrace'];
  promptStack: PromptStackItem[];
  promptText: string;
}

function traceId(): string {
  return `chat-debug-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function limitText(value: string, maxChars: number | undefined): string {
  if (maxChars === undefined || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
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
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    displayTitle: chunk.displayTitle,
    sourceUrl: chunk.sourceUrl,
    spaceKey: chunk.spaceKey,
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
    attachmentFilename: chunk.attachmentFilename,
    attachmentMime: chunk.attachmentMime,
    attachmentProcessingMode: chunk.attachmentProcessingMode,
    contentType: chunk.contentType,
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

function promptLabel(message: LlmMessage, index: number): string {
  if (message.role === 'system' && index === 0) return 'base system prompt';
  if (message.role === 'system' && message.content.startsWith('Documents for answer:')) return 'retrieval context';
  if (message.role === 'system') return 'system instruction';
  if (message.role === 'user') return 'current user question';
  if (message.role === 'assistant') return 'prompt history assistant answer';
  return 'prompt history';
}

function promptStack(messages: LlmMessage[], verbosity: ChatDebugTraceVerbosity): PromptStackItem[] {
  return messages.map((message, index) => {
    const visibleMessage = messageForVerbosity(message, verbosity);
    return {
      index: index + 1,
      role: message.role,
      label: promptLabel(message, index),
      chars: message.content.length,
      content: visibleMessage.content,
    };
  });
}

function attachmentFilenamesFromText(value: string): string[] {
  const matches = value.match(/[^\s"'<>]+?\.(?:pptx|ppt|docx|doc|xlsx|xls|pdf|txt|odt|ods|odp|png|jpe?g|webp)/giu) ?? [];
  return matches.map((item) => item.replace(/[),.;:!?]+$/u, ''));
}

function attachmentFilenamesFromChunks(chunks: RuntimeChatDebugTrace['chunks']): string[] {
  return Object.values(chunks)
    .flat()
    .map((chunk) => chunk.attachmentFilename)
    .filter((filename): filename is string => typeof filename === 'string' && filename.trim().length > 0);
}

function uniqueAttachmentFilenames(filenames: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const filename of filenames) {
    const trimmed = filename.trim();
    if (trimmed) byLower.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(byLower.values()).slice(0, 10);
}

async function getAttachmentIndexCoverage(filenames: string[]): Promise<AttachmentIndexCoverage[]> {
  return Promise.all(filenames.map(async (filename) => {
    const [searchIndex, opensearch] = await Promise.all([
      getSearchIndexAttachmentDiagnostics(filename, 5),
      getOpenSearchAttachmentDiagnostics(filename, 5),
    ]);
    return {
      filename,
      searchIndex,
      opensearch,
      mismatch: searchIndex.chunks > 0 && opensearch.chunks < searchIndex.chunks,
    };
  }));
}

export async function runAdminChatDebugTrace(input: unknown, options: {
  principal: AuthenticatedPrincipal;
  wikiUrlOptions?: WikiPageUrlOptions;
}): Promise<ChatDebugTraceResponse> {
  const parsed = chatDebugTraceSchema.parse(input);
  const id = traceId();
  const sourceProfile = await getKnowledgeSourceProfileConfig();
  const prepared = await prepareRuntimeChat({
    message: parsed.message,
    conversationId: id,
    principal: options.principal,
    wikiUrlOptions: options.wikiUrlOptions,
    topK: parsed.topK,
    retrievalProfileId: parsed.retrievalProfileId ?? sourceProfile.retrievalProfileId,
    retrievalProfileSurface: 'mediawiki',
    knowledgeSourceProfileId: sourceProfile.id,
    sourceIds: sourceProfile.sourceIds,
    sourceFailurePolicy: sourceProfile.failurePolicy,
    aclMode: 'mediawiki_check',
    dryRun: true,
    disableHistory: true,
    runConflictDetection: parsed.runConflictDetection,
    includeDebugTrace: true,
  });

  const tracedLlm = await callLiteLLMWithTrace(
    prepared.messages,
    prepared.responseSettings.litellmModel,
    prepared.responseSettings.timeoutMs,
    {
      temperature: prepared.responseSettings.temperature,
      maxTokens: prepared.responseSettings.maxTokens,
    }
  );
  const response = tracedLlm.response;
  const llmError = tracedLlm.error;
  const answer = response?.choices[0]?.message?.content ?? '';
  const debug = prepared.debugTrace;
  if (!debug) {
    throw new Error('Debug trace was not collected');
  }

  const visibleMessages = prepared.messages.map((message) => messageForVerbosity(message, parsed.verbosity));
  const visibleTrace: LiteLLMChatTrace = {
    ...tracedLlm.trace,
    request: {
      ...tracedLlm.trace.request,
      body: {
        ...tracedLlm.trace.request.body,
        messages: visibleMessages,
      },
    },
  };
  const attachmentIndexCoverage = await getAttachmentIndexCoverage(uniqueAttachmentFilenames([
    ...attachmentFilenamesFromText(parsed.message),
    ...attachmentFilenamesFromChunks(debug.chunks),
  ]));

  logOperationalEvent('debug', 'chat.admin_debug_trace', {
    traceId: id,
    verbosity: parsed.verbosity,
    messageChars: parsed.message.length,
    retrievalProfileId: parsed.retrievalProfileId ?? null,
    topK: parsed.topK ?? null,
    runConflictDetection: parsed.runConflictDetection,
    promptMessageCount: prepared.messages.length,
    contextChunks: debug.chunks.context.length,
    attachmentCoverageChecks: attachmentIndexCoverage.length,
    llmStatus: response ? 'ok' : 'error',
  });

  return {
    traceId: id,
    verbosity: parsed.verbosity,
    answer,
    diagnostics: prepared.retrievalDiagnostics,
    finalLlm: {
      trace: visibleTrace,
      request: visibleTrace.request,
      status: response ? 'ok' : 'error',
      ...(response ? { response } : {}),
      ...(llmError ? { error: llmError } : {}),
    },
    retrieval: {
      ragConfig: debug.ragConfig,
      chatProfile: debug.chatProfile,
      search: debug.search,
      sourceFanout: debug.sourceFanout,
      knowledgeSourceWarnings: debug.knowledgeSourceWarnings,
      chunks: serializeChunks(debug.chunks, parsed.verbosity),
      attachmentIndexCoverage,
      contextText: parsed.verbosity === 'basic' ? undefined : debug.contextText,
    },
    conflict: debug.conflictTrace,
    promptStack: promptStack(prepared.messages, parsed.verbosity),
    promptText: promptText(visibleMessages),
  };
}
