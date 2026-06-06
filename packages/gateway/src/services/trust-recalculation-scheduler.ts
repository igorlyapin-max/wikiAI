import { getTrustRecalculationAdminConfig, TrustRecalculationConfig } from './admin-platform-config.js';
import { recalculateTrustScores, TrustRecalculationSummary } from './trust-recalculation.js';
import { config as appConfig } from '../config.js';
import { setSchedulerLockStatus } from './metrics.js';
import { acquireRedisLock, readJson, redis, writeJson } from './redis.js';

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
const STATUS_KEY = 'gateway:trust-recalculation-scheduler:status';
const LOCK_KEY = 'gateway:trust-recalculation-scheduler:lock';

type PersistedTrustSchedulerState = Pick<
  TrustRecalculationSchedulerStatus,
  'running' | 'nextRunAt' | 'lastStartedAt' | 'lastFinishedAt' | 'lastResult' | 'lastError'
>;

function calculateNextRun(config: Pick<TrustRecalculationConfig, 'intervalMinutes'>, from: Date): Date {
  return new Date(from.getTime() + config.intervalMinutes * 60_000);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
  void redis.del(STATUS_KEY, LOCK_KEY);
}

export async function getTrustRecalculationSchedulerStatus(): Promise<TrustRecalculationSchedulerStatus> {
  const config = await getTrustRecalculationAdminConfig();
  const shared = await readPersistedTrustSchedulerState();
  return {
    ...config,
    running: shared?.running ?? running,
    nextRunAt: shared?.nextRunAt ?? nextRunAt?.toISOString(),
    lastStartedAt: shared?.lastStartedAt ?? lastStartedAt,
    lastFinishedAt: shared?.lastFinishedAt ?? lastFinishedAt,
    lastResult: shared?.lastResult ?? lastResult,
    lastError: shared?.lastError ?? lastError,
  };
}

async function readPersistedTrustSchedulerState(): Promise<PersistedTrustSchedulerState | undefined> {
  try {
    return await readJson<PersistedTrustSchedulerState>(STATUS_KEY);
  } catch {
    return undefined;
  }
}

async function persistTrustSchedulerState(): Promise<void> {
  try {
    await writeJson(STATUS_KEY, {
      running,
      nextRunAt: nextRunAt?.toISOString(),
      lastStartedAt,
      lastFinishedAt,
      lastResult,
      lastError,
    }, Math.max(appConfig.schedulerLockTtlSeconds * 4, 3600));
  } catch {
    // Status persistence is best-effort; the distributed lock remains the HA gate.
  }
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

  const shared = await readPersistedTrustSchedulerState();
  const sharedNextRunAt = parseDate(shared?.nextRunAt);
  if (shared?.running) return;
  if (shared && sharedNextRunAt && now.getTime() < sharedNextRunAt.getTime()) {
    nextRunAt = sharedNextRunAt;
    lastStartedAt = shared.lastStartedAt;
    lastFinishedAt = shared.lastFinishedAt;
    lastResult = shared.lastResult;
    lastError = shared.lastError;
    return;
  }

  const lock = await acquireRedisLock(LOCK_KEY, appConfig.schedulerLockTtlSeconds);
  if (!lock) {
    setSchedulerLockStatus('trust_recalculation', false);
    return;
  }

  running = true;
  lastStartedAt = now.toISOString();
  lastError = undefined;
  setSchedulerLockStatus('trust_recalculation', true);
  await persistTrustSchedulerState();

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
    setSchedulerLockStatus('trust_recalculation', false);
    await persistTrustSchedulerState();
    await lock.release();
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
