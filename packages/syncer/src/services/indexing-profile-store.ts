import { fetchIndexingProfiles } from './gateway.js';
import type { ReindexOptions, ReindexTextFilters } from './reindex.js';

interface StoredIndexingProfile {
  id: string;
  enabled?: boolean;
  namespaces?: number[];
  namespaceAcl?: Record<string, string[]>;
  titleFilters?: ReindexTextFilters;
  categoryFilters?: ReindexTextFilters;
  documentPolicyId?: string;
  indexTargets?: string[];
  attachmentsEnabled?: boolean;
  semanticFactsEnabled?: boolean;
  smwProperties?: string[];
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
  dryRunDefault?: boolean;
  maxPagesDefault?: number;
}

function isStoredProfile(value: unknown): value is StoredIndexingProfile {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

export async function getIndexingProfileFromAdminStorage(profileId: string): Promise<StoredIndexingProfile | undefined> {
  try {
    const profiles = await fetchIndexingProfiles();
    const profile = profiles.find((item) => isStoredProfile(item) && item.id === profileId);
    return isStoredProfile(profile) ? profile : undefined;
  } catch {
    return undefined;
  }
}

export function applyIndexingProfileDefaults(
  options: ReindexOptions,
  profile: StoredIndexingProfile | undefined
): ReindexOptions {
  if (!profile) return options;
  if (profile.enabled === false) {
    throw new Error(`Indexing profile is disabled: ${profile.id}`);
  }

  return {
    profileId: profile.id,
    indexTargets: options.indexTargets ?? profile.indexTargets,
    source: options.source,
    colbertModel: options.colbertModel,
    colbertCollection: options.colbertCollection,
    attachmentsEnabled: options.attachmentsEnabled ?? profile.attachmentsEnabled,
    semanticFactsEnabled: options.semanticFactsEnabled ?? profile.semanticFactsEnabled,
    smwProperties: options.smwProperties ?? profile.smwProperties,
    namespaces: options.namespaces ?? profile.namespaces,
    namespaceAcl: options.namespaceAcl ?? profile.namespaceAcl,
    titleFilters: options.titleFilters ?? profile.titleFilters,
    categoryFilters: options.categoryFilters ?? profile.categoryFilters,
    documentPolicyId: options.documentPolicyId ?? profile.documentPolicyId,
    maxPages: options.maxPages ?? profile.maxPagesDefault,
    chunkSize: options.chunkSize ?? profile.chunkSize,
    chunkOverlap: options.chunkOverlap ?? profile.chunkOverlap,
    chunkSeparators: options.chunkSeparators ?? profile.chunkSeparators,
    dryRun: options.dryRun ?? profile.dryRunDefault,
    llmEnrichmentEnabled: options.llmEnrichmentEnabled,
    llmEnrichmentModel: options.llmEnrichmentModel,
    llmEnrichmentMaxChars: options.llmEnrichmentMaxChars,
  };
}
