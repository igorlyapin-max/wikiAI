#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const repoRoot = new URL('..', import.meta.url);
const runLive = process.env.RUN_WIKIAI_ENV_DEV === '1';
const runOpenSearch = process.env.RUN_OPENSEARCH_E2E === '1';
const runColbert = process.env.RUN_COLBERT_E2E === '1';
const runLlm = process.env.RUN_LLM_SMOKE === '1';

const gatewayBaseUrl = envUrl('GATEWAY_BASE_URL', 'http://127.0.0.1:3000');
const syncerBaseUrl = envUrl('SYNCER_BASE_URL', 'http://127.0.0.1:3001');
const mwBaseUrl = envUrl('MW_BASE_URL', 'http://127.0.0.1:8082');
const qdrantUrl = envUrl('QDRANT_URL', 'http://127.0.0.1:6333');
const opensearchBaseUrl = envUrl('OPENSEARCH_BASE_URL', 'http://127.0.0.1:9200');
const colbertBaseUrl = envUrl('COLBERT_BASE_URL', 'http://127.0.0.1:8083');
const adminCookie = process.env.MW_TEST_COOKIE || process.env.WIKIAI_ADMIN_COOKIE || '';
const liveTimeoutMs = Number.parseInt(process.env.WIKIAI_ENV_DEV_TIMEOUT_MS || '8000', 10);
const gatewayContainer = process.env.WIKIAI_GATEWAY_CONTAINER || 'wikiai-gateway-1';

const gates = [
  ['Gateway coverage', 'npm', ['--prefix', 'packages/gateway', 'run', 'test:coverage']],
  ['Syncer coverage', 'npm', ['--prefix', 'packages/syncer', 'run', 'test:coverage']],
  ['AI admin coverage', 'npm', ['--prefix', 'packages/mw-extension/resources/ai-admin', 'run', 'test:coverage']],
  ['AI assistant coverage', 'npm', ['--prefix', 'packages/mw-extension/resources/ai-assistant', 'run', 'test:coverage']],
  ['Wiki UI coverage', 'npm', ['--prefix', 'packages/wiki-ui', 'run', 'test:coverage']],
  ['MCP adapter tests', 'npm', ['--prefix', 'packages/mcp-adapter', 'test']],
  ['Contract validation', 'node', ['scripts/validate-contracts.mjs']],
  ['Script fixture tests', 'node', ['--test', 'scripts/*.test.mjs']],
];

const summary = [];

function envUrl(name, fallback) {
  return (process.env[name] || fallback).replace(/\/$/, '');
}

function logStep(label) {
  console.log(`\n== ${label} ==`);
}

function record(label, status, detail = '') {
  summary.push({ label, status, detail });
  const suffix = detail ? `: ${detail}` : '';
  console.log(`[${status}] ${label}${suffix}`);
}

function runCommand(label, command, args) {
  logStep(label);
  const commandLine = [command, ...args].map(quoteShellArg).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', commandLine], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        record(label, 'pass');
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });
  });
}

function runCommandCapture(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });
}

function quoteShellArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value) || value.includes('*')) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), liveTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(url, init = {}) {
  const response = await fetchWithTimeout(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON from ${url}, got ${text.slice(0, 120)}`);
  }
  return { response, body };
}

async function assertJsonEndpoint(label, url, validate, acceptedStatuses = [200]) {
  const { response, body } = await readJson(url);
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  validate(body, response);
  record(label, 'pass', `HTTP ${response.status}`);
}

async function assertTextEndpoint(label, url, validate, acceptedStatuses = [200]) {
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  validate(text, response);
  record(label, 'pass', `HTTP ${response.status}`);
}

function mediaWikiApiUrl(params) {
  const url = new URL('/api.php', mwBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function resourceLoaderUrl(moduleName) {
  const url = new URL('/load.php', mwBaseUrl);
  url.searchParams.set('modules', moduleName);
  url.searchParams.set('only', 'scripts');
  url.searchParams.set('skin', 'vector');
  url.searchParams.set('debug', 'true');
  return url.toString();
}

function adminHeaders() {
  return adminCookie ? { Cookie: adminCookie } : {};
}

async function runQdrantRoundtrip() {
  const collection = `wikiai_env_dev_${Date.now()}`;
  const createBody = {
    vectors: { size: 4, distance: 'Cosine' },
  };
  try {
    let response = await fetchWithTimeout(`${qdrantUrl}/collections/${collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    if (!response.ok) throw new Error(`Qdrant create returned HTTP ${response.status}`);

    response = await fetchWithTimeout(`${qdrantUrl}/collections/${collection}/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [{
          id: 1,
          vector: [1, 0, 0, 0],
          payload: { title: 'WikiAI env-dev smoke', allowed_groups: ['*'] },
        }],
      }),
    });
    if (!response.ok) throw new Error(`Qdrant upsert returned HTTP ${response.status}`);

    response = await fetchWithTimeout(`${qdrantUrl}/collections/${collection}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: [1, 0, 0, 0], limit: 1, with_payload: true }),
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.result) || body.result.length !== 1) {
      throw new Error(`Qdrant search returned unexpected payload: ${JSON.stringify(body).slice(0, 160)}`);
    }
    record('Qdrant temporary collection roundtrip', 'pass', collection);
  } finally {
    await fetchWithTimeout(`${qdrantUrl}/collections/${collection}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

async function runAdminGatewayCheck(label, path, init = {}) {
  if (!adminCookie) {
    record(label, 'skip', 'set MW_TEST_COOKIE or WIKIAI_ADMIN_COOKIE for authenticated admin checks');
    return undefined;
  }
  const { response, body } = await readJson(`${gatewayBaseUrl}${path}`, {
    ...init,
    headers: {
      ...adminHeaders(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 160)}`);
  record(label, 'pass', `HTTP ${response.status}`);
  return body;
}

async function assertGatewayAdminRouteRegistered(label, path, init = {}) {
  const response = await fetchWithTimeout(`${gatewayBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (response.status === 404) {
    throw new Error(`${label} is not registered in the live Gateway. Rebuild/recreate gateway; response: ${text.slice(0, 160)}`);
  }
  if (response.status !== 401) {
    throw new Error(`${label} expected HTTP 401 without an admin cookie, got HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  record(label, 'pass', `HTTP ${response.status}; route registered`);
}

function assertGatewayRuntimeRetrievalLimits() {
  const label = 'Gateway runtime retrieval profile limits contract';
  if (!gatewayContainer || gatewayContainer.toLowerCase() === 'none') {
    record(label, 'skip', 'set WIKIAI_GATEWAY_CONTAINER to the live Gateway container name');
    return;
  }
  const inspect = runCommandCapture('docker', ['inspect', gatewayContainer]);
  if (inspect.status !== 0) {
    record(label, 'skip', `docker container ${gatewayContainer} is not available`);
    return;
  }

  const command = [
    'set -eu',
    'for marker in retrievalTopK contextTopK contextMaxChars maxContextChunks maxContextChars; do',
    '  grep -R "$marker" /app/dist/services/admin-platform-config.js /app/dist/services/prompt-context.js /app/dist/routes/admin.js >/dev/null || { echo "missing $marker"; exit 42; }',
    'done',
  ].join('\n');
  const result = runCommandCapture('docker', ['exec', gatewayContainer, 'sh', '-lc', command]);
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`${label} failed: live Gateway image is stale or missing retrieval limit schema markers. Rebuild/recreate gateway. ${output}`);
  }
  record(label, 'pass', gatewayContainer);
}

async function runLiveChecks() {
  logStep('WikiAI live dev checks');

  await assertJsonEndpoint('Gateway /live', `${gatewayBaseUrl}/live`, (body) => {
    if (body.status !== 'ok' || body.service !== 'gateway') throw new Error('Invalid Gateway /live shape');
  });
  await assertJsonEndpoint('Gateway /ready', `${gatewayBaseUrl}/ready`, (body) => {
    if (!body.status || !body.checks) throw new Error('Invalid Gateway /ready shape');
  }, [200, 503]);
  await assertJsonEndpoint('Gateway /health', `${gatewayBaseUrl}/health`, (body) => {
    if (!body.status || !body.checks) throw new Error('Invalid Gateway /health shape');
  }, [200, 503]);
  await assertTextEndpoint('Gateway /metrics', `${gatewayBaseUrl}/metrics`, (text) => {
    if (!text.includes('wikiai_http_requests_total')) throw new Error('Gateway metrics do not include wikiai_http_requests_total');
  });
  assertGatewayRuntimeRetrievalLimits();

  await assertJsonEndpoint('Syncer /live', `${syncerBaseUrl}/live`, (body) => {
    if (body.status !== 'ok' || body.service !== 'syncer') throw new Error('Invalid Syncer /live shape');
  });
  await assertJsonEndpoint('Syncer /ready', `${syncerBaseUrl}/ready`, (body) => {
    if (!body.status || !body.checks) throw new Error('Invalid Syncer /ready shape');
  }, [200, 503]);
  await assertJsonEndpoint('Syncer /health', `${syncerBaseUrl}/health`, (body) => {
    if (!body.status || !body.checks) throw new Error('Invalid Syncer /health shape');
  }, [200, 503]);
  await assertTextEndpoint('Syncer /metrics', `${syncerBaseUrl}/metrics`, (text) => {
    if (!text.includes('wikiai_http_requests_total')) throw new Error('Syncer metrics do not include wikiai_http_requests_total');
  });

  await assertJsonEndpoint('MediaWiki anonymous siteinfo', mediaWikiApiUrl({
    action: 'query',
    meta: 'siteinfo',
    format: 'json',
  }), (body) => {
    if (!body.query?.general) throw new Error('Invalid MediaWiki siteinfo shape');
  });

  await assertTextEndpoint('ResourceLoader ext.aiadmin bundle', resourceLoaderUrl('ext.aiadmin'), (text) => {
    for (const marker of [
      'aiadmin-opensearch-config',
      'aiadmin-save-opensearch-config',
      '/api/admin/opensearch/status',
      'aiadmin-mediawiki-profile-config',
      'mediawiki-default-retrieval-profile',
      'aiadmin-restore-mediawiki-retrieval-profiles',
      'retrieval-profile-retrieval-top-k',
      'retrieval-profile-context-top-k',
      'aiadmin-retrieval-profile-limits-marker',
      '/api/admin/mediawiki-profile/config',
      'opensearch_hybrid_colbert',
    ]) {
      if (!text.includes(marker)) throw new Error(`ext.aiadmin bundle is missing marker ${marker}`);
    }
  });
  await assertTextEndpoint('ResourceLoader ext.aiassistant bundle', resourceLoaderUrl('ext.aiassistant'), (text) => {
    if (!text.includes('/api/search') && !text.includes('/api/chat')) {
      throw new Error('ext.aiassistant bundle is missing assistant API markers');
    }
  });

  await assertGatewayAdminRouteRegistered('Gateway admin OpenSearch status route registration', '/api/admin/opensearch/status');
  await assertGatewayAdminRouteRegistered('Gateway admin OpenSearch analyze route registration', '/api/admin/opensearch/analyze', {
    method: 'POST',
    body: JSON.stringify({ query: 'как там цивилизации' }),
  });
  await assertGatewayAdminRouteRegistered('Gateway admin OpenSearch search-preview route registration', '/api/admin/opensearch/search-preview', {
    method: 'POST',
    body: JSON.stringify({ query: 'как там цивилизации', limit: 3 }),
  });
  await assertGatewayAdminRouteRegistered('Gateway admin MediaWiki profile route registration', '/api/admin/mediawiki-profile/config');

  if (adminCookie) {
    await assertJsonEndpoint('MediaWiki authenticated userinfo', mediaWikiApiUrl({
      action: 'query',
      meta: 'userinfo',
      uiprop: 'groups',
      format: 'json',
    }), (body) => {
      if (!body.query?.userinfo?.id) throw new Error('MediaWiki did not return an authenticated user');
      const groups = body.query.userinfo.groups || [];
      if (!groups.includes('sysop') && !groups.includes('aiadmin')) {
        throw new Error('MediaWiki user is authenticated but not sysop/aiadmin');
      }
    }, [200]);

    await assertTextEndpoint('MediaWiki Special:AIAdmin admin page', `${mwBaseUrl}/index.php/Special:AIAdmin?uselang=ru`, (text) => {
      for (const marker of [
        'data-ai-tab="opensearch"',
        'data-ai-panel="opensearch"',
        'data-ai-tab="bm25"',
        'data-ai-tab="colbert"',
        'data-ai-tab="composition"',
        'aiadmin-mediawiki-profile-config',
      ]) {
        if (!text.includes(marker)) throw new Error(`Special:AIAdmin is missing marker ${marker}`);
      }
    });

    await runAdminGatewayCheck('Gateway admin service-config', '/api/admin/service-config');
    await runAdminGatewayCheck('Gateway admin search-index status', '/api/admin/search-index/status');
    const mediaWikiProfile = await runAdminGatewayCheck('Gateway admin MediaWiki profile config', '/api/admin/mediawiki-profile/config');
    const profileIds = (mediaWikiProfile?.retrievalProfiles || []).map((profile) => profile.id);
    for (const expectedProfile of ['opensearch_hybrid', 'opensearch_hybrid_colbert']) {
      if (!profileIds.includes(expectedProfile)) {
        throw new Error(`Gateway admin MediaWiki profile config is missing ${expectedProfile}`);
      }
    }
  } else {
    record('Authenticated MediaWiki/admin UI checks', 'skip', 'set MW_TEST_COOKIE or WIKIAI_ADMIN_COOKIE');
  }

  await runQdrantRoundtrip();

  if (runOpenSearch) {
    await assertJsonEndpoint('OpenSearch root status', opensearchBaseUrl, (body) => {
      if (!body.version && !body.cluster_name) throw new Error('Invalid OpenSearch root status shape');
    });
    await runAdminGatewayCheck('Gateway admin OpenSearch status', '/api/admin/opensearch/status');
    await runAdminGatewayCheck('Gateway admin OpenSearch analyze', '/api/admin/opensearch/analyze', {
      method: 'POST',
      body: JSON.stringify({ query: 'как там цивилизации' }),
    });
    await runAdminGatewayCheck('Gateway admin OpenSearch search preview', '/api/admin/opensearch/search-preview', {
      method: 'POST',
      body: JSON.stringify({ query: 'как там цивилизации', limit: 3 }),
    });
  } else {
    record('OpenSearch live E2E', 'skip', 'set RUN_OPENSEARCH_E2E=1');
  }

  if (runColbert) {
    await assertJsonEndpoint('ColBERT /health', `${colbertBaseUrl}/health`, (body) => {
      if (body.status !== 'ok' || !body.model) throw new Error('Invalid ColBERT /health shape');
    });
    await runAdminGatewayCheck('Gateway admin search-index status with ColBERT readiness', '/api/admin/search-index/status');
  } else {
    record('ColBERT live E2E', 'skip', 'set RUN_COLBERT_E2E=1');
  }

  if (runLlm) {
    console.warn('RUN_LLM_SMOKE=1 is set, but paid/remote LLM smoke is intentionally not part of this env-dev gate.');
    record('LLM smoke', 'skip', 'run package-specific opt-in smoke after explicit cost approval');
  }
}

for (const [label, command, args] of gates) {
  await runCommand(label, command, args);
}

if (runLive) {
  await runLiveChecks();
} else {
  record('WikiAI live dev checks', 'skip', 'set RUN_WIKIAI_ENV_DEV=1');
}

console.log('\n== WikiAI env-dev summary ==');
for (const item of summary) {
  const suffix = item.detail ? ` - ${item.detail}` : '';
  console.log(`${item.status.toUpperCase()} ${item.label}${suffix}`);
}
