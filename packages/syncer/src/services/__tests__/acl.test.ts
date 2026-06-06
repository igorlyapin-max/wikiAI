import { describe, expect, it } from 'vitest';
import { getAllowedGroups } from '../acl.js';

describe('namespace ACL', () => {
  it('fails closed for namespaces that are not explicitly configured', () => {
    expect(getAllowedGroups(3030, { 0: ['*'] })).toEqual([]);
  });

  it('keeps explicit public namespace mappings public', () => {
    expect(getAllowedGroups(0, { 0: ['*'] })).toEqual(['*']);
  });
});
