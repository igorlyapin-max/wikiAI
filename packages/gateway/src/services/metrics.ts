import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface RequestMetricKey {
  method: string;
  route: string;
  statusCode: number;
}

interface RequestMetricValue {
  count: number;
  durationSecondsSum: number;
}

interface DependencyMetricValue {
  count: number;
  durationSecondsSum: number;
}

interface HealthCheckMetricValue {
  status: 0 | 1;
  latencyMs: number;
}

const requestStarts = new WeakMap<object, bigint>();
const requestMetrics = new Map<string, RequestMetricValue>();
const dependencyMetrics = new Map<string, DependencyMetricValue>();
const healthCheckMetrics = new Map<string, HealthCheckMetricValue>();
const schedulerLockMetrics = new Map<string, 0 | 1>();
const processStartTimeSeconds = Date.now() / 1000;
let inFlightRequests = 0;
let eventLoopLagSeconds = 0;
let eventLoopLagTimer: NodeJS.Timeout | undefined;
const trigramQueryCounts = new Map<string, number>();
const trigramBackfillJobCounts = new Map<string, number>();
let trigramLastLatencyMs = 0;
let trigramRawCandidatesTotal = 0;
let trigramBackfillProgressChunks = 0;

function labelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function normalizeRoute(value: string | undefined): string {
  const route = value?.split('?')[0] || 'unmatched';
  return route.replace(/[^A-Za-z0-9_:/{}.-]/g, '_');
}

function lowCardinalityLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 96);
}

function metricKey(input: RequestMetricKey): string {
  return `${input.method} ${input.route} ${input.statusCode}`;
}

function dependencyMetricKey(input: {
  dependency: string;
  operation: string;
  status: string;
}): string {
  return [
    lowCardinalityLabel(input.dependency),
    lowCardinalityLabel(input.operation),
    lowCardinalityLabel(input.status),
  ].join(' ');
}

function readRoute(request: FastifyRequest): string {
  return normalizeRoute(request.routeOptions?.url ?? request.url);
}

export function recordRequestStart(request: object): void {
  inFlightRequests += 1;
  requestStarts.set(request, process.hrtime.bigint());
}

export function recordRequestEnd(input: {
  request: object;
  method: string;
  route: string;
  statusCode: number;
}): void {
  inFlightRequests = Math.max(0, inFlightRequests - 1);
  const startedAt = requestStarts.get(input.request);
  requestStarts.delete(input.request);
  const durationSeconds = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1_000_000_000 : 0;
  const key = metricKey(input);
  const current = requestMetrics.get(key) ?? { count: 0, durationSecondsSum: 0 };
  current.count += 1;
  current.durationSecondsSum += durationSeconds;
  requestMetrics.set(key, current);
}

export function recordDependencyMetric(input: {
  dependency: string;
  operation: string;
  status: string;
  durationSeconds: number;
}): void {
  const key = dependencyMetricKey(input);
  const current = dependencyMetrics.get(key) ?? { count: 0, durationSecondsSum: 0 };
  current.count += 1;
  current.durationSecondsSum += Math.max(0, input.durationSeconds);
  dependencyMetrics.set(key, current);
}

export async function measureDependency<T>(
  input: { dependency: string; operation: string },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await operation();
    const responseStatus = result instanceof Response && !result.ok ? `http_${result.status}` : 'ok';
    recordDependencyMetric({
      ...input,
      status: responseStatus,
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    });
    return result;
  } catch (err) {
    recordDependencyMetric({
      ...input,
      status: 'error',
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    });
    throw err;
  }
}

export function recordHealthCheckMetric(input: {
  check: string;
  ok: boolean;
  latencyMs: number;
}): void {
  healthCheckMetrics.set(lowCardinalityLabel(input.check), {
    status: input.ok ? 1 : 0,
    latencyMs: Math.max(0, input.latencyMs),
  });
}

export function setSchedulerLockStatus(scheduler: string, held: boolean): void {
  schedulerLockMetrics.set(lowCardinalityLabel(scheduler), held ? 1 : 0);
}

function startEventLoopLagMonitor(): void {
  if (eventLoopLagTimer) return;
  const intervalMs = 1000;
  let expectedAt = Date.now() + intervalMs;
  eventLoopLagTimer = setInterval(() => {
    const now = Date.now();
    eventLoopLagSeconds = Math.max(0, now - expectedAt) / 1000;
    expectedAt = now + intervalMs;
  }, intervalMs);
  eventLoopLagTimer.unref();
}

function stopEventLoopLagMonitor(): void {
  if (!eventLoopLagTimer) return;
  clearInterval(eventLoopLagTimer);
  eventLoopLagTimer = undefined;
}

export function renderMetrics(serviceName = 'gateway'): string {
  const lines = [
    '# HELP wikiai_process_start_time_seconds Unix time when the process started.',
    '# TYPE wikiai_process_start_time_seconds gauge',
    `wikiai_process_start_time_seconds{service="${labelValue(serviceName)}"} ${processStartTimeSeconds}`,
    '# HELP wikiai_process_uptime_seconds Process uptime in seconds.',
    '# TYPE wikiai_process_uptime_seconds gauge',
    `wikiai_process_uptime_seconds{service="${labelValue(serviceName)}"} ${process.uptime()}`,
    '# HELP wikiai_http_requests_in_flight Current in-flight HTTP requests.',
    '# TYPE wikiai_http_requests_in_flight gauge',
    `wikiai_http_requests_in_flight{service="${labelValue(serviceName)}"} ${inFlightRequests}`,
    '# HELP wikiai_http_requests_total Total HTTP requests by method, route and status.',
    '# TYPE wikiai_http_requests_total counter',
  ];

  for (const [key, value] of requestMetrics) {
    const [method, route, statusCode] = key.split(' ');
    const labels = `service="${labelValue(serviceName)}",method="${labelValue(method)}",route="${labelValue(route)}",status="${labelValue(statusCode)}"`;
    lines.push(`wikiai_http_requests_total{${labels}} ${value.count}`);
    lines.push(`wikiai_http_request_duration_seconds_sum{${labels}} ${value.durationSecondsSum}`);
    lines.push(`wikiai_http_request_duration_seconds_count{${labels}} ${value.count}`);
  }

  lines.push('# HELP wikiai_dependency_requests_total Total dependency calls by dependency, operation and status.');
  lines.push('# TYPE wikiai_dependency_requests_total counter');
  for (const [key, value] of dependencyMetrics) {
    const [dependency, operation, status] = key.split(' ');
    const labels = `service="${labelValue(serviceName)}",dependency="${labelValue(dependency)}",operation="${labelValue(operation)}",status="${labelValue(status)}"`;
    lines.push(`wikiai_dependency_requests_total{${labels}} ${value.count}`);
    lines.push(`wikiai_dependency_request_duration_seconds_sum{${labels}} ${value.durationSecondsSum}`);
    lines.push(`wikiai_dependency_request_duration_seconds_count{${labels}} ${value.count}`);
  }

  lines.push('# HELP wikiai_health_check_status Last health check status, 1 for ok and 0 for error.');
  lines.push('# TYPE wikiai_health_check_status gauge');
  lines.push('# HELP wikiai_health_check_latency_ms Last health check latency in milliseconds.');
  lines.push('# TYPE wikiai_health_check_latency_ms gauge');
  for (const [check, value] of healthCheckMetrics) {
    const labels = `service="${labelValue(serviceName)}",check="${labelValue(check)}"`;
    lines.push(`wikiai_health_check_status{${labels}} ${value.status}`);
    lines.push(`wikiai_health_check_latency_ms{${labels}} ${value.latencyMs}`);
  }

  lines.push('# HELP wikiai_scheduler_lock_held Scheduler distributed lock status, 1 when held by this process.');
  lines.push('# TYPE wikiai_scheduler_lock_held gauge');
  for (const [scheduler, held] of schedulerLockMetrics) {
    const labels = `service="${labelValue(serviceName)}",scheduler="${labelValue(scheduler)}"`;
    lines.push(`wikiai_scheduler_lock_held{${labels}} ${held}`);
  }

  lines.push('# HELP wikiai_event_loop_lag_seconds Last measured event loop lag in seconds.');
  lines.push('# TYPE wikiai_event_loop_lag_seconds gauge');
  lines.push(`wikiai_event_loop_lag_seconds{service="${labelValue(serviceName)}"} ${eventLoopLagSeconds}`);

  lines.push('# HELP wikiai_search_trigram_queries_total Total trigram search attempts by result.');
  lines.push('# TYPE wikiai_search_trigram_queries_total counter');
  for (const [result, count] of trigramQueryCounts) {
    const labels = `service="${labelValue(serviceName)}",result="${labelValue(result)}"`;
    lines.push(`wikiai_search_trigram_queries_total{${labels}} ${count}`);
  }
  lines.push('# HELP wikiai_search_trigram_last_latency_ms Last trigram search stage latency in milliseconds.');
  lines.push('# TYPE wikiai_search_trigram_last_latency_ms gauge');
  lines.push(`wikiai_search_trigram_last_latency_ms{service="${labelValue(serviceName)}"} ${trigramLastLatencyMs}`);
  lines.push('# HELP wikiai_search_trigram_raw_candidates_total Total raw candidates returned by trigram search.');
  lines.push('# TYPE wikiai_search_trigram_raw_candidates_total counter');
  lines.push(`wikiai_search_trigram_raw_candidates_total{service="${labelValue(serviceName)}"} ${trigramRawCandidatesTotal}`);
  lines.push('# HELP wikiai_trigram_backfill_jobs_total Total trigram backfill jobs by final or current status.');
  lines.push('# TYPE wikiai_trigram_backfill_jobs_total counter');
  for (const [status, count] of trigramBackfillJobCounts) {
    const labels = `service="${labelValue(serviceName)}",status="${labelValue(status)}"`;
    lines.push(`wikiai_trigram_backfill_jobs_total{${labels}} ${count}`);
  }
  lines.push('# HELP wikiai_trigram_backfill_progress_chunks Latest trigram backfill processed chunk count.');
  lines.push('# TYPE wikiai_trigram_backfill_progress_chunks gauge');
  lines.push(`wikiai_trigram_backfill_progress_chunks{service="${labelValue(serviceName)}"} ${trigramBackfillProgressChunks}`);

  return `${lines.join('\n')}\n`;
}

export function recordTrigramSearchMetrics(input: {
  result: 'hit' | 'filtered' | 'miss' | 'skipped' | 'error';
  latencyMs: number;
  rawCandidates: number;
}): void {
  trigramQueryCounts.set(input.result, (trigramQueryCounts.get(input.result) ?? 0) + 1);
  trigramLastLatencyMs = input.latencyMs;
  trigramRawCandidatesTotal += input.rawCandidates;
}

export function recordTrigramBackfillJobMetric(status: string): void {
  trigramBackfillJobCounts.set(status, (trigramBackfillJobCounts.get(status) ?? 0) + 1);
}

export function recordTrigramBackfillProgress(processedChunks: number): void {
  trigramBackfillProgressChunks = processedChunks;
}

export function resetMetricsForTests(): void {
  requestMetrics.clear();
  dependencyMetrics.clear();
  healthCheckMetrics.clear();
  schedulerLockMetrics.clear();
  trigramQueryCounts.clear();
  trigramBackfillJobCounts.clear();
  trigramLastLatencyMs = 0;
  trigramRawCandidatesTotal = 0;
  trigramBackfillProgressChunks = 0;
  inFlightRequests = 0;
  eventLoopLagSeconds = 0;
  stopEventLoopLagMonitor();
}

export function registerMetrics(app: FastifyInstance, serviceName = 'gateway'): void {
  startEventLoopLagMonitor();

  app.addHook('onRequest', async (request) => {
    recordRequestStart(request);
  });

  app.addHook('onResponse', async (request, reply) => {
    recordRequestEnd({
      request,
      method: request.method,
      route: readRoute(request),
      statusCode: reply.statusCode,
    });
  });

  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics(serviceName));
  });

  app.addHook('onClose', async () => {
    stopEventLoopLagMonitor();
  });
}
