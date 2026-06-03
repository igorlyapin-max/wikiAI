import {
  applyIndexingProfileToReindexRequest,
  getIndexingProfiles,
  IndexingProfile,
} from './admin-platform-config.js';
import { startSyncerReindex } from './syncer-admin.js';

const SCHEDULER_TICK_MS = 60_000;
const DEFAULT_INTERVAL_MINUTES = 1440;

interface ProfileRunState {
  running: boolean;
  nextRunAt?: Date;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResult?: unknown;
  lastError?: string;
}

export interface IndexingProfileSchedulerProfileStatus {
  id: string;
  name: string;
  enabled: boolean;
  runMode: IndexingProfile['runMode'];
  intervalMinutes: number;
  running: boolean;
  nextRunAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResult?: unknown;
  lastError?: string;
}

export interface IndexingProfileSchedulerStatus {
  running: boolean;
  profiles: IndexingProfileSchedulerProfileStatus[];
}

let schedulerTimer: NodeJS.Timeout | undefined;
let running = false;
const profileStates = new Map<string, ProfileRunState>();

function profileIntervalMinutes(profile: IndexingProfile): number {
  return profile.scheduleIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
}

function calculateNextRun(profile: IndexingProfile, from: Date): Date {
  return new Date(from.getTime() + profileIntervalMinutes(profile) * 60_000);
}

function scheduledProfiles(profiles: IndexingProfile[]): IndexingProfile[] {
  return profiles.filter((profile) => (
    profile.enabled
    && profile.runMode === 'scheduled'
    && profileIntervalMinutes(profile) > 0
  ));
}

function getOrCreateState(profile: IndexingProfile, now: Date): ProfileRunState {
  const existing = profileStates.get(profile.id);
  if (existing) return existing;

  const created: ProfileRunState = {
    running: false,
    nextRunAt: calculateNextRun(profile, now),
  };
  profileStates.set(profile.id, created);
  return created;
}

export function resetIndexingProfileSchedulerForTests(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
  running = false;
  profileStates.clear();
}

export async function getIndexingProfileSchedulerStatus(now = new Date()): Promise<IndexingProfileSchedulerStatus> {
  const profiles = scheduledProfiles(await getIndexingProfiles());
  const activeIds = new Set(profiles.map((profile) => profile.id));
  for (const id of Array.from(profileStates.keys())) {
    if (!activeIds.has(id)) profileStates.delete(id);
  }

  return {
    running,
    profiles: profiles.map((profile) => {
      const state = getOrCreateState(profile, now);
      return {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        runMode: profile.runMode,
        intervalMinutes: profileIntervalMinutes(profile),
        running: state.running,
        nextRunAt: state.nextRunAt?.toISOString(),
        lastStartedAt: state.lastStartedAt,
        lastFinishedAt: state.lastFinishedAt,
        lastResult: state.lastResult,
        lastError: state.lastError,
      };
    }),
  };
}

export async function runScheduledIndexingProfilesOnce(now = new Date()): Promise<void> {
  if (running) return;

  const profiles = scheduledProfiles(await getIndexingProfiles());
  const activeIds = new Set(profiles.map((profile) => profile.id));
  for (const id of Array.from(profileStates.keys())) {
    if (!activeIds.has(id)) profileStates.delete(id);
  }

  for (const profile of profiles) {
    const state = getOrCreateState(profile, now);
    if (state.running || !state.nextRunAt || now.getTime() < state.nextRunAt.getTime()) {
      continue;
    }

    running = true;
    state.running = true;
    state.lastStartedAt = now.toISOString();
    state.lastError = undefined;

    try {
      state.lastResult = await startSyncerReindex(
        await applyIndexingProfileToReindexRequest({ profileId: profile.id })
      );
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : 'Unknown scheduled indexing profile error';
    } finally {
      const finishedAt = new Date();
      state.lastFinishedAt = finishedAt.toISOString();
      state.nextRunAt = calculateNextRun(profile, finishedAt);
      state.running = false;
      running = false;
    }

    return;
  }
}

export function startIndexingProfileScheduler(
  runOnce: () => Promise<void> = runScheduledIndexingProfilesOnce
): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Unknown scheduler tick error';
      console.error(`Indexing profile scheduler tick failed: ${message}`);
    });
  }, SCHEDULER_TICK_MS);
}

export function stopIndexingProfileScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}
