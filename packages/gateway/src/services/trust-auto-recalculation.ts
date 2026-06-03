import { recalculateTrustScores, TrustRecalculationSummary } from './trust-recalculation.js';

export type TrustAutoRecalculationStatus = 'completed' | 'failed' | 'skipped';

export interface TrustAutoRecalculationResult {
  status: TrustAutoRecalculationStatus;
  reason?: string;
  jobKey?: string;
  summary?: TrustRecalculationSummary;
  error?: string;
}

const processedReindexJobs = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function buildReindexJobKey(status: Record<string, unknown>, summary: Record<string, unknown>): string | undefined {
  const startedAt = readString(status, 'startedAt') ?? readString(summary, 'startedAt');
  const finishedAt = readString(status, 'finishedAt') ?? readString(summary, 'finishedAt');
  if (!startedAt || !finishedAt) return undefined;
  return `${startedAt}:${finishedAt}`;
}

function getMaxScan(summary: Record<string, unknown>): number {
  const totalChunks = readNumber(summary, 'totalChunks') ?? 0;
  return Math.min(Math.max(totalChunks * 2, 1000), 100_000);
}

export async function maybeRecalculateTrustAfterReindex(
  syncerStatusResponse: unknown
): Promise<TrustAutoRecalculationResult> {
  if (!isRecord(syncerStatusResponse) || !isRecord(syncerStatusResponse.status)) {
    return { status: 'skipped', reason: 'invalid_reindex_status' };
  }

  const status = syncerStatusResponse.status;
  if (status.state !== 'completed') {
    return { status: 'skipped', reason: 'reindex_not_completed' };
  }

  if (!isRecord(status.summary)) {
    return { status: 'skipped', reason: 'missing_reindex_summary' };
  }

  const summary = status.summary;
  if (readBoolean(summary, 'dryRun') === true) {
    return { status: 'skipped', reason: 'reindex_dry_run' };
  }

  const jobKey = buildReindexJobKey(status, summary);
  if (!jobKey) {
    return { status: 'skipped', reason: 'missing_reindex_job_identity' };
  }
  if (processedReindexJobs.has(jobKey)) {
    return { status: 'skipped', reason: 'already_recalculated', jobKey };
  }

  try {
    const recalculationSummary = await recalculateTrustScores({
      dryRun: false,
      maxScan: getMaxScan(summary),
    });
    processedReindexJobs.add(jobKey);
    return { status: 'completed', jobKey, summary: recalculationSummary };
  } catch (err) {
    return {
      status: 'failed',
      jobKey,
      error: err instanceof Error ? err.message : 'Unknown trust recalculation error',
    };
  }
}

export function resetTrustAutoRecalculationForTests(): void {
  processedReindexJobs.clear();
}
