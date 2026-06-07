import { config } from '../config.js';
import type { ChunkingOptions } from './chunker.js';

export type ChunkingSourceType =
  | 'wiki_page'
  | 'attachment_text'
  | 'attachment_metadata'
  | 'cmdb_dynamic_snapshot';

export interface ChunkingRule {
  chunkSize: number;
  chunkOverlap: number;
  chunkSeparators: string[];
}

export interface ChunkingNamespaceOverride {
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
}

export interface ChunkingPolicy {
  defaults: ChunkingRule;
  sources: Partial<Record<ChunkingSourceType, ChunkingRule>>;
  namespaceOverrides: Record<string, ChunkingNamespaceOverride>;
}

export const CHUNKING_SOURCE_TYPES: ChunkingSourceType[] = [
  'wiki_page',
  'attachment_text',
  'attachment_metadata',
  'cmdb_dynamic_snapshot',
];

const DEFAULT_SEPARATORS = ['\n## ', '\n### ', '\n\n', '\n', '. ', ' '];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChunkSize(value: unknown, fallback: number): number {
  return Number.isInteger(value)
    ? Math.max(128, Math.min(Number(value), 4096))
    : fallback;
}

function normalizeChunkSeparators(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const separators = value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 16);
  return separators.length > 0 ? separators : fallback;
}

function normalizeChunkOverlap(value: unknown, chunkSize: number, fallback: number): number {
  const normalizedFallback = Math.max(0, Math.min(fallback, chunkSize - 1));
  return Number.isInteger(value)
    ? Math.max(0, Math.min(Number(value), chunkSize - 1))
    : normalizedFallback;
}

export function legacyChunkingRule(options: ChunkingOptions = {}): ChunkingRule {
  const chunkSize = normalizeChunkSize(options.chunkSize, config.chunkSize);
  return {
    chunkSize,
    chunkOverlap: normalizeChunkOverlap(options.chunkOverlap, chunkSize, config.chunkOverlap),
    chunkSeparators: normalizeChunkSeparators(options.chunkSeparators, DEFAULT_SEPARATORS),
  };
}

function normalizeRule(value: unknown, fallback: ChunkingRule): ChunkingRule {
  if (!isRecord(value)) return fallback;
  const chunkSize = normalizeChunkSize(value.chunkSize, fallback.chunkSize);
  return {
    chunkSize,
    chunkOverlap: normalizeChunkOverlap(value.chunkOverlap, chunkSize, fallback.chunkOverlap),
    chunkSeparators: normalizeChunkSeparators(value.chunkSeparators, fallback.chunkSeparators),
  };
}

function normalizeOverride(value: unknown): ChunkingNamespaceOverride | undefined {
  if (!isRecord(value)) return undefined;
  const override: ChunkingNamespaceOverride = {};
  if (Number.isInteger(value.chunkSize)) {
    override.chunkSize = Math.max(128, Math.min(Number(value.chunkSize), 4096));
  }
  if (Number.isInteger(value.chunkOverlap)) {
    override.chunkOverlap = Math.max(0, Math.min(Number(value.chunkOverlap), 2048));
  }
  const separators = normalizeChunkSeparators(value.chunkSeparators, []);
  if (separators.length > 0) override.chunkSeparators = separators;
  return Object.keys(override).length > 0 ? override : undefined;
}

export function normalizeChunkingPolicy(
  value: unknown,
  legacyRule: ChunkingRule
): ChunkingPolicy {
  const input = isRecord(value) ? value : {};
  const defaults = normalizeRule(input.defaults, legacyRule);
  const sourceInput = isRecord(input.sources) ? input.sources : {};
  const sources: Partial<Record<ChunkingSourceType, ChunkingRule>> = {};
  for (const sourceType of CHUNKING_SOURCE_TYPES) {
    sources[sourceType] = normalizeRule(sourceInput[sourceType], defaults);
  }

  const overrideInput = isRecord(input.namespaceOverrides) ? input.namespaceOverrides : {};
  const namespaceOverrides: Record<string, ChunkingNamespaceOverride> = {};
  for (const [namespace, rawOverride] of Object.entries(overrideInput).slice(0, 100)) {
    if (!/^\d+$/.test(namespace)) continue;
    const override = normalizeOverride(rawOverride);
    if (override) namespaceOverrides[namespace] = override;
  }

  return { defaults, sources, namespaceOverrides };
}

export function resolveChunkingOptions(input: {
  policy: ChunkingPolicy;
  sourceType: ChunkingSourceType;
  namespace?: number;
}): ChunkingOptions {
  const base = input.policy.sources[input.sourceType] ?? input.policy.defaults;
  if (input.sourceType !== 'wiki_page' || input.namespace === undefined) {
    return base;
  }

  const override = input.policy.namespaceOverrides[String(input.namespace)];
  if (!override) return base;
  const chunkSize = override.chunkSize ?? base.chunkSize;
  return {
    chunkSize,
    chunkOverlap: normalizeChunkOverlap(override.chunkOverlap, chunkSize, base.chunkOverlap),
    chunkSeparators: override.chunkSeparators ?? base.chunkSeparators,
  };
}

export function chunkingPolicySummary(policy: ChunkingPolicy): Record<string, unknown> {
  return {
    defaults: {
      chunkSize: policy.defaults.chunkSize,
      chunkOverlap: policy.defaults.chunkOverlap,
    },
    sources: Object.fromEntries(CHUNKING_SOURCE_TYPES.map((sourceType) => {
      const rule = policy.sources[sourceType] ?? policy.defaults;
      return [sourceType, `${rule.chunkSize}/${rule.chunkOverlap}`];
    })),
    namespaceOverrides: Object.keys(policy.namespaceOverrides).length,
  };
}
