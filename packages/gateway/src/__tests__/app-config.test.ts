import { describe, expect, it } from 'vitest';
import { parseCorsOrigins } from '../config.js';

describe('gateway app config', () => {
  it('uses explicit CORS origins when provided', () => {
    expect(parseCorsOrigins(' http://one.local, http://two.local,http://one.local ', 'development')).toEqual([
      'http://one.local',
      'http://two.local',
    ]);
  });

  it('disables default CORS origins in production', () => {
    expect(parseCorsOrigins(undefined, 'production')).toEqual([]);
  });

  it('allows local UI origins outside production', () => {
    expect(parseCorsOrigins(undefined, 'development')).toEqual(
      expect.arrayContaining(['http://localhost:5173', 'http://127.0.0.1:5173'])
    );
  });
});
