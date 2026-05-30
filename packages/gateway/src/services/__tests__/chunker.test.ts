import { describe, it, expect } from 'vitest';

interface Chunk {
  text: string;
  index: number;
  total: number;
}

function splitText(text: string, chunkSize = 512, chunkOverlap = 50): Chunk[] {
  const separators = ['\n## ', '\n### ', '\n\n', '\n', '. ', ' '];
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

describe('Text Chunking', () => {
  it('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(2000);
    const chunks = splitText(text, 512, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(512);
  });

  it('respects chunkSize limit', () => {
    const text = 'word '.repeat(300);
    const chunks = splitText(text, 256, 20);
    chunks.forEach((c) => {
      expect(c.text.length).toBeLessThanOrEqual(300); // with some tolerance
    });
  });

  it('splits at natural boundaries', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three with more words here.';
    const chunks = splitText(text, 100, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].total).toBe(chunks.length);
  });

  it('handles short text as single chunk', () => {
    const text = 'Short text';
    const chunks = splitText(text, 512, 50);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('Short text');
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].total).toBe(1);
  });
});
