import { describe, expect, it } from 'vitest';
import { getNamespacesToReindex } from '../reindex-scope.js';

describe('reindex scope', () => {
  it('uses sorted namespaces from namespace ACL', () => {
    expect(getNamespacesToReindex({ 3030: ['ai-it'], 0: ['*'], 3010: ['ai-hr'] })).toEqual([
      0,
      3010,
      3030,
    ]);
  });

  it('falls back to the main namespace for an empty ACL', () => {
    expect(getNamespacesToReindex({})).toEqual([0]);
  });
});
