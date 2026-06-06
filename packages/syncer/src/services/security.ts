import { createHash, timingSafeEqual } from 'node:crypto';

export function timingSafeEqualString(actual: unknown, expected: string | undefined): boolean {
  if (typeof actual !== 'string' || !expected) return false;

  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash) && actual.length === expected.length;
}
