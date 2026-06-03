import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  createFastifyLoggerOptions,
  diagnosticStartupFields,
  logOperationalError,
  logOperationalEvent,
} from '../logging.js';

const sendMock = vi.hoisted(() => vi.fn());
const unrefMock = vi.hoisted(() => vi.fn());

vi.mock('node:dgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dgram')>();
  return {
    ...actual,
    createSocket: vi.fn(() => ({
      unref: unrefMock,
      send: sendMock,
    })),
  };
});

const originalConfig = { ...config };

afterEach(() => {
  Object.assign(config, originalConfig);
  vi.restoreAllMocks();
  sendMock.mockReset();
  unrefMock.mockReset();
});

describe('syncer structured logging', () => {
  it('builds Fastify logger options with redaction paths and debug level when diagnostics are enabled', () => {
    config.debugDiagnosticsEnabled = false;
    expect(createFastifyLoggerOptions()).toMatchObject({
      level: 'info',
      base: {
        service: 'syncer',
        env: config.nodeEnv,
      },
    });

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

  it('writes Verbose error stacks and syslog messages through the configured sink', () => {
    config.logSinks = ['stdout', 'syslog'];
    config.debugDiagnosticsLevel = 'Verbose';
    config.logSyslogHost = '127.0.0.3';
    config.logSyslogPort = 5515;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logOperationalError('syncer.verbose_error', new Error('verbose boom'), {
      nested: [{ pamToken: 'secret-pam-token' }],
    });

    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line).toContain('"stack"');
    expect(line).toContain('"pamToken":"[redacted]"');
    expect(line).not.toContain('secret-pam-token');
    expect(createSocket).toHaveBeenCalledWith('udp4');
    expect(unrefMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      5515,
      '127.0.0.3',
      expect.any(Function)
    );
    expect(String(sendMock.mock.calls[0]?.[0])).toContain('wikiai-syncer');
  });

  it('routes warn and debug operational events to stdout', () => {
    config.logSinks = ['stdout'];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    logOperationalEvent('warn', 'syncer.warn');
    logOperationalEvent('debug', 'syncer.debug');

    expect(String(stdout.mock.calls[0]?.[0])).toContain('"level":40');
    expect(String(stdout.mock.calls[1]?.[0])).toContain('"level":20');
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
