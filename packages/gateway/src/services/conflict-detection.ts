import { z } from 'zod';
import {
  AttachmentParentConflictMode,
  ConflictDetectionConfig,
  ConflictDetectionRunMode,
  getConflictDetectionConfig,
} from './admin-platform-config.js';
import { callLiteLLM, type ChatCompletionResponse } from './litellm.js';
import { logOperationalError } from './logging.js';
import { SearchChunk, SemanticFacts } from '../types/index.js';

export interface ConflictDetectionSourceResult {
  sourceIndex?: number;
  title: string;
  claim: string;
  trustScore?: number;
  status?: string;
}

export interface ConflictDetectionResult {
  enabled: boolean;
  checked: boolean;
  skippedReason?: 'disabled' | 'manual_mode' | 'not_enough_sources' | 'low_risk';
  hasConflict: boolean;
  lowTrust: boolean;
  confidence: number;
  summary: string;
  conflictingSources: ConflictDetectionSourceResult[];
  recommendedSourceTitle?: string;
  lowTrustReason?: string;
  metadata: {
    model: string;
    runMode: ConflictDetectionRunMode;
    sourceCount: number;
    trustGap?: number;
    attachmentParentConflictMode?: AttachmentParentConflictMode;
    attachmentParentPairs?: number;
  };
}

export interface PreparedConflictSource {
  sourceIndex: number;
  pageId: number;
  title: string;
  namespace: number;
  text: string;
  sourceType?: string;
  attachmentFilename?: string;
  attachmentMime?: string;
  trustScore?: number;
  trustFlags: string[];
  lastModified?: string;
  semanticFacts?: SemanticFacts;
  status: string;
}

export interface AttachmentParentConflictPair {
  attachmentSourceIndex: number;
  parentSourceIndex: number;
  pageId: number;
  parentTitle: string;
  attachmentFilename: string;
}

export interface AttachmentParentConflictMissingParent {
  attachmentSourceIndex: number;
  pageId: number;
  parentTitle: string;
  attachmentFilename: string;
}

export interface AttachmentParentConflictDiagnostics {
  mode: AttachmentParentConflictMode;
  pairs: AttachmentParentConflictPair[];
  missingParents: AttachmentParentConflictMissingParent[];
  riskSignal: boolean;
}

interface DetectConflictsOptions {
  config?: ConflictDetectionConfig;
  force?: boolean;
}

export interface ConflictDetectionTrace {
  request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    sourceCount: number;
    trustGap?: number;
  };
  preparedSources: PreparedConflictSource[];
  attachmentParent: AttachmentParentConflictDiagnostics;
  skippedReason?: ConflictDetectionResult['skippedReason'];
  response?: ChatCompletionResponse;
  responseContent?: string;
  parsedPayload?: ParsedConflictPayload;
  result?: ConflictDetectionResult;
}

export interface ConflictDetectionWithTrace {
  result: ConflictDetectionResult;
  trace: ConflictDetectionTrace;
}

const llmConflictSchema = z.object({
  hasConflict: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0),
  summary: z.string().trim().max(2000).default(''),
  conflictingSources: z.array(z.object({
    sourceIndex: z.number().int().positive().optional(),
    title: z.string().trim().max(500).optional(),
    claim: z.string().trim().max(1200).optional(),
    status: z.string().trim().max(500).optional(),
  }).passthrough()).max(10).default([]),
  recommendedSourceIndex: z.number().int().positive().optional(),
  recommendedSourceTitle: z.string().trim().max(500).optional(),
  lowTrustReason: z.string().trim().max(1200).optional(),
}).passthrough();

type ParsedConflictPayload = z.infer<typeof llmConflictSchema>;

const conflictTestSourceSchema = z.object({
  pageId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(500),
  text: z.string().trim().min(1).max(12000),
  namespace: z.number().int().min(0).optional(),
  trustScore: z.number().min(0).max(1).optional(),
  trustFlags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  lastModified: z.string().trim().max(80).optional(),
  semanticFacts: z.record(z.array(z.string().trim().min(1).max(500)).max(50)).optional(),
}).strict();

const conflictTestInputSchema = z.object({
  query: z.string().trim().min(1).max(1000).optional(),
  sources: z.array(conflictTestSourceSchema).min(2).max(10).optional(),
}).strict().optional();

export interface ConflictDetectionTestData {
  query: string;
  chunks: SearchChunk[];
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatSemanticFacts(facts: SemanticFacts | undefined): string {
  if (!facts) return '';
  return Object.entries(facts)
    .filter(([, values]) => values.length > 0)
    .sort(([left], [right]) => left.localeCompare(right, 'ru'))
    .map(([property, values]) => `${property}: ${values.join(', ')}`)
    .join('\n');
}

function formatSourceStatus(source: PreparedConflictSource): string {
  const parts = [
    source.trustScore === undefined ? undefined : `trustScore=${source.trustScore.toFixed(2)}`,
    source.trustFlags.length > 0 ? `flags=${source.trustFlags.join(',')}` : undefined,
    source.lastModified ? `lastModified=${source.lastModified}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join('; ');
}

function prepareSources(chunks: SearchChunk[], config: ConflictDetectionConfig): PreparedConflictSource[] {
  return chunks.slice(0, config.maxSources).map((chunk, index) => {
    const source: PreparedConflictSource = {
      sourceIndex: index + 1,
      pageId: chunk.pageId,
      title: chunk.title,
      namespace: chunk.namespace,
      text: truncateText(chunk.text, config.maxCharsPerSource),
      sourceType: chunk.sourceType,
      attachmentFilename: chunk.attachmentFilename,
      attachmentMime: chunk.attachmentMime,
      trustScore: chunk.trust?.score,
      trustFlags: chunk.trust?.flags ?? [],
      lastModified: chunk.trust?.lastModified ?? chunk.lastModified,
      semanticFacts: chunk.semanticFacts,
      status: '',
    };
    source.status = formatSourceStatus(source);
    return source;
  });
}

function isAttachmentSource(source: PreparedConflictSource): boolean {
  return source.sourceType === 'attachment' || Boolean(source.attachmentFilename);
}

export function analyzeAttachmentParentConflicts(
  sources: PreparedConflictSource[],
  mode: AttachmentParentConflictMode
): AttachmentParentConflictDiagnostics {
  const parentByPageId = new Map<number, PreparedConflictSource>();
  for (const source of sources) {
    if (isAttachmentSource(source)) continue;
    if (!parentByPageId.has(source.pageId)) parentByPageId.set(source.pageId, source);
  }

  const pairs: AttachmentParentConflictPair[] = [];
  const missingParents: AttachmentParentConflictMissingParent[] = [];
  for (const source of sources.filter(isAttachmentSource)) {
    const attachmentFilename = source.attachmentFilename || source.title;
    const parent = parentByPageId.get(source.pageId);
    if (parent) {
      pairs.push({
        attachmentSourceIndex: source.sourceIndex,
        parentSourceIndex: parent.sourceIndex,
        pageId: source.pageId,
        parentTitle: parent.title,
        attachmentFilename,
      });
      continue;
    }

    missingParents.push({
      attachmentSourceIndex: source.sourceIndex,
      pageId: source.pageId,
      parentTitle: source.title,
      attachmentFilename,
    });
  }

  return {
    mode,
    pairs,
    missingParents,
    riskSignal: mode !== 'disabled' && pairs.length > 0,
  };
}

function calculateTrustGap(sources: PreparedConflictSource[]): number | undefined {
  const scores = sources
    .map((source) => source.trustScore)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score))
    .sort((left, right) => right - left);
  if (scores.length < 2) return undefined;
  return Math.max(0, Math.min(1, scores[0] - scores[1]));
}

function skippedResult(
  config: ConflictDetectionConfig,
  sourceCount: number,
  skippedReason: ConflictDetectionResult['skippedReason'],
  trustGap?: number,
  attachmentParent?: AttachmentParentConflictDiagnostics
): ConflictDetectionResult {
  return {
    enabled: config.enabled,
    checked: false,
    skippedReason,
    hasConflict: false,
    lowTrust: false,
    confidence: 0,
    summary: '',
    conflictingSources: [],
    metadata: {
      model: config.model,
      runMode: config.runMode,
      sourceCount,
      trustGap,
      attachmentParentConflictMode: config.attachmentParentConflictMode,
      attachmentParentPairs: attachmentParent?.pairs.length ?? 0,
    },
  };
}

function shouldRunDetection(
  config: ConflictDetectionConfig,
  sources: PreparedConflictSource[],
  attachmentParent: AttachmentParentConflictDiagnostics,
  trustGap: number | undefined,
  force: boolean
): ConflictDetectionResult['skippedReason'] | undefined {
  if (!config.enabled && !force) return 'disabled';
  if (sources.length < 2) return 'not_enough_sources';
  if (config.runMode === 'manual' && !force) return 'manual_mode';
  if (config.runMode === 'risk_only' && !force) {
    if (attachmentParent.riskSignal) return undefined;
    const scores = sources.map((source) => source.trustScore);
    const hasMissingTrustScore = scores.some((score) => score === undefined);
    const hasLowTrustSource = scores.some((score) => score !== undefined && score < config.lowConfidenceThreshold);
    const hasSmallTrustGap = trustGap === undefined || trustGap < config.trustGapThreshold;
    if (!hasMissingTrustScore && !hasLowTrustSource && !hasSmallTrustGap) {
      return 'low_risk';
    }
  }
  return undefined;
}

function buildPrompt(
  query: string,
  sources: PreparedConflictSource[],
  systemPrompt: string,
  attachmentParent: AttachmentParentConflictDiagnostics
): Array<{ role: string; content: string }> {
  const parentIndexes = new Set(attachmentParent.pairs.map((pair) => pair.parentSourceIndex));
  const sourceText = sources.map((source) => {
    const semanticFacts = formatSemanticFacts(source.semanticFacts);
    const role = isAttachmentSource(source)
      ? 'attachment'
      : parentIndexes.has(source.sourceIndex) ? 'parent_page' : 'wiki_page';
    return [
      `Источник ${source.sourceIndex}`,
      `role: ${role}`,
      `title: ${source.title}`,
      `pageId: ${source.pageId}`,
      `namespace: ${source.namespace}`,
      source.sourceType ? `sourceType: ${source.sourceType}` : undefined,
      source.attachmentFilename ? `attachmentFilename: ${source.attachmentFilename}` : undefined,
      source.attachmentMime ? `attachmentMime: ${source.attachmentMime}` : undefined,
      source.status ? `trust: ${source.status}` : undefined,
      semanticFacts ? `semanticFacts:\n${semanticFacts}` : undefined,
      `text:\n${source.text}`,
    ].filter((part): part is string => Boolean(part)).join('\n');
  }).join('\n\n---\n\n');
  const attachmentParentText = attachmentParent.pairs.length > 0
    ? [
      `Режим проверки attachment vs parent_page: ${attachmentParent.mode}`,
      ...attachmentParent.pairs.map((pair) => [
        `Пара: attachment Источник ${pair.attachmentSourceIndex}`,
        `parent_page Источник ${pair.parentSourceIndex}`,
        `pageId=${pair.pageId}`,
        `parentTitle=${pair.parentTitle}`,
        `attachmentFilename=${pair.attachmentFilename}`,
      ].join('; ')),
      'Сравнивай пары только по несовместимым фактам, датам, статусам, регламентам и числовым значениям.',
      'Не отмечай конфликт, если вложение только уточняет или расширяет текст родительской страницы.',
    ].join('\n')
    : '';

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: [
        `Вопрос пользователя: ${query}`,
        attachmentParentText ? `\nAttachment-parent пары:\n${attachmentParentText}` : '',
        '',
        'Источники:',
        sourceText,
      ].join('\n'),
    },
  ];
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Conflict detector response did not contain a JSON object');
  }
  return trimmed.slice(start, end + 1);
}

function parseConflictPayload(content: string): ParsedConflictPayload {
  const parsed: unknown = JSON.parse(extractJsonObject(content));
  return llmConflictSchema.parse(parsed);
}

function sourceTitleByIndex(sources: PreparedConflictSource[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  return sources.find((source) => source.sourceIndex === index)?.title;
}

function normalizeConflictSources(
  payload: ParsedConflictPayload,
  sources: PreparedConflictSource[]
): ConflictDetectionSourceResult[] {
  return payload.conflictingSources.map((item) => {
    const source = item.sourceIndex === undefined
      ? sources.find((candidate) => candidate.title === item.title)
      : sources.find((candidate) => candidate.sourceIndex === item.sourceIndex);
    return {
      sourceIndex: item.sourceIndex,
      title: item.title || source?.title || (item.sourceIndex ? `Источник ${item.sourceIndex}` : 'Источник'),
      claim: item.claim || '',
      trustScore: source?.trustScore,
      status: item.status || source?.status,
    };
  });
}

export async function detectConflictsWithTrace(
  query: string,
  chunks: SearchChunk[],
  options: DetectConflictsOptions = {}
): Promise<ConflictDetectionWithTrace> {
  const config = options.config ?? await getConflictDetectionConfig();
  const sources = prepareSources(chunks, config);
  const trustGap = calculateTrustGap(sources);
  const attachmentParent = analyzeAttachmentParentConflicts(sources, config.attachmentParentConflictMode);
  const messages = buildPrompt(query, sources, config.systemPrompt, attachmentParent);
  const traceBase: Omit<ConflictDetectionTrace, 'response' | 'responseContent' | 'parsedPayload' | 'result'> = {
    request: {
      model: config.model,
      messages,
      sourceCount: sources.length,
      trustGap,
    },
    preparedSources: sources,
    attachmentParent,
  };
  const skippedReason = shouldRunDetection(config, sources, attachmentParent, trustGap, Boolean(options.force));
  if (skippedReason) {
    const result = skippedResult(config, sources.length, skippedReason, trustGap, attachmentParent);
    return {
      result,
      trace: {
        ...traceBase,
        skippedReason,
        result,
      },
    };
  }

  const response = await callLiteLLM(messages, config.model);
  const content = response.choices[0]?.message?.content ?? '';
  const payload = parseConflictPayload(content);
  const lowTrust = payload.confidence < config.lowConfidenceThreshold;
  const recommendedSourceTitle =
    payload.recommendedSourceTitle || sourceTitleByIndex(sources, payload.recommendedSourceIndex);

  const result: ConflictDetectionResult = {
    enabled: config.enabled,
    checked: true,
    hasConflict: payload.hasConflict,
    lowTrust,
    confidence: payload.confidence,
    summary: payload.summary,
    conflictingSources: normalizeConflictSources(payload, sources),
    recommendedSourceTitle,
    lowTrustReason: payload.lowTrustReason,
    metadata: {
      model: config.model,
      runMode: config.runMode,
      sourceCount: sources.length,
      trustGap,
      attachmentParentConflictMode: config.attachmentParentConflictMode,
      attachmentParentPairs: attachmentParent.pairs.length,
    },
  };

  return {
    result,
    trace: {
      ...traceBase,
      response,
      responseContent: content,
      parsedPayload: payload,
      result,
    },
  };
}

export async function detectConflicts(
  query: string,
  chunks: SearchChunk[],
  options: DetectConflictsOptions = {}
): Promise<ConflictDetectionResult> {
  return (await detectConflictsWithTrace(query, chunks, options)).result;
}

export async function detectConflictsForChat(
  query: string,
  chunks: SearchChunk[],
  options: DetectConflictsOptions = {}
): Promise<ConflictDetectionResult | null> {
  const config = options.config ?? await getConflictDetectionConfig();
  if (!config.showConflictBlock) return null;

  try {
    const result = await detectConflicts(query, chunks, { ...options, config });
    if (!result.checked || (!result.hasConflict && !result.lowTrust)) return null;
    return result;
  } catch (err) {
    logOperationalError('conflict_detection.error', err);
    return null;
  }
}

export function buildConflictInstruction(result: ConflictDetectionResult): string {
  const sources = result.conflictingSources
    .map((source) => `- ${source.title}: ${source.claim || 'противоречивое утверждение'}`)
    .join('\n');
  const warning = result.hasConflict
    ? 'В найденных wiki-источниках есть противоречивая информация.'
    : 'У найденных wiki-источников низкая уверенность проверки.';
  const answerPolicy = result.hasConflict
    ? 'В ответе явно предупреди пользователя, что данные конфликтуют, и не выдавай спорный факт как однозначный.'
    : 'В ответе предупреди пользователя, что сведения требуют проверки, и не выдавай их как полностью подтвержденные.';
  return [
    warning,
    answerPolicy,
    result.summary ? `Краткое резюме проверки: ${result.summary}` : undefined,
    result.hasConflict && result.recommendedSourceTitle
      ? `Если нужно выбрать основной источник, приоритетнее: ${result.recommendedSourceTitle}.`
      : undefined,
    sources ? `${result.hasConflict ? 'Конфликтующие источники' : 'Источники с пониженной надежностью'}:\n${sources}` : undefined,
  ].filter((part): part is string => Boolean(part)).join('\n');
}

export function buildConflictDetectionTestData(input: unknown): ConflictDetectionTestData {
  const parsed = conflictTestInputSchema.parse(input);
  const sources = parsed?.sources ?? [
    {
      pageId: 9001,
      title: 'CorpIT:Инструкция VPN',
      text: 'Для подключения к VPN обязательно используется MFA и корпоративный токен.',
      namespace: 3030,
      trustScore: 0.9,
      trustFlags: ['official', 'verified'],
      lastModified: '2026-01-10T09:00:00Z',
      semanticFacts: { 'Тип документа': ['Инструкция'], 'Статус документа': ['Утвержден'] },
    },
    {
      pageId: 9002,
      title: 'CorpIT:FAQ VPN',
      text: 'Временный доступ к VPN можно выдать без MFA по заявке руководителя.',
      namespace: 3030,
      trustScore: 0.55,
      trustFlags: ['faq', 'manual-review'],
      lastModified: '2023-05-20T09:00:00Z',
      semanticFacts: { 'Тип документа': ['FAQ'], 'Статус документа': ['Требует проверки'] },
    },
  ];

  return {
    query: parsed?.query ?? 'Можно ли подключиться к VPN без MFA?',
    chunks: sources.map((source, index): SearchChunk => ({
      id: index + 1,
      pageId: source.pageId ?? 9000 + index,
      title: source.title,
      text: source.text,
      namespace: source.namespace ?? 0,
      allowedGroups: ['*'],
      score: 1,
      lastModified: source.lastModified,
      semanticFacts: source.semanticFacts,
      trust: source.trustScore === undefined ? undefined : {
        modelId: 'admin-conflict-test',
        score: source.trustScore,
        lastModified: source.lastModified,
        stalenessPenalty: 0,
        flags: source.trustFlags ?? [],
        appliedEntityIds: [],
        appliedRuleIds: [],
        decisions: {
          includeInContext: true,
          allowDirectAnswer: true,
          excludeFromIndex: false,
          requireManualApproval: false,
          notifyAuthor: false,
          requireSources: true,
        },
      },
    })),
  };
}
