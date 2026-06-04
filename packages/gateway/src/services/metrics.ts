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

const requestStarts = new WeakMap<object, bigint>();
const requestMetrics = new Map<string, RequestMetricValue>();
const processStartTimeSeconds = Date.now() / 1000;
let inFlightRequests = 0;
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

function metricKey(input: RequestMetricKey): string {
  return `${input.method} ${input.route} ${input.statusCode}`;
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
  trigramQueryCounts.clear();
  trigramBackfillJobCounts.clear();
  trigramLastLatencyMs = 0;
  trigramRawCandidatesTotal = 0;
  trigramBackfillProgressChunks = 0;
  inFlightRequests = 0;
}

export function registerMetrics(app: FastifyInstance, serviceName = 'gateway'): void {
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
}
