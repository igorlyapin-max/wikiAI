import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestTraceContext {
  requestId: string;
  traceparent?: string;
}

const traceStorage = new AsyncLocalStorage<RequestTraceContext>();
const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i;

function readHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return readHeader(value[0]);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function traceContextFromHeaders(headers: Record<string, unknown>): RequestTraceContext {
  const requestId = readHeader(headers['x-request-id']) ?? randomUUID();
  const traceparent = readHeader(headers.traceparent);
  return {
    requestId,
    traceparent: traceparent && TRACEPARENT_RE.test(traceparent) ? traceparent : undefined,
  };
}

export function enterTraceContext(context: RequestTraceContext): void {
  traceStorage.enterWith(context);
}

export function getTraceContext(): RequestTraceContext | undefined {
  return traceStorage.getStore();
}

export function currentTraceHeaders(): Record<string, string> {
  const context = getTraceContext();
  if (!context) return {};
  return {
    'x-request-id': context.requestId,
    ...(context.traceparent ? { traceparent: context.traceparent } : {}),
  };
}
