import { config } from '../config.js';

export interface Chunk {
  text: string;
  index: number;
  total: number;
}

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  chunkSeparators?: string[];
}

function getChunkSize(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined) return config.chunkSize;
  return Math.max(128, Math.min(value, 4096));
}

function getChunkOverlap(value: number | undefined, chunkSize: number): number {
  if (!Number.isInteger(value) || value === undefined) return Math.min(config.chunkOverlap, chunkSize - 1);
  return Math.max(0, Math.min(value, chunkSize - 1));
}

function getChunkSeparators(value: string[] | undefined): string[] {
  if (!value || value.length === 0) return ['\n## ', '\n### ', '\n\n', '\n', '. ', ' '];
  return value.filter((separator) => separator.length > 0).slice(0, 16);
}

export function splitText(text: string, options: ChunkingOptions = {}): Chunk[] {
  const chunkSize = getChunkSize(options.chunkSize);
  const chunkOverlap = getChunkOverlap(options.chunkOverlap, chunkSize);
  const separators = getChunkSeparators(options.chunkSeparators);
  const chunks: Chunk[] = [];
  let remaining = text.trim();
  let index = 0;

  while (remaining.length > 0) {
    let chunk: string;
    if (remaining.length <= chunkSize) {
      chunk = remaining;
      remaining = '';
    } else {
      chunk = remaining.slice(0, chunkSize);
      for (const sep of separators) {
        const breakPos = chunk.lastIndexOf(sep);
        if (breakPos > chunkSize * 0.5) {
          chunk = remaining.slice(0, breakPos + sep.length);
          break;
        }
      }
      remaining = remaining.slice(chunk.length - chunkOverlap);
    }
    chunks.push({ text: chunk.trim(), index, total: 0 });
    index++;
  }

  chunks.forEach((c, i) => { c.index = i; c.total = chunks.length; });
  return chunks;
}
