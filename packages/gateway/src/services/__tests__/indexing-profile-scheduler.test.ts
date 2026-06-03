import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAdminStoreForTests } from '../../db/admin-store.js';
import { upsertIndexingProfile } from '../admin-platform-config.js';
import {
  getIndexingProfileSchedulerStatus,
  resetIndexingProfileSchedulerForTests,
  runScheduledIndexingProfilesOnce,
  startIndexingProfileScheduler,
} from '../indexing-profile-scheduler.js';

const startSyncerReindex = vi.hoisted(() => vi.fn());

vi.mock('../syncer-admin.js', () => ({
  startSyncerReindex,
}));

describe('indexing profile scheduler', () => {
  beforeEach(() => {
    resetAdminStoreForTests();
    resetIndexingProfileSchedulerForTests();
    startSyncerReindex.mockReset();
  });

  it('starts due scheduled profiles by profileId only', async () => {
    await upsertIndexingProfile({
      id: 'scheduled-it',
      name: 'Scheduled IT',
      namespaces: [3030],
      namespaceAcl: { '3030': ['ai-it'] },
      runMode: 'scheduled',
      scheduleIntervalMinutes: 5,
      chunkSize: 256,
      chunkOverlap: 0,
    });
    await upsertIndexingProfile({
      id: 'manual-hr',
      name: 'Manual HR',
      namespaces: [3010],
      runMode: 'manual',
      chunkSize: 256,
      chunkOverlap: 0,
    });

    const firstTick = new Date('2026-06-01T00:00:00.000Z');
    await runScheduledIndexingProfilesOnce(firstTick);
    expect(startSyncerReindex).not.toHaveBeenCalled();

    const initialStatus = await getIndexingProfileSchedulerStatus(firstTick);
    expect(initialStatus.profiles).toHaveLength(1);
    expect(initialStatus.profiles[0]).toMatchObject({
      id: 'scheduled-it',
      intervalMinutes: 5,
      nextRunAt: '2026-06-01T00:05:00.000Z',
    });

    startSyncerReindex.mockResolvedValueOnce({ status: { state: 'running' } });
    await runScheduledIndexingProfilesOnce(new Date('2026-06-01T00:05:00.000Z'));

    expect(startSyncerReindex).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'scheduled-it',
      semanticFactsEnabled: true,
      smwProperties: expect.any(Array),
      namespaces: [3030],
    }));
    const status = await getIndexingProfileSchedulerStatus();
    expect(status.profiles[0].lastStartedAt).toBe('2026-06-01T00:05:00.000Z');
    expect(status.profiles[0].lastError).toBeUndefined();
  });

  it('logs scheduler tick failures instead of creating an unhandled rejection', async () => {
    const runOnce = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('admin store unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();

    try {
      startIndexingProfileScheduler(runOnce);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Indexing profile scheduler tick failed: admin store unavailable'
      );
    } finally {
      resetIndexingProfileSchedulerForTests();
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });
});
