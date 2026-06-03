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

describe('gateway structured logging', () => {
  it('builds Fastify logger options for default and diagnostic modes', () => {
    config.debugDiagnosticsEnabled = false;
    expect(createFastifyLoggerOptions()).toMatchObject({
      level: 'info',
      base: {
        service: 'gateway',
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
      'litellmApiKey',
      'sessionCookie',
    ]));
  });

  it('routes process log lines and redacts nested sensitive fields', () => {
    config.logSinks = ['stdout'];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logOperationalEvent('debug', 'gateway.debug', {
      bearerToken: 'secret-token',
      nested: [{ apiKey: 'secret-key', ok: true }],
    });
    logOperationalError('gateway.error', new Error('boom'), { sessionCookie: 'mw=1' });

    const debugLine = String(stdout.mock.calls[0]?.[0]);
    const errorLine = String(stderr.mock.calls[0]?.[0]);
    expect(debugLine).toContain('"level":20');
    expect(debugLine).toContain('"bearerToken":"[redacted]"');
    expect(debugLine).toContain('"apiKey":"[redacted]"');
    expect(debugLine).not.toContain('secret-token');
    expect(errorLine).toContain('"level":50');
    expect(errorLine).toContain('"sessionCookie":"[redacted]"');
    expect(errorLine).not.toContain('"stack"');
  });

  it('includes error stacks only in Verbose diagnostics and emits syslog messages', () => {
    config.logSinks = ['stdout', 'syslog'];
    config.debugDiagnosticsLevel = 'Verbose';
    config.logSyslogHost = '127.0.0.2';
    config.logSyslogPort = 5514;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logOperationalError('gateway.verbose_error', new Error('verbose boom'));

    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line).toContain('"stack"');
    expect(createSocket).toHaveBeenCalledWith('udp4');
    expect(unrefMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      5514,
      '127.0.0.2',
      expect.any(Function)
    );
    expect(String(sendMock.mock.calls[0]?.[0])).toContain('wikiai-gateway');
  });

  it('reports Basic dependency diagnostics and Verbose endpoint diagnostics', () => {
    config.debugDiagnosticsEnabled = true;
    config.debugDiagnosticsLevel = 'Basic';
    expect(diagnosticStartupFields()).toMatchObject({
      diagnostics: {
        enabled: true,
        level: 'Basic',
        dependencies: {
          qdrant: true,
          redis: true,
          litellm: true,
          syncer: true,
        },
      },
    });

    config.debugDiagnosticsLevel = 'Verbose';
    expect(diagnosticStartupFields()).toMatchObject({
      diagnostics: {
        enabled: true,
        level: 'Verbose',
        qdrantUrl: config.qdrantUrl,
        redisUrl: config.redisUrl,
        litellmBaseUrl: config.litellmBaseUrl,
        syncerBaseUrl: config.syncerBaseUrl,
      },
    });
  });
});
