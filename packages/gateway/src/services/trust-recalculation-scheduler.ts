import { getTrustRecalculationAdminConfig, TrustRecalculationConfig } from './admin-platform-config.js';
import { recalculateTrustScores, TrustRecalculationSummary } from './trust-recalculation.js';

const SCHEDULER_TICK_MS = 60_000;

export interface TrustRecalculationSchedulerStatus {
  enabled: boolean;
  intervalMinutes: number;
  maxScan: number;
  batchSize: number;
  running: boolean;
  nextRunAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResult?: TrustRecalculationSummary;
  lastError?: string;
}

let schedulerTimer: NodeJS.Timeout | undefined;
let running = false;
let nextRunAt: Date | undefined;
let lastStartedAt: string | undefined;
let lastFinishedAt: string | undefined;
let lastResult: TrustRecalculationSummary | undefined;
let lastError: string | undefined;

function calculateNextRun(config: Pick<TrustRecalculationConfig, 'intervalMinutes'>, from: Date): Date {
  return new Date(from.getTime() + config.intervalMinutes * 60_000);
}

export function resetTrustRecalculationSchedulerForTests(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
  running = false;
  nextRunAt = undefined;
  lastStartedAt = undefined;
  lastFinishedAt = undefined;
  lastResult = undefined;
  lastError = undefined;
}

export async function getTrustRecalculationSchedulerStatus(): Promise<TrustRecalculationSchedulerStatus> {
  const config = await getTrustRecalculationAdminConfig();
  return {
    ...config,
    running,
    nextRunAt: nextRunAt?.toISOString(),
    lastStartedAt,
    lastFinishedAt,
    lastResult,
    lastError,
  };
}

export async function runScheduledTrustRecalculationOnce(now = new Date()): Promise<void> {
  const config = await getTrustRecalculationAdminConfig();
  if (!config.enabled) {
    nextRunAt = undefined;
    return;
  }

  if (!nextRunAt) {
    nextRunAt = calculateNextRun(config, now);
    return;
  }
  if (running || now.getTime() < nextRunAt.getTime()) return;

  running = true;
  lastStartedAt = now.toISOString();
  lastError = undefined;

  try {
    lastResult = await recalculateTrustScores({
      dryRun: false,
      maxScan: config.maxScan,
      batchSize: config.batchSize,
    });
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'Unknown scheduled trust recalculation error';
  } finally {
    const finishedAt = new Date();
    lastFinishedAt = finishedAt.toISOString();
    nextRunAt = calculateNextRun(config, finishedAt);
    running = false;
  }
}

export function startTrustRecalculationScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void runScheduledTrustRecalculationOnce();
  }, SCHEDULER_TICK_MS);
}

export function stopTrustRecalculationScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}
