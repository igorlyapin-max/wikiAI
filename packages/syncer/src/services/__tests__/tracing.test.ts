import { describe, expect, it } from 'vitest';
import {
  currentTraceHeaders,
  enterTraceContext,
  getTraceContext,
  traceContextFromHeaders,
} from '../tracing.js';

describe('syncer tracing helpers', () => {
  it('accepts request id and valid traceparent headers', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
    const context = traceContextFromHeaders({
      'x-request-id': 'req-1',
      traceparent,
    });

    enterTraceContext(context);

    expect(getTraceContext()).toEqual({ requestId: 'req-1', traceparent });
    expect(currentTraceHeaders()).toEqual({
      'x-request-id': 'req-1',
      traceparent,
    });
  });

  it('generates a request id and drops invalid traceparent headers', () => {
    const context = traceContextFromHeaders({ traceparent: 'not-a-trace' });

    expect(context.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(context.traceparent).toBeUndefined();
  });
});
