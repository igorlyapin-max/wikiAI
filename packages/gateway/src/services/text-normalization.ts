const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  apos: "'",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return ENTITY_MAP[normalized] ?? match;
  });
}

function normalizePlainSegment(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?>/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toSearchPlainText(value: string): string {
  const parts: string[] = [];
  const fencePattern = /```[\s\S]*?```/g;
  let cursor = 0;
  for (const match of value.matchAll(fencePattern)) {
    const index = match.index ?? 0;
    const before = normalizePlainSegment(value.slice(cursor, index));
    if (before) parts.push(before);
    parts.push(match[0]);
    cursor = index + match[0].length;
  }
  const after = normalizePlainSegment(value.slice(cursor));
  if (after) parts.push(after);
  return parts.join('\n\n').trim();
}
