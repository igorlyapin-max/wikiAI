import { SearchChunk, SemanticFacts } from '../types/index.js';

export interface PromptContextOptions {
  maxChars?: number;
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
      return `[${index + 1}] ${chunk.title}${semanticBlock}${trustBlock}\n\n${chunk.text}`;
    })
    .join('\n\n');
  return truncatePromptContext(text, options.maxChars);
}
