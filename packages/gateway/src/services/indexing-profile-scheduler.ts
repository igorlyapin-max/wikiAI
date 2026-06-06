import {
  applyIndexingProfileToReindexRequest,
  getIndexingAutomationConfig,
  getIndexingProfiles,
  IndexingProfile,
} from './admin-platform-config.js';
import { startSyncerReindex } from './syncer-admin.js';
import { logOperationalError } from './logging.js';
import { config } from '../config.js';
import { setSchedulerLockStatus } from './metrics.js';
import { acquireRedisLock, readJson, redis, writeJson } from './redis.js';

const SCHEDULER_TICK_MS = 60_000;
const DEFAULT_INTERVAL_MINUTES = 1440;

interface ProfileRunState {
  running: boolean;
  nextRunAt?: Date | string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResult?: unknown;
  lastError?: string;
}

interface ScheduledIndexingProfile {
  profile: IndexingProfile;
  intervalMinutes: number;
  source: 'automation' | 'legacy';
}

export interface IndexingProfileSchedulerProfileStatus {
  id: string;
  name: string;
  enabled: boolean;
  runMode: IndexingProfile['runMode'];
  intervalMinutes: number;
  source?: ScheduledIndexingProfile['source'];
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

function profileStateKey(profileId: string): string {
  return `gateway:indexing-profile-scheduler:${profileId}:status`;
}

function profileLockKey(profileId: string): string {
  return `gateway:indexing-profile-scheduler:${profileId}:lock`;
}

async function getSharedProfileState(profileId: string): Promise<ProfileRunState | undefined> {
  try {
    return await readJson<ProfileRunState>(profileStateKey(profileId));
  } catch (err) {
    logOperationalError('indexing_profile_scheduler.status_read_failed', err);
    return undefined;
  }
}

async function persistProfileState(profileId: string, state: ProfileRunState): Promise<void> {
  try {
    await writeJson(profileStateKey(profileId), state, Math.max(config.schedulerLockTtlSeconds * 4, 3600));
  } catch (err) {
    logOperationalError('indexing_profile_scheduler.status_write_failed', err);
  }
}

function profileIntervalMinutes(profile: IndexingProfile): number {
  return profile.scheduleIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
}

function calculateNextRun(entry: ScheduledIndexingProfile, from: Date): Date {
  return new Date(from.getTime() + entry.intervalMinutes * 60_000);
}

function parseStateDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function scheduledProfiles(): Promise<ScheduledIndexingProfile[]> {
  const profiles = await getIndexingProfiles();
  const automation = await getIndexingAutomationConfig();
  if (automation.scheduleEnabled && automation.scheduledReindexProfileId) {
    const profile = profiles.find((item) => item.id === automation.scheduledReindexProfileId);
    return profile && profile.enabled
      ? [{
        profile,
        intervalMinutes: automation.scheduleIntervalMinutes,
        source: 'automation',
      }]
      : [];
  }

  return profiles.filter((profile) => (
    profile.enabled
    && profile.runMode === 'scheduled'
    && profileIntervalMinutes(profile) > 0
  )).map((profile) => ({
    profile,
    intervalMinutes: profileIntervalMinutes(profile),
    source: 'legacy',
  }));
}

function getOrCreateState(entry: ScheduledIndexingProfile, now: Date): ProfileRunState {
  const profile = entry.profile;
  const existing = profileStates.get(profile.id);
  if (existing) return existing;

  const created: ProfileRunState = {
    running: false,
    nextRunAt: calculateNextRun(entry, now),
  };
  profileStates.set(profile.id, created);
  return created;
}

export function resetIndexingProfileSchedulerForTests(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
  running = false;
  const keys = Array.from(profileStates.keys()).flatMap((id) => [profileStateKey(id), profileLockKey(id)]);
  if (keys.length > 0) void redis.del(...keys);
  profileStates.clear();
}

export async function getIndexingProfileSchedulerStatus(now = new Date()): Promise<IndexingProfileSchedulerStatus> {
  const profiles = await scheduledProfiles();
  const activeIds = new Set(profiles.map((entry) => entry.profile.id));
  for (const id of Array.from(profileStates.keys())) {
    if (!activeIds.has(id)) profileStates.delete(id);
  }

  return {
    running,
    profiles: await Promise.all(profiles.map(async (entry) => {
      const profile = entry.profile;
      const state = getOrCreateState(entry, now);
      const sharedState = await getSharedProfileState(profile.id) ?? state;
      return {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        runMode: profile.runMode,
        intervalMinutes: entry.intervalMinutes,
        source: entry.source,
        running: sharedState.running,
        nextRunAt: parseStateDate(sharedState.nextRunAt)?.toISOString(),
        lastStartedAt: sharedState.lastStartedAt,
        lastFinishedAt: sharedState.lastFinishedAt,
        lastResult: sharedState.lastResult,
        lastError: sharedState.lastError,
      };
    })),
  };
}

export async function runScheduledIndexingProfilesOnce(now = new Date()): Promise<void> {
  if (running) return;

  const profiles = await scheduledProfiles();
  const activeIds = new Set(profiles.map((entry) => entry.profile.id));
  for (const id of Array.from(profileStates.keys())) {
    if (!activeIds.has(id)) profileStates.delete(id);
  }

  for (const entry of profiles) {
    const profile = entry.profile;
    const state = getOrCreateState(entry, now);
    const sharedState = await getSharedProfileState(profile.id);
    const sharedNextRunAt = parseStateDate(sharedState?.nextRunAt);
    if (sharedState?.running) continue;
    if (sharedNextRunAt && now.getTime() < sharedNextRunAt.getTime()) {
      profileStates.set(profile.id, { ...state, ...sharedState, nextRunAt: sharedNextRunAt });
      continue;
    }

    const localNextRunAt = parseStateDate(state.nextRunAt);
    if (state.running || !localNextRunAt || now.getTime() < localNextRunAt.getTime()) {
      continue;
    }

    const lock = await acquireRedisLock(profileLockKey(profile.id), config.schedulerLockTtlSeconds);
    if (!lock) {
      setSchedulerLockStatus('indexing_profile', false);
      continue;
    }

    running = true;
    state.running = true;
    state.lastStartedAt = now.toISOString();
    state.lastError = undefined;
    setSchedulerLockStatus('indexing_profile', true);
    await persistProfileState(profile.id, state);

    try {
      state.lastResult = await startSyncerReindex(
        await applyIndexingProfileToReindexRequest({ profileId: profile.id })
      );
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : 'Unknown scheduled indexing profile error';
    } finally {
      const finishedAt = new Date();
      state.lastFinishedAt = finishedAt.toISOString();
      state.nextRunAt = calculateNextRun(entry, finishedAt);
      state.running = false;
      running = false;
      setSchedulerLockStatus('indexing_profile', false);
      await persistProfileState(profile.id, state);
      await lock.release();
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
      logOperationalError('indexing_profile_scheduler.tick_failed', err);
    });
  }, SCHEDULER_TICK_MS);
}

export function stopIndexingProfileScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}
