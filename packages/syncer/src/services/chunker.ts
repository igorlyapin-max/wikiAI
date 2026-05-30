import { config } from '../config.js';

export interface Chunk {
  text: string;
  index: number;
  total: number;
}

export function splitText(text: string): Chunk[] {
  const separators = ['\n## ', '\n### ', '\n\n', '\n', '. ', ' '];
  const chunks: Chunk[] = [];
  let remaining = text.trim();
  let index = 0;

  while (remaining.length > 0) {
    let chunk: string;
    if (remaining.length <= config.chunkSize) {
      chunk = remaining;
      remaining = '';
    } else {
      chunk = remaining.slice(0, config.chunkSize);
      for (const sep of separators) {
        const breakPos = chunk.lastIndexOf(sep);
        if (breakPos > config.chunkSize * 0.5) {
          chunk = remaining.slice(0, breakPos + sep.length);
          break;
        }
      }
      remaining = remaining.slice(chunk.length - config.chunkOverlap);
    }
    chunks.push({ text: chunk.trim(), index, total: 0 });
    index++;
  }

  chunks.forEach((c, i) => { c.index = i; c.total = chunks.length; });
  return chunks;
}
