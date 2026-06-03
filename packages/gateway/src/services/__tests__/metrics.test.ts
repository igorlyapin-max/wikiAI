import { afterEach, describe, expect, it } from 'vitest';
import {
  recordRequestEnd,
  recordRequestStart,
  renderMetrics,
  resetMetricsForTests,
} from '../metrics.js';

describe('gateway metrics', () => {
  afterEach(() => {
    resetMetricsForTests();
  });

  it('renders request counters and process gauges', () => {
    const request = {};
    recordRequestStart(request);
    recordRequestEnd({
      request,
      method: 'GET',
      route: '/ready',
      statusCode: 200,
    });

    const metrics = renderMetrics('gateway');

    expect(metrics).toContain('wikiai_process_start_time_seconds{service="gateway"}');
    expect(metrics).toContain('wikiai_http_requests_in_flight{service="gateway"} 0');
    expect(metrics).toContain(
      'wikiai_http_requests_total{service="gateway",method="GET",route="/ready",status="200"} 1'
    );
    expect(metrics).toContain(
      'wikiai_http_request_duration_seconds_count{service="gateway",method="GET",route="/ready",status="200"} 1'
    );
  });
});
