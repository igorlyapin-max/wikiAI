import fs from 'node:fs';
import process from 'node:process';

const DEFAULT_MAX_QUERIES = 200;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_P95_THRESHOLD_MS = 200;

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function percentile(values, rank) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function sqliteFilename(databaseUrl) {
  if (!databaseUrl?.startsWith('sqlite://')) return undefined;
  const raw = databaseUrl.slice('sqlite://'.length);
  if (!raw || raw === ':memory:') return undefined;
  return raw;
}

function fileSize(path) {
  if (!path) return undefined;
  try {
    return fs.statSync(path).size;
  } catch {
    return undefined;
  }
}

function readQueries(fileName, limit) {
  const source = fs.readFileSync(fileName, 'utf8').trim();
  if (!source) return [];
  if (source.startsWith('[')) {
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) throw new Error('--queries JSON file must contain an array');
    return parsed
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && typeof item.query === 'string') return item.query.trim();
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text.trim();
        return '';
      })
      .filter(Boolean)
      .slice(0, limit);
  }
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${data.message ?? data.error ?? response.statusText}`);
  }
  return data;
}

async function waitForBackfill(baseUrl, cookie, pollMs, timeoutMs) {
  const startedAt = Date.now();
  while (true) {
    const data = await requestJson(baseUrl, '/api/admin/search-index/trigram/backfill/status', { cookie });
    const status = data.values;
    if (!status || status.status === 'completed' || status.status === 'failed' || status.status === 'canceled') {
      return {
        status,
        durationMs: Date.now() - startedAt,
      };
    }
    if (Date.now() - startedAt > timeoutMs) {
      return {
        status,
        durationMs: Date.now() - startedAt,
        timedOut: true,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function buildReadiness(input) {
  const reasons = [];
  if (input.queriesCount === 0) reasons.push('No benchmark queries were provided');
  if (!input.trigramPopulated || input.coverage < 1) {
    reasons.push(`Trigram coverage is below 100%: ${input.trigramChunks}/${input.chunks} chunks, ${input.trigramFtsChunks}/${input.chunks} FTS rows`);
  }
  if (input.failedQueries > 0) reasons.push(`${input.failedQueries} benchmark queries failed`);
  if (input.p95LatencyMs > input.p95ThresholdMs) {
    reasons.push(`Trigram p95 latency ${input.p95LatencyMs} ms is above ${input.p95ThresholdMs} ms`);
  }
  if (input.backfillRequired && input.backfillStatus !== 'completed') {
    reasons.push(`Backfill did not complete successfully: ${input.backfillStatus ?? 'missing status'}`);
  }
  if (input.backfillTimedOut) reasons.push('Backfill polling timed out');
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

const baseUrl = readArg('--base-url', process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const cookie = readArg('--cookie', process.env.WIKIAI_ADMIN_COOKIE ?? process.env.WIKIAI_COOKIE ?? '');
const queryFile = readArg('--queries', undefined);
const maxQueries = readNumberArg('--max-queries', DEFAULT_MAX_QUERIES);
const pollMs = readNumberArg('--poll-ms', DEFAULT_POLL_MS);
const timeoutMs = readNumberArg('--timeout-ms', DEFAULT_TIMEOUT_MS);
const p95ThresholdMs = readNumberArg('--p95-threshold-ms', DEFAULT_P95_THRESHOLD_MS);
const databaseUrl = readArg('--database-url', process.env.DATABASE_URL ?? '');
const dbPath = sqliteFilename(databaseUrl);
const dbSizeBefore = fileSize(dbPath);

if (!queryFile) {
  console.error('Usage: node scripts/benchmark-trigram-readiness.mjs --queries queries.txt [--start-backfill] [--poll-ms 1000] [--p95-threshold-ms 200]');
  process.exit(1);
}

let backfill;
if (hasArg('--start-backfill')) {
  await requestJson(baseUrl, '/api/admin/search-index/trigram/backfill', {
    method: 'POST',
    cookie,
  });
  backfill = await waitForBackfill(baseUrl, cookie, pollMs, timeoutMs);
}

const statusResponse = await requestJson(baseUrl, '/api/admin/search-index/status', { cookie });
const status = statusResponse.values ?? {};
const chunks = Number(status.chunks ?? 0);
const trigramChunks = Number(status.trigramChunks ?? 0);
const trigramFtsChunks = Number(status.trigramFtsChunks ?? 0);
const coverage = chunks > 0 ? Math.min(trigramChunks, trigramFtsChunks) / chunks : 0;
const queries = readQueries(queryFile, maxQueries);

const queryResults = [];
const latencies = [];
let failedQueries = 0;
let rawCandidates = 0;

for (const query of queries) {
  try {
    const data = await requestJson(baseUrl, '/api/search', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ query, topK: 5 }),
    });
    const diagnostics = data.diagnostics ?? {};
    const latency = Number(diagnostics.trigramLatencyMs ?? 0);
    latencies.push(latency);
    rawCandidates += Number(diagnostics.trigramRawCandidates ?? 0);
    queryResults.push({
      query,
      latencyMs: latency,
      trigramFallbackUsed: Boolean(diagnostics.trigramFallbackUsed),
      trigramSkippedReason: diagnostics.trigramSkippedReason,
      trigramRawCandidates: Number(diagnostics.trigramRawCandidates ?? 0),
    });
  } catch (err) {
    failedQueries += 1;
    queryResults.push({
      query,
      error: err instanceof Error ? err.message : 'Unknown query error',
    });
  }
}

const p95 = percentile(latencies, 95);
const readiness = buildReadiness({
  chunks,
  trigramChunks,
  trigramFtsChunks,
  coverage,
  trigramPopulated: Boolean(status.trigramPopulated),
  queriesCount: queries.length,
  failedQueries,
  p95LatencyMs: p95,
  p95ThresholdMs,
  backfillRequired: hasArg('--start-backfill'),
  backfillStatus: backfill?.status?.status,
  backfillTimedOut: Boolean(backfill?.timedOut),
});
const report = {
  status: {
    chunks,
    trigramChunks,
    trigramFtsChunks,
    coverage,
    trigramPopulated: Boolean(status.trigramPopulated),
  },
  backfill,
  database: {
    path: dbPath,
    sizeBeforeBytes: dbSizeBefore,
    sizeAfterBytes: fileSize(dbPath),
  },
  queries: {
    count: queries.length,
    failed: failedQueries,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: p95,
    p99LatencyMs: percentile(latencies, 99),
    p95ThresholdMs,
    rawCandidates,
  },
  readiness,
  pass: readiness.passed,
  samples: queryResults.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));
if (!readiness.passed) process.exitCode = 2;
