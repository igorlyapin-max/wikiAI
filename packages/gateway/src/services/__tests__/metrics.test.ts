import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  recordRequestEnd,
  recordRequestStart,
  recordTrigramBackfillJobMetric,
  recordTrigramBackfillProgress,
  recordTrigramSearchMetrics,
  registerMetrics,
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

  it('renders trigram search and backfill metrics', () => {
    recordTrigramSearchMetrics({ result: 'hit', latencyMs: 17, rawCandidates: 3 });
    recordTrigramBackfillJobMetric('completed');
    recordTrigramBackfillProgress(42);

    const metrics = renderMetrics('gateway');

    expect(metrics).toContain('wikiai_search_trigram_queries_total{service="gateway",result="hit"} 1');
    expect(metrics).toContain('wikiai_search_trigram_last_latency_ms{service="gateway"} 17');
    expect(metrics).toContain('wikiai_search_trigram_raw_candidates_total{service="gateway"} 3');
    expect(metrics).toContain('wikiai_trigram_backfill_jobs_total{service="gateway",status="completed"} 1');
    expect(metrics).toContain('wikiai_trigram_backfill_progress_chunks{service="gateway"} 42');
  });

  it('serves metrics through the registered Fastify endpoint', async () => {
    const app = Fastify();
    registerMetrics(app, 'gateway');
    app.get('/probe', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/probe' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('wikiai_process_uptime_seconds{service="gateway"}');
    expect(metrics.body).toContain('wikiai_http_requests_total{service="gateway",method="GET",route="/probe",status="200"} 1');

    await app.close();
  });
});
