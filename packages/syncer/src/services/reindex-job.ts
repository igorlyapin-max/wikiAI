import { ReindexOptions, ReindexProgress, ReindexSummary, runReindex, validateReindexPreflight } from './reindex.js';

export type ReindexJobState = 'idle' | 'running' | 'completed' | 'failed';

export interface ReindexJobStatus {
  state: ReindexJobState;
  startedAt?: string;
  finishedAt?: string;
  progress?: ReindexProgress;
  summary?: ReindexSummary;
  error?: string;
}

let currentJob: ReindexJobStatus = { state: 'idle' };

export function getReindexJobStatus(): ReindexJobStatus {
  return currentJob;
}

export async function startReindexJob(options: ReindexOptions = {}): Promise<ReindexJobStatus> {
  if (currentJob.state === 'running') {
    throw new Error('Reindex job is already running');
  }
  await validateReindexPreflight(options);

  const startedAt = new Date().toISOString();
  currentJob = {
    state: 'running',
    startedAt,
    progress: {
      phase: 'started',
      profileId: options.profileId,
      dryRun: options.dryRun,
      namespaces: options.namespaces,
      limitApplied: options.maxPages,
      matchedPages: 0,
      totalPages: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      totalChunks: 0,
      embeddingCalls: 0,
      llmEnrichmentCalls: 0,
      estimatedPaidCalls: 0,
    },
  };

  void runReindex(options, (progress) => {
    currentJob = { ...currentJob, progress };
  }).then((summary) => {
    currentJob = {
      state: 'completed',
      startedAt,
      finishedAt: summary.finishedAt,
      progress: {
        phase: 'complete',
        profileId: summary.profileId,
        dryRun: summary.dryRun,
        namespaces: summary.namespaces,
        matchedPages: summary.matchedPages,
        limitApplied: summary.limitApplied,
        totalPages: summary.totalPages,
        processed: summary.processed,
        skipped: summary.skipped,
        failed: summary.failed,
        totalChunks: summary.totalChunks,
        embeddingCalls: summary.embeddingCalls,
        llmEnrichmentCalls: summary.llmEnrichmentCalls,
        estimatedPaidCalls: summary.estimatedPaidCalls,
      },
      summary,
    };
  }).catch((err) => {
    currentJob = {
      state: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      progress: currentJob.progress,
      error: err instanceof Error ? err.message : 'Unknown reindex error',
    };
  });

  return currentJob;
}
