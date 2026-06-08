import { randomUUID } from 'node:crypto';
import { ReindexOptions, ReindexProgress, ReindexSummary, runReindex, validateReindexPreflight } from './reindex.js';
import { config } from '../config.js';
import { setSchedulerLockStatus } from './metrics.js';
import { acquireRedisLock, readJson, writeJson } from './redis.js';

export type ReindexJobState = 'idle' | 'running' | 'completed' | 'failed';

export interface ReindexJobStatus {
  state: ReindexJobState;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: ReindexProgress;
  summary?: ReindexSummary;
  error?: string;
}

let currentJob: ReindexJobStatus = { state: 'idle' };
const REINDEX_STATUS_KEY = 'syncer:reindex:status';
const REINDEX_LOCK_KEY = 'syncer:reindex:lock';

export function getReindexJobStatus(): ReindexJobStatus {
  return currentJob;
}

export async function getSharedReindexJobStatus(): Promise<ReindexJobStatus> {
  return (await readJson<ReindexJobStatus>(REINDEX_STATUS_KEY)) ?? currentJob;
}

async function setReindexJobStatus(status: ReindexJobStatus): Promise<void> {
  currentJob = status;
  await writeJson(REINDEX_STATUS_KEY, status, Math.max(config.reindexLockTtlSeconds, 3600));
}

export async function startReindexJob(options: ReindexOptions = {}): Promise<ReindexJobStatus> {
  if (currentJob.state === 'running') {
    throw new Error('Reindex job is already running');
  }
  await validateReindexPreflight(options);
  const lock = await acquireRedisLock(REINDEX_LOCK_KEY, config.reindexLockTtlSeconds);
  if (!lock) {
    throw new Error('Reindex job is already running on another replica');
  }
  setSchedulerLockStatus('syncer_reindex', true);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  await setReindexJobStatus({
    state: 'running',
    runId,
    startedAt,
    progress: {
      phase: 'started',
      runId,
      profileId: options.profileId,
      source: options.source ?? 'mediawiki',
      startedAt,
      elapsedMs: 0,
      dryRun: options.dryRun,
      namespaces: options.namespaces,
      limitApplied: options.maxPages,
      matchedPages: 0,
      totalPages: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      totalChunks: 0,
      indexTargets: options.indexTargets,
      embeddingCalls: 0,
      llmEnrichmentCalls: 0,
      estimatedPaidCalls: 0,
      targetWrites: {},
      colbertPagesIndexed: 0,
      colbertChunksIndexed: 0,
      colbertFailures: 0,
      colbertModel: options.colbertModel,
      colbertCollection: options.colbertCollection,
      denseCollection: config.qdrantCollection,
      attachmentsRequested: Boolean(options.attachmentsEnabled),
      attachmentsActive: false,
      documentPolicyEnabled: false,
      attachmentsFound: 0,
      attachmentsProcessed: 0,
      attachmentsFailed: 0,
      attachmentsSkippedDisabled: 0,
      attachmentsSkippedNoInfo: 0,
      attachmentsSkippedNoDownload: 0,
      attachmentsSkippedEmpty: 0,
      attachmentTargetWrites: {},
    },
  });

  void runReindex({ ...options, runId }, (progress) => {
    void setReindexJobStatus({ ...currentJob, runId, startedAt, progress });
  }).then((summary) => {
    return setReindexJobStatus({
      state: 'completed',
      runId,
      startedAt,
      finishedAt: summary.finishedAt,
      progress: {
        phase: 'complete',
        runId: summary.runId,
        profileId: summary.profileId,
        source: summary.source,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        elapsedMs: summary.elapsedMs,
        dryRun: summary.dryRun,
        namespaces: summary.namespaces,
        matchedPages: summary.matchedPages,
        limitApplied: summary.limitApplied,
        totalPages: summary.totalPages,
        processed: summary.processed,
        skipped: summary.skipped,
        failed: summary.failed,
        totalChunks: summary.totalChunks,
        indexTargets: summary.indexTargets,
        embeddingCalls: summary.embeddingCalls,
        llmEnrichmentCalls: summary.llmEnrichmentCalls,
        estimatedPaidCalls: summary.estimatedPaidCalls,
        targetWrites: summary.targetWrites,
        colbertPagesIndexed: summary.colbertPagesIndexed,
        colbertChunksIndexed: summary.colbertChunksIndexed,
        colbertFailures: summary.colbertFailures,
        colbertModel: summary.colbertModel,
        colbertCollection: summary.colbertCollection,
        denseCollection: summary.denseCollection,
        qdrantPayloadPoints: summary.qdrantPayloadPoints,
        qdrantPayloadPages: summary.qdrantPayloadPages,
        qdrantPayloadChunks: summary.qdrantPayloadChunks,
        attachmentsRequested: summary.attachmentsRequested,
        attachmentsActive: summary.attachmentsActive,
        documentPolicyEnabled: summary.documentPolicyEnabled,
        attachmentsFound: summary.attachmentsFound,
        attachmentsProcessed: summary.attachmentsProcessed,
        attachmentsFailed: summary.attachmentsFailed,
        attachmentsSkippedDisabled: summary.attachmentsSkippedDisabled,
        attachmentsSkippedNoInfo: summary.attachmentsSkippedNoInfo,
        attachmentsSkippedNoDownload: summary.attachmentsSkippedNoDownload,
        attachmentsSkippedEmpty: summary.attachmentsSkippedEmpty,
        attachmentTargetWrites: summary.attachmentTargetWrites,
      },
      summary,
    });
  }).catch((err) => {
    return setReindexJobStatus({
      state: 'failed',
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      progress: currentJob.progress,
      error: err instanceof Error ? err.message : 'Unknown reindex error',
    });
  }).finally(() => {
    setSchedulerLockStatus('syncer_reindex', false);
    void lock.release();
  });

  return currentJob;
}
