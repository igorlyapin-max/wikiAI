import { afterEach, describe, expect, it } from 'vitest';
import {
  recordRequestEnd,
  recordRequestStart,
  renderMetrics,
  resetMetricsForTests,
} from '../metrics.js';

describe('syncer metrics', () => {
  afterEach(() => {
    resetMetricsForTests();
  });

  it('renders request counters and process gauges', () => {
    const request = {};
    recordRequestStart(request);
    recordRequestEnd({
      request,
      method: 'POST',
      route: '/webhook/page',
      statusCode: 202,
    });

    const metrics = renderMetrics('syncer');

    expect(metrics).toContain('wikiai_process_start_time_seconds{service="syncer"}');
    expect(metrics).toContain('wikiai_http_requests_in_flight{service="syncer"} 0');
    expect(metrics).toContain(
      'wikiai_http_requests_total{service="syncer",method="POST",route="/webhook/page",status="202"} 1'
    );
    expect(metrics).toContain(
      'wikiai_http_request_duration_seconds_count{service="syncer",method="POST",route="/webhook/page",status="202"} 1'
    );
  });
});
