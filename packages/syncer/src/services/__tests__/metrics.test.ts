import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  recordDependencyMetric,
  recordHealthCheckMetric,
  recordRequestEnd,
  recordRequestStart,
  registerMetrics,
  renderMetrics,
  resetMetricsForTests,
  setSchedulerLockStatus,
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

  it('serves metrics through the registered Fastify endpoint', async () => {
    const app = Fastify();
    registerMetrics(app, 'syncer');
    app.get('/probe', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/probe' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('wikiai_process_uptime_seconds{service="syncer"}');
    expect(metrics.body).toContain('wikiai_http_requests_total{service="syncer",method="GET",route="/probe",status="200"} 1');

    await app.close();
  });

  it('renders dependency, health, scheduler and event loop metrics with bounded labels', () => {
    recordDependencyMetric({
      dependency: 'mediawiki',
      operation: 'query/title?token=secret',
      status: 'error',
      durationSeconds: 0.5,
    });
    recordHealthCheckMetric({ check: 'gateway', ok: false, latencyMs: 42 });
    setSchedulerLockStatus('syncer_reindex', false);

    const metrics = renderMetrics('syncer');

    expect(metrics).toContain('wikiai_dependency_requests_total{service="syncer",dependency="mediawiki",operation="query_title_token_secret",status="error"} 1');
    expect(metrics).toContain('wikiai_health_check_status{service="syncer",check="gateway"} 0');
    expect(metrics).toContain('wikiai_scheduler_lock_held{service="syncer",scheduler="syncer_reindex"} 0');
    expect(metrics).toContain('wikiai_event_loop_lag_seconds{service="syncer"}');
    expect(metrics).not.toContain('token=secret');
  });
});
