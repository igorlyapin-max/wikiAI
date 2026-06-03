import { createSocket, Socket } from 'node:dgram';
import { hostname } from 'node:os';
import { FastifyServerOptions } from 'fastify';
import { config } from '../config.js';

type LogLevelName = 'info' | 'error' | 'warn' | 'debug';

const SERVICE_NAME = 'syncer';
const HOSTNAME = hostname();

const REDACT_PATHS = [
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  '*.token',
  '*.Token',
  '*.password',
  '*.Password',
  '*.secret',
  '*.Secret',
  '*.apiKey',
  '*.api_key',
  'syncerAdminToken',
  'mwSyncCookie',
  'mwServicePassword',
  'pamToken',
  'pamPassword',
];

let syslogSocket: Socket | undefined;

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|password|secret|token|apikey|api_key|bearer/i.test(key);
}

function sanitizeForLog(value: unknown, key = ''): unknown {
  if (key && isSensitiveKey(key)) return '[redacted]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: config.debugDiagnosticsLevel === 'Verbose' ? value.stack : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeForLog(entryValue, entryKey),
      ])
    );
  }
  return value;
}

function pinoLevel(level: LogLevelName): number {
  if (level === 'error') return 50;
  if (level === 'warn') return 40;
  if (level === 'debug') return 20;
  return 30;
}

function parsePinoLevel(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as { level?: unknown };
    return typeof parsed.level === 'number' ? parsed.level : undefined;
  } catch {
    return undefined;
  }
}

function ensureLine(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`;
}

function writeProcessStream(line: string): void {
  const level = parsePinoLevel(line);
  if (level !== undefined && level >= 50) {
    process.stderr.write(line);
    return;
  }
  process.stdout.write(line);
}

function syslogPriority(line: string): string {
  const level = parsePinoLevel(line);
  if (level !== undefined && level >= 50) return '<11>';
  if (level !== undefined && level >= 40) return '<12>';
  if (level !== undefined && level <= 20) return '<15>';
  return '<14>';
}

function writeSyslog(line: string): void {
  syslogSocket ??= createSocket('udp4');
  syslogSocket.unref();
  const message = Buffer.from(
    `${syslogPriority(line)}${new Date().toISOString()} ${HOSTNAME} wikiai-${SERVICE_NAME}[${process.pid}]: ${line.trim()}`
  );
  syslogSocket.send(message, config.logSyslogPort, config.logSyslogHost, () => undefined);
}

function writeLogLine(message: string): void {
  const line = ensureLine(message);
  if (config.logSinks.includes('stdout')) writeProcessStream(line);
  if (config.logSinks.includes('syslog')) writeSyslog(line);
}

export function createFastifyLoggerOptions(): FastifyServerOptions['logger'] {
  return {
    level: config.debugDiagnosticsEnabled ? 'debug' : 'info',
    base: {
      service: SERVICE_NAME,
      env: config.nodeEnv,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
    },
    stream: {
      write: writeLogLine,
    },
  } as FastifyServerOptions['logger'];
}

export function logOperationalEvent(
  level: LogLevelName,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const safeFields = sanitizeForLog(fields) as Record<string, unknown>;
  writeLogLine(JSON.stringify({
    level: pinoLevel(level),
    time: Date.now(),
    service: SERVICE_NAME,
    env: config.nodeEnv,
    event,
    ...safeFields,
  }));
}

export function logOperationalError(
  event: string,
  err: unknown,
  fields: Record<string, unknown> = {}
): void {
  logOperationalEvent('error', event, {
    ...fields,
    error: sanitizeForLog(err),
  });
}

export function diagnosticStartupFields(): Record<string, unknown> {
  if (config.debugDiagnosticsLevel === 'Verbose') {
    return {
      diagnostics: {
        enabled: config.debugDiagnosticsEnabled,
        level: config.debugDiagnosticsLevel,
        nodeEnv: config.nodeEnv,
        logSinks: config.logSinks,
        qdrantUrl: config.qdrantUrl,
        gatewayBaseUrl: config.gatewayBaseUrl,
        mwBaseUrl: config.mwBaseUrl,
      },
    };
  }

  return {
    diagnostics: {
      enabled: config.debugDiagnosticsEnabled,
      level: config.debugDiagnosticsLevel,
      nodeEnv: config.nodeEnv,
      logSinks: config.logSinks,
      dependencies: {
        qdrant: Boolean(config.qdrantUrl),
        gateway: Boolean(config.gatewayBaseUrl),
        mediawiki: Boolean(config.mwBaseUrl),
      },
    },
  };
}
