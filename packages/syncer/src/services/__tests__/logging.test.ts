import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  createFastifyLoggerOptions,
  diagnosticStartupFields,
  logOperationalError,
  logOperationalEvent,
} from '../logging.js';

const originalConfig = { ...config };

afterEach(() => {
  Object.assign(config, originalConfig);
  vi.restoreAllMocks();
});

describe('syncer structured logging', () => {
  it('builds Fastify logger options with redaction paths and debug level when diagnostics are enabled', () => {
    config.debugDiagnosticsEnabled = true;

    const logger = createFastifyLoggerOptions() as {
      level: string;
      redact: { paths: string[]; censor: string };
    };

    expect(logger.level).toBe('debug');
    expect(logger.redact.censor).toBe('[redacted]');
    expect(logger.redact.paths).toEqual(expect.arrayContaining([
      'headers.authorization',
      'mwServicePassword',
      'syncerAdminToken',
    ]));
  });

  it('writes safe operational events to stdout and redacts sensitive fields', () => {
    config.logSinks = ['stdout'];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    logOperationalEvent('info', 'syncer.test', {
      syncerAdminToken: 'secret-token',
      nested: { password: 'secret-password', ok: true },
    });

    const line = String(stdout.mock.calls[0]?.[0]);
    expect(line).toContain('"event":"syncer.test"');
    expect(line).toContain('"syncerAdminToken":"[redacted]"');
    expect(line).toContain('"password":"[redacted]"');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('secret-password');
  });

  it('writes operational errors to stderr without stack traces in Basic diagnostics', () => {
    config.logSinks = ['stdout'];
    config.debugDiagnosticsLevel = 'Basic';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logOperationalError('syncer.error', new Error('boom'), { cookie: 'mw=1' });

    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line).toContain('"level":50');
    expect(line).toContain('"event":"syncer.error"');
    expect(line).toContain('"cookie":"[redacted]"');
    expect(line).toContain('"message":"boom"');
    expect(line).not.toContain('"stack"');
  });

  it('emits Basic dependency diagnostics and Verbose endpoint diagnostics', () => {
    config.debugDiagnosticsEnabled = true;
    config.debugDiagnosticsLevel = 'Basic';
    expect(diagnosticStartupFields()).toMatchObject({
      diagnostics: {
        enabled: true,
        level: 'Basic',
        dependencies: {
          qdrant: true,
          gateway: true,
          mediawiki: true,
        },
      },
    });

    config.debugDiagnosticsLevel = 'Verbose';
    expect(diagnosticStartupFields()).toMatchObject({
      diagnostics: {
        enabled: true,
        level: 'Verbose',
        qdrantUrl: config.qdrantUrl,
        gatewayBaseUrl: config.gatewayBaseUrl,
        mwBaseUrl: config.mwBaseUrl,
      },
    });
  });
});
