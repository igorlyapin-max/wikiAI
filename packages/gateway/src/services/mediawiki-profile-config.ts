import { z } from 'zod';
import { getAdminStore } from '../db/admin-store.js';
import { getRagAdminConfig, type RagAdminConfig, type RetrievalProfileWithReadiness } from './admin-platform-config.js';
import {
  applyRetrievalProfileToRagConfig,
  getRetrievalProfilesWithReadiness,
} from './retrieval-profiles.js';

const CONFIG_AREA = 'mediawiki-profile-config';
const CONFIG_KEY = 'default';

export const DEFAULT_MEDIAWIKI_RETRIEVAL_PROFILE_ID = 'opensearch_hybrid_colbert';

export interface MediaWikiProfileConfig {
  defaultRetrievalProfileId: string;
}

export interface MediaWikiProfileConfigStatus {
  values: MediaWikiProfileConfig;
  selectedProfile?: RetrievalProfileWithReadiness;
  effectiveConfig?: RagAdminConfig;
  retrievalProfiles: RetrievalProfileWithReadiness[];
}

const configSchema = z.object({
  defaultRetrievalProfileId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/),
}).strict();

export const DEFAULT_MEDIAWIKI_PROFILE_CONFIG: MediaWikiProfileConfig = {
  defaultRetrievalProfileId: DEFAULT_MEDIAWIKI_RETRIEVAL_PROFILE_ID,
};

export async function getMediaWikiProfileConfig(): Promise<MediaWikiProfileConfig> {
  const stored = await getAdminStore().getJson<Partial<MediaWikiProfileConfig>>(CONFIG_AREA, CONFIG_KEY);
  return configSchema.parse({
    ...DEFAULT_MEDIAWIKI_PROFILE_CONFIG,
    ...(stored ?? {}),
  });
}

export async function setMediaWikiProfileConfig(input: unknown, actor?: string): Promise<MediaWikiProfileConfig> {
  const parsed = configSchema.parse(input);
  const profiles = await getRetrievalProfilesWithReadiness();
  if (!profiles.some((profile) => profile.id === parsed.defaultRetrievalProfileId)) {
    throw new Error(`Retrieval profile not found: ${parsed.defaultRetrievalProfileId}`);
  }

  await getAdminStore().setJson(CONFIG_AREA, CONFIG_KEY, parsed, {
    actor,
    action: 'mediawiki-profile.config.update',
    entityType: 'mediawiki-profile',
  });
  return parsed;
}

export async function getMediaWikiProfileConfigStatus(): Promise<MediaWikiProfileConfigStatus> {
  const [values, profiles, baseConfig] = await Promise.all([
    getMediaWikiProfileConfig(),
    getRetrievalProfilesWithReadiness(),
    getRagAdminConfig(),
  ]);
  const selectedProfile = profiles.find((profile) => profile.id === values.defaultRetrievalProfileId);
  return {
    values,
    selectedProfile,
    effectiveConfig: selectedProfile ? applyRetrievalProfileToRagConfig(baseConfig, selectedProfile) : undefined,
    retrievalProfiles: profiles,
  };
}
