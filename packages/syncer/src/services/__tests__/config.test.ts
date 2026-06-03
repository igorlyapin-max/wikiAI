import { describe, expect, it } from 'vitest';
import { parseDiagnosticLevel, parseLogSinks } from '../../config.js';

describe('syncer config parsing', () => {
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
