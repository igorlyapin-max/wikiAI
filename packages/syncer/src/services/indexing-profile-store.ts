import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import type { ReindexOptions, ReindexTextFilters } from './reindex.js';

const INDEXING_PROFILE_AREA = 'indexing-profiles';
const DEFAULT_KEY = 'default';

interface StoredIndexingProfile {
  id: string;
  enabled?: boolean;
  namespaces?: number[];
  namespaceAcl?: Record<string, string[]>;
  titleFilters?: ReindexTextFilters;
  categoryFilters?: ReindexTextFilters;
  documentPolicyId?: string;
  attachmentsEnabled?: boolean;
  semanticFactsEnabled?: boolean;
  smwProperties?: string[];
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
  dryRunDefault?: boolean;
  maxPagesDefault?: number;
}

function sqliteFilename(databaseUrl: string): string | undefined {
  if (!databaseUrl.startsWith('sqlite://')) return undefined;
  const rawFilename = databaseUrl.slice('sqlite://'.length);
  if (!rawFilename) return undefined;
  return rawFilename === ':memory:' || path.isAbsolute(rawFilename)
    ? rawFilename
    : path.resolve(process.cwd(), rawFilename);
}

function isStoredProfile(value: unknown): value is StoredIndexingProfile {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

export async function getIndexingProfileFromAdminStorage(profileId: string): Promise<StoredIndexingProfile | undefined> {
  const filename = sqliteFilename(config.databaseUrl);
  if (!filename) return undefined;

  const db = new DatabaseSync(filename);
  try {
    const row = db
      .prepare('SELECT value_json FROM ai_admin_config WHERE area = ? AND key = ?')
      .get(INDEXING_PROFILE_AREA, DEFAULT_KEY) as { value_json?: unknown } | undefined;
    if (typeof row?.value_json !== 'string') return undefined;

    const parsed = JSON.parse(row.value_json) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const profile = parsed.find((item) => isStoredProfile(item) && item.id === profileId);
    return isStoredProfile(profile) ? profile : undefined;
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return undefined;
    throw err;
  } finally {
    db.close();
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
