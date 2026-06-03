import { config } from '../config.js';
import { getAllowedGroups } from './acl.js';
import { getMetadataText, processAttachment } from './attachment.js';
import { splitText } from './chunker.js';
import { getDocumentProcessingConfig, getMimeProcessingRule } from './document-policy.js';
import {
  downloadFile,
  fetchAllPages,
  fetchFileInfo,
  fetchPageCategories,
  fetchPageContent,
  fetchPageFiles,
  fetchSemanticFacts,
  getMediaWikiServiceAuthStatus,
  semanticFactsToText,
} from './mediawiki.js';
import { upsertAttachmentChunks, upsertAttachmentMetadata, upsertChunks } from './qdrant.js';
import { getNamespacesToReindex } from './reindex-scope.js';
import { applyIndexingProfileDefaults, getIndexingProfileFromAdminStorage } from './indexing-profile-store.js';
import { enrichPageForReindex, fetchEffectiveEmbeddingConfig, ReindexLlmEnrichmentResult } from './gateway.js';

export interface ReindexOptions {
  profileId?: string;
  attachmentsEnabled?: boolean;
  semanticFactsEnabled?: boolean;
  smwProperties?: string[];
  namespaces?: number[];
  namespaceAcl?: Record<string, string[]>;
  titleFilters?: ReindexTextFilters;
  categoryFilters?: ReindexTextFilters;
  documentPolicyId?: string;
  maxPages?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
  dryRun?: boolean;
  llmEnrichmentEnabled?: boolean;
  llmEnrichmentModel?: string;
  llmEnrichmentMaxChars?: number;
}

export interface ReindexTextFilters {
  include: string[];
  exclude: string[];
}

export interface ReindexSummary {
  profileId?: string;
  dryRun: boolean;
  namespaces: number[];
  matchedPages: number;
  limitApplied?: number;
  totalPages: number;
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
  embeddingCalls: number;
  llmEnrichmentCalls: number;
  estimatedPaidCalls: number;
  attachmentsProcessed: number;
  attachmentsFailed: number;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
}

export interface ReindexProgress {
  phase: 'started' | 'page' | 'complete';
  profileId?: string;
  dryRun?: boolean;
  namespaces?: number[];
  matchedPages?: number;
  limitApplied?: number;
  totalPages: number;
  processed: number;
  skipped?: number;
  failed: number;
  totalChunks: number;
  embeddingCalls?: number;
  llmEnrichmentCalls?: number;
  estimatedPaidCalls?: number;
  currentTitle?: string;
}

export type ReindexProgressHandler = (progress: ReindexProgress) => void;

function hasResolvedProfileOptions(options: ReindexOptions): boolean {
  return options.attachmentsEnabled !== undefined
    && options.semanticFactsEnabled !== undefined
    && options.smwProperties !== undefined
    && options.namespaces !== undefined
    && options.titleFilters !== undefined
    && options.categoryFilters !== undefined
    && options.documentPolicyId !== undefined
    && options.chunkSize !== undefined
    && options.chunkOverlap !== undefined
    && options.chunkSeparators !== undefined
    && options.dryRun !== undefined;
}

function getRequestedNamespaces(requested: number[] | undefined, namespaceAcl: Record<string, string[]>): number[] {
  const configured = getNamespacesToReindex(namespaceAcl);
  if (!requested || requested.length === 0) return configured;

  const configuredSet = new Set(configured);
  const filtered = requested
    .filter((namespace) => Number.isInteger(namespace) && namespace >= 0 && configuredSet.has(namespace));

  return filtered.length > 0 ? Array.from(new Set(filtered)).sort((a, b) => a - b) : configured;
}

function getMaxPages(maxPages: number | undefined): number | undefined {
  if (maxPages === undefined) return undefined;
  if (!Number.isInteger(maxPages) || maxPages <= 0) return undefined;
  return Math.min(maxPages, 10_000);
}

function namespaceIsPublic(groups: string[]): boolean {
  return groups.length === 1 && groups[0]?.trim() === '*';
}

export function getProtectedReindexNamespaces(
  namespaces: number[],
  namespaceAcl: Record<string, string[]>
): number[] {
  return namespaces.filter((namespace) => !namespaceIsPublic(getAllowedGroups(namespace, namespaceAcl)));
}

export async function validateReindexPreflight(options: ReindexOptions = {}): Promise<void> {
  const effectiveOptions = options.profileId
    ? applyIndexingProfileDefaults(
      options,
      hasResolvedProfileOptions(options)
        ? undefined
        : await getIndexingProfileFromAdminStorage(options.profileId)
    )
    : options;
  const effectiveNamespaceAcl = effectiveOptions.namespaceAcl ?? config.namespaceAcl;
  const namespaces = getRequestedNamespaces(effectiveOptions.namespaces, effectiveNamespaceAcl);
  const protectedNamespaces = getProtectedReindexNamespaces(namespaces, effectiveNamespaceAcl);
  const auth = getMediaWikiServiceAuthStatus();
  if (protectedNamespaces.length > 0 && auth.source === 'none') {
    throw new Error(
      `MediaWiki service auth is required before protected reindex. `
      + `Configure MW_SERVICE_USERNAME with MW_SERVICE_PASSWORD or MW_SERVICE_PASSWORD_SECRET, `
      + `then rerun auth test. Protected namespaces: ${protectedNamespaces.join(', ')}.`
    );
  }
}

function normalizeFilterValues(filters: ReindexTextFilters | undefined): ReindexTextFilters {
  return {
    include: filters?.include ?? [],
    exclude: filters?.exclude ?? [],
  };
}

function textMatchesFilters(value: string, filters: ReindexTextFilters | undefined): boolean {
  const normalized = value.toLowerCase();
  const effective = normalizeFilterValues(filters);
  const includeMatches = effective.include.length === 0
    || effective.include.some((filter) => normalized.includes(filter.toLowerCase()));
  const excludeMatches = effective.exclude.some((filter) => normalized.includes(filter.toLowerCase()));
  return includeMatches && !excludeMatches;
}

function normalizeCategoryName(value: string): string {
  return value
    .replace(/^(category|категория):/i, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

function categoriesMatchFilters(categories: string[], filters: ReindexTextFilters | undefined): boolean {
  const effective = normalizeFilterValues(filters);
  if (effective.include.length === 0 && effective.exclude.length === 0) return true;
  const values = new Set(categories.map(normalizeCategoryName));
  const includeMatches = effective.include.length === 0
    || effective.include.some((filter) => values.has(normalizeCategoryName(filter)));
  const excludeMatches = effective.exclude.some((filter) => values.has(normalizeCategoryName(filter)));
  return includeMatches && !excludeMatches;
}

function enrichmentToText(enrichment: ReindexLlmEnrichmentResult | undefined): string {
  if (!enrichment) return '';
  const keywords = enrichment.keywords.length > 0 ? `AI keywords: ${enrichment.keywords.join(', ')}` : '';
  return [`AI summary: ${enrichment.summary}`, keywords].filter(Boolean).join('\n');
}

async function applyCategoryFilters<T extends { title: string }>(
  pages: T[],
  filters: ReindexTextFilters | undefined
): Promise<T[]> {
  const effective = normalizeFilterValues(filters);
  if (effective.include.length === 0 && effective.exclude.length === 0) return pages;

  const result: T[] = [];
  for (const page of pages) {
    const categories = await fetchPageCategories(page.title);
    if (categoriesMatchFilters(categories, effective)) {
      result.push(page);
    }
  }
  return result;
}

export async function runReindex(
  options: ReindexOptions = {},
  onProgress?: ReindexProgressHandler
): Promise<ReindexSummary> {
  const effectiveOptions = options.profileId
    ? applyIndexingProfileDefaults(
      options,
      hasResolvedProfileOptions(options)
        ? undefined
        : await getIndexingProfileFromAdminStorage(options.profileId)
    )
    : options;
  const startedAt = new Date();
  const documentPolicy = await getDocumentProcessingConfig();
  const attachmentsEnabled = effectiveOptions.attachmentsEnabled ?? false;
  const semanticFactsEnabled = effectiveOptions.semanticFactsEnabled ?? config.smwSyncEnabled;
  const smwProperties = effectiveOptions.smwProperties ?? config.smwSyncProperties;
  const dryRun = effectiveOptions.dryRun ?? false;
  const llmEnrichmentEnabled = effectiveOptions.llmEnrichmentEnabled ?? false;
  const embeddingConfig = await fetchEffectiveEmbeddingConfig().catch(() => undefined);
  const effectiveNamespaceAcl = effectiveOptions.namespaceAcl ?? config.namespaceAcl;
  const namespaces = getRequestedNamespaces(effectiveOptions.namespaces, effectiveNamespaceAcl);
  const protectedNamespaces = getProtectedReindexNamespaces(namespaces, effectiveNamespaceAcl);
  const auth = getMediaWikiServiceAuthStatus();
  if (protectedNamespaces.length > 0 && auth.source === 'none') {
    throw new Error(
      `MediaWiki service auth is required before protected reindex. `
      + `Configure MW_SERVICE_USERNAME with MW_SERVICE_PASSWORD or MW_SERVICE_PASSWORD_SECRET, `
      + `then rerun auth test. Protected namespaces: ${protectedNamespaces.join(', ')}.`
    );
  }
  const maxPages = getMaxPages(effectiveOptions.maxPages);
  const allPages = (
    await Promise.all(namespaces.map((namespace) => fetchAllPages(namespace)))
  ).flat().filter((page) => textMatchesFilters(page.title, effectiveOptions.titleFilters));
  const filteredPages = await applyCategoryFilters(allPages, effectiveOptions.categoryFilters);
  const matchedPages = filteredPages.length;
  const pages = maxPages === undefined ? filteredPages : filteredPages.slice(0, maxPages);
  const limitApplied = maxPages;

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let totalChunks = 0;
  let embeddingCalls = 0;
  let llmEnrichmentCalls = 0;
  let estimatedPaidCalls = 0;
  let attachmentsProcessed = 0;
  let attachmentsFailed = 0;

  onProgress?.({
    phase: 'started',
    profileId: effectiveOptions.profileId,
    dryRun,
    namespaces,
    matchedPages,
    limitApplied,
    totalPages: pages.length,
    processed,
    skipped,
    failed,
    totalChunks,
    embeddingCalls,
    llmEnrichmentCalls,
    estimatedPaidCalls,
  });

  for (const page of pages) {
    try {
      const content = await fetchPageContent(page.title);
      if (!content || !content.content) {
        skipped++;
        onProgress?.({
          phase: 'page',
          profileId: effectiveOptions.profileId,
          dryRun,
          namespaces,
          matchedPages,
          limitApplied,
          totalPages: pages.length,
          processed,
          skipped,
          failed,
          totalChunks,
          embeddingCalls,
          llmEnrichmentCalls,
          estimatedPaidCalls,
          currentTitle: page.title,
        });
        continue;
      }

      const semanticFacts = semanticFactsEnabled ? await fetchSemanticFacts(page.title, smwProperties) : {};
      const semanticText = semanticFactsToText(semanticFacts);
      let enrichment: ReindexLlmEnrichmentResult | undefined;
      if (!dryRun && llmEnrichmentEnabled) {
        enrichment = await enrichPageForReindex({
          title: page.title,
          text: content.content,
          model: effectiveOptions.llmEnrichmentModel,
          maxChars: effectiveOptions.llmEnrichmentMaxChars,
        });
        llmEnrichmentCalls++;
      }
      const enrichmentText = enrichmentToText(enrichment);
      const indexText = [semanticText, enrichmentText, content.content].filter(Boolean).join('\n\n');
      const chunks = splitText(indexText, {
        chunkSize: effectiveOptions.chunkSize,
        chunkOverlap: effectiveOptions.chunkOverlap,
        chunkSeparators: effectiveOptions.chunkSeparators,
      });
      const allowedGroups = getAllowedGroups(page.ns, effectiveNamespaceAcl);
      const lastModified = content.lastModified ?? new Date().toISOString();
      const estimatedPagePaidCalls = (embeddingConfig?.provider === 'openai_compatible' ? chunks.length : 0)
        + (llmEnrichmentEnabled ? 1 : 0);
      estimatedPaidCalls += estimatedPagePaidCalls;
      if (!dryRun) {
        embeddingCalls += chunks.length;
      }

      if (!dryRun) {
        await upsertChunks(
          page.pageid,
          page.title,
          page.ns,
          chunks,
          allowedGroups,
          lastModified,
          semanticFacts,
          enrichment ? {
            summary: enrichment.summary,
            keywords: enrichment.keywords,
            model: enrichment.model,
          } : undefined
        );
      }

      processed++;
      totalChunks += chunks.length;

      if (!dryRun && attachmentsEnabled && documentPolicy.attachmentsEnabled) {
        const files = await fetchPageFiles(page.title);
        for (const filename of files) {
          try {
            const fileInfo = await fetchFileInfo(filename);
            if (!fileInfo) continue;

            const rule = getMimeProcessingRule(fileInfo.mime, documentPolicy);
            const metadata = {
              filename,
              mimeType: fileInfo.mime,
              size: fileInfo.size,
              mode: rule.mode,
            };

            if (rule.mode === 'disabled') continue;

            if (rule.mode === 'metadata') {
              if (embeddingConfig?.provider === 'openai_compatible') estimatedPaidCalls++;
              embeddingCalls++;
              await upsertAttachmentMetadata(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                getMetadataText(filename, fileInfo.mime, metadata),
                allowedGroups,
                lastModified,
                metadata
              );
              attachmentsProcessed++;
              continue;
            }

            const buffer = await downloadFile(fileInfo.url);
            if (!buffer) continue;

            const result = await processAttachment(buffer, fileInfo.mime, filename, documentPolicy);
            if (result.text && result.text.trim().length > 0) {
              const attachmentChunks = splitText(result.text);
              if (embeddingConfig?.provider === 'openai_compatible') estimatedPaidCalls += attachmentChunks.length;
              embeddingCalls += attachmentChunks.length;
              await upsertAttachmentChunks(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                attachmentChunks.map((chunk) => chunk.text),
                allowedGroups,
                lastModified,
                result.metadata
              );
            } else {
              if (embeddingConfig?.provider === 'openai_compatible') estimatedPaidCalls++;
              embeddingCalls++;
              await upsertAttachmentMetadata(
                page.pageid,
                page.title,
                filename,
                fileInfo.mime,
                getMetadataText(filename, fileInfo.mime, result.metadata),
                allowedGroups,
                lastModified,
                result.metadata
              );
            }
            attachmentsProcessed++;
          } catch {
            attachmentsFailed++;
          }
        }
      }

      onProgress?.({
        phase: 'page',
        profileId: effectiveOptions.profileId,
        dryRun,
        namespaces,
        matchedPages,
        limitApplied,
        totalPages: pages.length,
        processed,
        skipped,
        failed,
        totalChunks,
        embeddingCalls,
        llmEnrichmentCalls,
        estimatedPaidCalls,
        currentTitle: page.title,
      });
    } catch {
      failed++;
      onProgress?.({
        phase: 'page',
        profileId: effectiveOptions.profileId,
        dryRun,
        namespaces,
        matchedPages,
        limitApplied,
        totalPages: pages.length,
        processed,
        skipped,
        failed,
        totalChunks,
        embeddingCalls,
        llmEnrichmentCalls,
        estimatedPaidCalls,
        currentTitle: page.title,
      });
    }
  }

  const finishedAt = new Date();
  const summary: ReindexSummary = {
    profileId: effectiveOptions.profileId,
    dryRun,
    namespaces,
    matchedPages,
    limitApplied,
    totalPages: pages.length,
    processed,
    skipped,
    failed,
    totalChunks,
    embeddingCalls,
    llmEnrichmentCalls,
    estimatedPaidCalls,
    attachmentsProcessed,
    attachmentsFailed,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
  };

  onProgress?.({
    phase: 'complete',
    profileId: effectiveOptions.profileId,
    dryRun,
    namespaces,
    matchedPages,
    limitApplied,
    totalPages: pages.length,
    processed,
    skipped,
    failed,
    totalChunks,
    embeddingCalls,
    llmEnrichmentCalls,
    estimatedPaidCalls,
  });

  return summary;
}
