import { SearchChunk, SemanticFacts } from '../types/index.js';

export interface PromptContextOptions {
  maxChars?: number;
}

export interface PromptContextSourceGroup {
  citationIndex: number;
  title: string;
  text?: string;
  sourceType?: string;
  attachmentFilename?: string;
  attachmentMime?: string;
  semanticFacts?: SemanticFacts;
  trust?: SearchChunk['trust'];
  lastModified?: string;
  chunks: SearchChunk[];
}

function formatSemanticFacts(facts: SemanticFacts | undefined): string {
  if (!facts) return '';

  return Object.entries(facts)
    .filter(([, values]) => values.length > 0)
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([property, values]) => `${property}: ${values.join(', ')}`)
    .join('\n');
}

function formatTrustMetadata(chunk: SearchChunk): string {
  const details = [
    chunk.trust?.score === undefined ? undefined : `score: ${chunk.trust.score.toFixed(2)}`,
    chunk.trust?.flags && chunk.trust.flags.length > 0 ? `flags: ${chunk.trust.flags.join(', ')}` : undefined,
    chunk.trust?.lastModified || chunk.lastModified ? `lastModified: ${chunk.trust?.lastModified ?? chunk.lastModified}` : undefined,
    chunk.trust?.decisions ? `includeInContext: ${chunk.trust.decisions.includeInContext}` : undefined,
    chunk.trust?.decisions ? `allowDirectAnswer: ${chunk.trust.decisions.allowDirectAnswer}` : undefined,
  ].filter((detail): detail is string => Boolean(detail));

  return details.length > 0 ? `\nДоверие источника:\n${details.join('\n')}` : '';
}

function formatChunkTitle(chunk: SearchChunk): string {
  if (chunk.sourceType !== 'attachment' && !chunk.attachmentFilename) return chunk.title;

  const details = [
    chunk.attachmentFilename ? `Файл: ${chunk.attachmentFilename}` : undefined,
    chunk.title ? `Родительская страница: ${chunk.title}` : undefined,
    chunk.attachmentMime ? `MIME: ${chunk.attachmentMime}` : undefined,
  ].filter((detail): detail is string => Boolean(detail));

  return details.length > 0 ? details.join('\n') : chunk.title;
}

function formatSourceGroupTitle(group: PromptContextSourceGroup): string {
  if (group.sourceType !== 'attachment' && !group.attachmentFilename) return group.title;

  const details = [
    group.attachmentFilename ? `Файл: ${group.attachmentFilename}` : undefined,
    group.title ? `Родительская страница: ${group.title}` : undefined,
    group.attachmentMime ? `MIME: ${group.attachmentMime}` : undefined,
  ].filter((detail): detail is string => Boolean(detail));

  return details.length > 0 ? details.join('\n') : group.title;
}

function formatSourceGroupText(group: PromptContextSourceGroup): string {
  if (group.chunks.length <= 1) {
    return group.chunks[0]?.text ?? group.text ?? '';
  }

  return group.chunks
    .map((chunk, index) => `Фрагмент ${index + 1}:\n${chunk.text}`)
    .join('\n\n');
}

function truncatePromptContext(value: string, maxChars: number | undefined): string {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) return value;
  const normalizedMax = Math.trunc(maxChars);
  if (value.length <= normalizedMax) return value;
  if (normalizedMax <= 3) return value.slice(0, normalizedMax);
  return `${value.slice(0, normalizedMax - 3).trimEnd()}...`;
}

export function formatChunksForPrompt(chunks: SearchChunk[], options: PromptContextOptions = {}): string {
  const text = chunks
    .map((chunk, index) => {
      const semanticFacts = formatSemanticFacts(chunk.semanticFacts);
      const semanticBlock = semanticFacts ? `\nСвойства документа:\n${semanticFacts}` : '';
      const trustBlock = formatTrustMetadata(chunk);
      return `[${index + 1}] ${formatChunkTitle(chunk)}${semanticBlock}${trustBlock}\n\n${chunk.text}`;
    })
    .join('\n\n');
  return truncatePromptContext(text, options.maxChars);
}

export function formatSourceGroupsForPrompt(
  groups: PromptContextSourceGroup[],
  options: PromptContextOptions = {}
): string {
  const text = groups
    .map((group) => {
      const semanticFacts = formatSemanticFacts(group.semanticFacts);
      const semanticBlock = semanticFacts ? `\nСвойства документа:\n${semanticFacts}` : '';
      const trustBlock = formatTrustMetadata({
        id: 0,
        pageId: 0,
        title: group.title,
        text: group.text ?? '',
        namespace: 0,
        allowedGroups: [],
        score: 0,
        lastModified: group.lastModified,
        trust: group.trust,
      });
      return `[Источник ${group.citationIndex}] ${formatSourceGroupTitle(group)}${semanticBlock}${trustBlock}\n\n${formatSourceGroupText(group)}`;
    })
    .join('\n\n');
  return truncatePromptContext(text, options.maxChars);
}
