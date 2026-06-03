import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { setTrustRecalculationAdminConfig } from '../admin-platform-config.js';
import {
  getTrustRecalculationSchedulerStatus,
  resetTrustRecalculationSchedulerForTests,
  runScheduledTrustRecalculationOnce,
  startTrustRecalculationScheduler,
  stopTrustRecalculationScheduler,
} from '../trust-recalculation-scheduler.js';

const recalculateTrustScores = vi.hoisted(() => vi.fn());

vi.mock('../trust-recalculation.js', () => ({
  recalculateTrustScores,
}));

function summary() {
  return {
    collection: 'test_chunks',
    modelId: 'model-1',
    dryRun: false,
    scannedPoints: 2,
    eligiblePoints: 2,
    updatedPoints: 2,
    skippedPoints: 0,
    failedPoints: 0,
    scanComplete: true,
    sample: [],
  };
}

describe('trust recalculation scheduler', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
    resetTrustRecalculationSchedulerForTests();
    recalculateTrustScores.mockReset();
  });

  it('keeps disabled schedules idle and reports default status', async () => {
    await runScheduledTrustRecalculationOnce(new Date('2026-06-01T00:00:00.000Z'));

    await expect(getTrustRecalculationSchedulerStatus()).resolves.toMatchObject({
      enabled: false,
      intervalMinutes: 1440,
      maxScan: 1000,
      batchSize: 128,
      running: false,
      nextRunAt: undefined,
    });
    expect(recalculateTrustScores).not.toHaveBeenCalled();
  });

  it('schedules the first run and executes due recalculation with admin config', async () => {
    await setTrustRecalculationAdminConfig({
      enabled: true,
      intervalMinutes: 5,
      maxScan: 50,
      batchSize: 10,
    });
    recalculateTrustScores.mockResolvedValueOnce(summary());

    await runScheduledTrustRecalculationOnce(new Date('2026-06-01T00:00:00.000Z'));
    expect(recalculateTrustScores).not.toHaveBeenCalled();
    await expect(getTrustRecalculationSchedulerStatus()).resolves.toMatchObject({
      enabled: true,
      nextRunAt: '2026-06-01T00:05:00.000Z',
    });

    await runScheduledTrustRecalculationOnce(new Date('2026-06-01T00:05:00.000Z'));

    expect(recalculateTrustScores).toHaveBeenCalledWith({
      dryRun: false,
      maxScan: 50,
      batchSize: 10,
    });
    await expect(getTrustRecalculationSchedulerStatus()).resolves.toMatchObject({
      running: false,
      lastStartedAt: '2026-06-01T00:05:00.000Z',
      lastError: undefined,
      lastResult: summary(),
    });
  });

  it('records recalculation errors and prevents overlapping runs', async () => {
    await setTrustRecalculationAdminConfig({
      enabled: true,
      intervalMinutes: 5,
      maxScan: 5,
      batchSize: 2,
    });

    await runScheduledTrustRecalculationOnce(new Date('2026-06-01T00:00:00.000Z'));

    let resolveRun: (value: unknown) => void = () => undefined;
    const deferred = new Promise((resolve) => {
      resolveRun = resolve;
    });
    recalculateTrustScores.mockReturnValueOnce(deferred);

    const firstRun = runScheduledTrustRecalculationOnce(new Date('2026-06-01T00:05:00.000Z'));
    await vi.waitFor(() => expect(recalculateTrustScores).toHaveBeenCalledTimes(1));

    await runScheduledTrustRecalculationOnce(new Date('2026-06-01T00:05:00.000Z'));
    expect(recalculateTrustScores).toHaveBeenCalledTimes(1);

    resolveRun(summary());
    await firstRun;

    const statusAfterFirstRun = await getTrustRecalculationSchedulerStatus();
    expect(statusAfterFirstRun.nextRunAt).toBeDefined();
    if (!statusAfterFirstRun.nextRunAt) throw new Error('missing nextRunAt');

    recalculateTrustScores.mockRejectedValueOnce(new Error('qdrant unavailable'));
    await runScheduledTrustRecalculationOnce(new Date(statusAfterFirstRun.nextRunAt));

    await expect(getTrustRecalculationSchedulerStatus()).resolves.toMatchObject({
      running: false,
      lastError: 'qdrant unavailable',
    });
  });

  it('starts and stops the interval scheduler idempotently', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      startTrustRecalculationScheduler();
      startTrustRecalculationScheduler();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      stopTrustRecalculationScheduler();
      stopTrustRecalculationScheduler();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      resetTrustRecalculationSchedulerForTests();
      vi.useRealTimers();
    }
  });
});
