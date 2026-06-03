import { config } from '../config.js';
import { SearchChunk, SemanticFacts } from '../types/index.js';
import { getTrustModels, previewTrustModel } from './admin-platform-config.js';
import { qdrant } from './qdrant.js';
import { buildTrustPreviewPayload } from './trust-runtime.js';

type ScrollOffset = number | string | Record<string, unknown> | null | undefined;
type PointId = number | string;

export interface TrustRecalculationOptions {
  modelId?: string;
  dryRun?: boolean;
  batchSize?: number;
  maxScan?: number;
  pageId?: number;
}

export interface TrustRecalculationSummary {
  collection: string;
  modelId: string;
  dryRun: boolean;
  pageId?: number;
  scannedPoints: number;
  eligiblePoints: number;
  updatedPoints: number;
  skippedPoints: number;
  failedPoints: number;
  scanComplete: boolean;
  sample: Array<{
    pointId: PointId;
    pageId: number;
    title: string;
    trustScore: number;
    trustFlags: string[];
    includeInContext: boolean;
    appliedRules: string[];
    error?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
          .filter((item) => item.length > 0)
      )
    );
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  return [];
}

function readSemanticFacts(payload: Record<string, unknown>): SemanticFacts | undefined {
  const rawFacts = payload.semantic_facts;
  if (!isRecord(rawFacts)) return undefined;

  const facts: SemanticFacts = {};
  for (const [property, rawValues] of Object.entries(rawFacts)) {
    const values = toStringArray(rawValues);
    if (values.length > 0) facts[property] = values;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function pointId(value: unknown): PointId | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function chunkFromPoint(id: PointId, payload: Record<string, unknown>): SearchChunk | null {
  const pageId = readNumber(payload, 'page_id');
  const namespace = readNumber(payload, 'namespace');
  const title = readString(payload, 'title');
  if (pageId === undefined || namespace === undefined || !title) return null;

  return {
    id: typeof id === 'number' ? id : pageId,
    pageId,
    title,
    text: readString(payload, 'text') ?? '',
    namespace,
    allowedGroups: toStringArray(payload.allowed_groups),
    score: 0,
    lastModified: readString(payload, 'last_modified'),
    semanticFacts: readSemanticFacts(payload),
  };
}

function normalizePageId(pageId: number | undefined): number | undefined {
  return typeof pageId === 'number' && Number.isInteger(pageId) && pageId > 0 ? pageId : undefined;
}

function normalizeOptions(
  options: TrustRecalculationOptions
): Required<Omit<TrustRecalculationOptions, 'modelId' | 'pageId'>> & {
  modelId?: string;
  pageId?: number;
} {
  return {
    modelId: options.modelId,
    dryRun: options.dryRun ?? true,
    batchSize: Math.min(Math.max(options.batchSize ?? 128, 1), 500),
    maxScan: Math.min(Math.max(options.maxScan ?? 1000, 1), 100_000),
    pageId: normalizePageId(options.pageId),
  };
}

export async function recalculateTrustScores(
  options: TrustRecalculationOptions = {}
): Promise<TrustRecalculationSummary> {
  const normalized = normalizeOptions(options);
  const models = await getTrustModels();
  const model = normalized.modelId
    ? models.find((item) => item.id === normalized.modelId)
    : models.find((item) => item.active) ?? models[0];
  if (!model) throw new Error('No trust model configured');

  let offset: ScrollOffset;
  let scannedPoints = 0;
  let eligiblePoints = 0;
  let updatedPoints = 0;
  let skippedPoints = 0;
  let failedPoints = 0;
  const sample: TrustRecalculationSummary['sample'] = [];

  do {
    const remaining = normalized.maxScan - scannedPoints;
    if (remaining <= 0) break;

    const page = await qdrant.scroll(config.qdrantCollection, {
      limit: Math.min(normalized.batchSize, remaining),
      offset,
      filter: normalized.pageId
        ? { must: [{ key: 'page_id', match: { value: normalized.pageId } }] }
        : undefined,
      with_payload: true,
      with_vector: false,
    });

    scannedPoints += page.points.length;
    for (const point of page.points) {
      const id = pointId(point.id);
      if (id === undefined || !isRecord(point.payload)) {
        skippedPoints++;
        continue;
      }
      const chunk = chunkFromPoint(id, point.payload);
      if (!chunk) {
        skippedPoints++;
        continue;
      }

      eligiblePoints++;
      try {
        const preview = await previewTrustModel(model.id, buildTrustPreviewPayload(chunk));
        const payload = {
          trust_score: preview.score,
          trust_flags: preview.flags,
          applied_rules: preview.appliedRules.map((rule) => rule.id),
          applied_entities: preview.appliedEntities.map((entity) => entity.id),
          trust_model_id: preview.modelId,
          trust_include_in_context: preview.decisions.includeInContext,
          trust_allow_direct_answer: preview.decisions.allowDirectAnswer,
          trust_exclude_from_index: preview.decisions.excludeFromIndex,
          trust_require_manual_approval: preview.decisions.requireManualApproval,
          trust_notify_author: preview.decisions.notifyAuthor,
          trust_require_sources: preview.decisions.requireSources,
          trust_calculated_at: new Date().toISOString(),
        };

        if (!normalized.dryRun) {
          await qdrant.setPayload(config.qdrantCollection, {
            points: [id],
            payload,
            wait: true,
          });
          updatedPoints++;
        }

        if (sample.length < 10) {
          sample.push({
            pointId: id,
            pageId: chunk.pageId,
            title: chunk.title,
            trustScore: preview.score,
            trustFlags: preview.flags,
            includeInContext: preview.decisions.includeInContext,
            appliedRules: preview.appliedRules.map((rule) => rule.id),
          });
        }
      } catch (err) {
        failedPoints++;
        if (sample.length < 10) {
          sample.push({
            pointId: id,
            pageId: chunk.pageId,
            title: chunk.title,
            trustScore: 0,
            trustFlags: [],
            includeInContext: false,
            appliedRules: [],
            error: err instanceof Error ? err.message : 'Unknown trust recalculation error',
          });
        }
      }
    }

    offset = page.next_page_offset;
  } while (offset !== undefined && offset !== null);

  return {
    collection: config.qdrantCollection,
    modelId: model.id,
    dryRun: normalized.dryRun,
    pageId: normalized.pageId,
    scannedPoints,
    eligiblePoints,
    updatedPoints,
    skippedPoints,
    failedPoints,
    scanComplete: offset === undefined || offset === null,
    sample,
  };
}
