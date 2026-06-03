import { describe, expect, it } from 'vitest';
import { parseCorsOrigins, parseDiagnosticLevel, parseLogSinks } from '../config.js';

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

  it('normalizes diagnostic level', () => {
    expect(parseDiagnosticLevel(undefined)).toBe('Basic');
    expect(parseDiagnosticLevel('Verbose')).toBe('Verbose');
    expect(parseDiagnosticLevel('unsupported')).toBe('Basic');
  });

  it('normalizes supported log sinks and keeps stdout as fallback', () => {
    expect(parseLogSinks('stdout,syslog,stdout')).toEqual(['stdout', 'syslog']);
    expect(parseLogSinks('invalid')).toEqual(['stdout']);
  });
});
