#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = new URL('..', import.meta.url);
const mcpAdapterPath = fileURLToPath(new URL('packages/mcp-adapter/src/server.mjs', repoRoot));
const runLive = process.env.RUN_WIKIAI_ENV_DEV === '1';
const runOpenSearch = process.env.RUN_OPENSEARCH_E2E === '1';
const runColbert = process.env.RUN_COLBERT_E2E === '1';
const runLlm = process.env.RUN_LLM_SMOKE === '1';
const runExternalApiMcp = process.env.RUN_EXTERNAL_API_MCP_E2E === '1';
const externalApiMcpAuthMode = process.env.RUN_EXTERNAL_API_MCP_AUTH_MODE || 'auto';
const keepExternalApiConfig = process.env.KEEP_EXTERNAL_API_CONFIG === '1';

const gatewayBaseUrl = envUrl('GATEWAY_BASE_URL', 'http://127.0.0.1:3000');
const syncerBaseUrl = envUrl('SYNCER_BASE_URL', 'http://127.0.0.1:3001');
const mwBaseUrl = envUrl('MW_BASE_URL', 'http://127.0.0.1:8082');
const qdrantUrl = envUrl('QDRANT_URL', 'http://127.0.0.1:6333');
const opensearchBaseUrl = envUrl('OPENSEARCH_BASE_URL', 'http://127.0.0.1:9200');
const colbertBaseUrl = envUrl('COLBERT_BASE_URL', 'http://127.0.0.1:8083');
const adminCookie = process.env.MW_TEST_COOKIE || process.env.WIKIAI_ADMIN_COOKIE || '';
const liveTimeoutMs = Number.parseInt(process.env.WIKIAI_ENV_DEV_TIMEOUT_MS || '8000', 10);
const gatewayContainer = process.env.WIKIAI_GATEWAY_CONTAINER || 'wikiai-gateway-1';
const externalAccessToken = process.env.WIKIAI_ACCESS_TOKEN || '';
const externalCookie = process.env.WIKIAI_COOKIE || adminCookie;
const externalConfigAdminCookie = process.env.WIKIAI_ADMIN_COOKIE || process.env.MW_TEST_COOKIE || process.env.WIKIAI_COOKIE || '';

if (!['auto', 'cookie', 'bearer', 'both'].includes(externalApiMcpAuthMode)) {
  throw new Error('RUN_EXTERNAL_API_MCP_AUTH_MODE must be one of: auto, cookie, bearer, both');
}

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

async function assertJsonRequest(label, url, init, validate, acceptedStatuses = [200]) {
  const { response, body } = await readJson(url, init);
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 160)}`);
  }
  validate(body, response);
  record(label, 'pass', `HTTP ${response.status}`);
}

async function assertJsonEndpoint(label, url, validate, acceptedStatuses = [200]) {
  await assertJsonRequest(label, url, {}, validate, acceptedStatuses);
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

function adminHeaders(cookie = adminCookie) {
  return cookie ? { Cookie: cookie } : {};
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

async function runExternalConfigAdminRequest(label, path, init = {}) {
  if (!externalConfigAdminCookie) {
    throw new Error(`${label} requires WIKIAI_ADMIN_COOKIE, MW_TEST_COOKIE, or an admin WIKIAI_COOKIE`);
  }
  const { response, body } = await readJson(`${gatewayBaseUrl}${path}`, {
    ...init,
    headers: {
      ...adminHeaders(externalConfigAdminCookie),
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

function bearerHeaders() {
  return {
    Authorization: `Bearer ${externalAccessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function cookieHeaders() {
  return {
    Cookie: externalCookie,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function encodeMcpMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

function parseNextMcpMessage(buffer) {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator < 0) return undefined;
  const header = buffer.subarray(0, separator).toString('utf8');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error(`Invalid MCP response header: ${header}`);
  const length = Number(match[1]);
  const bodyStart = separator + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return undefined;
  return {
    message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8')),
    remaining: buffer.subarray(bodyEnd),
  };
}

function startMcpProcess(env) {
  const child = spawn(process.execPath, [mcpAdapterPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuffer = Buffer.alloc(0);
  let stderrText = '';
  const pending = new Map();

  child.stderr.on('data', (chunk) => {
    stderrText += Buffer.from(chunk).toString('utf8');
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
    let parsed = parseNextMcpMessage(stdoutBuffer);
    while (parsed) {
      stdoutBuffer = parsed.remaining;
      const pendingRequest = pending.get(parsed.message.id);
      if (pendingRequest) {
        clearTimeout(pendingRequest.timeout);
        pending.delete(parsed.message.id);
        pendingRequest.resolve(parsed.message);
      }
      parsed = parseNextMcpMessage(stdoutBuffer);
    }
  });

  return {
    request(message) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(message.id);
          reject(new Error(`Timed out waiting for MCP response ${message.id}; stderr=${stderrText.slice(0, 240)}`));
        }, liveTimeoutMs);
        pending.set(message.id, { resolve, reject, timeout });
        child.stdin.write(encodeMcpMessage(message), (err) => {
          if (err) {
            clearTimeout(timeout);
            pending.delete(message.id);
            reject(err);
          }
        });
      });
    },
    async close() {
      for (const pendingRequest of pending.values()) {
        clearTimeout(pendingRequest.timeout);
      }
      pending.clear();
      if (child.exitCode !== null) return;
      child.kill();
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    },
  };
}

function assertMcpSuccess(message, label) {
  if (message.error) {
    throw new Error(`${label} returned MCP error: ${JSON.stringify(message.error)}`);
  }
  if (!message.result) {
    throw new Error(`${label} returned no MCP result`);
  }
  return message.result;
}

function externalApiLiveConfig(values) {
  const base = values && typeof values === 'object' ? values : {};
  return {
    ...base,
    enabled: true,
    mcpEnabled: true,
    anonymousSearchAllowed: false,
    aclMode: 'mediawiki_check',
  };
}

async function setupExternalApiMcpForLive() {
  const read = await runExternalConfigAdminRequest(
    'Gateway admin External API config read for live E2E',
    '/api/admin/external-api/config'
  );
  const originalValues = read.values;
  await runExternalConfigAdminRequest(
    'Gateway admin External API config setup for live E2E',
    '/api/admin/external-api/config',
    {
      method: 'POST',
      body: JSON.stringify(externalApiLiveConfig(originalValues)),
    }
  );

  return async () => {
    if (keepExternalApiConfig) {
      record('External API config restore', 'skip', 'KEEP_EXTERNAL_API_CONFIG=1');
      return;
    }
    await runExternalConfigAdminRequest(
      'Gateway admin External API config restore after live E2E',
      '/api/admin/external-api/config',
      {
        method: 'POST',
        body: JSON.stringify(originalValues),
      }
    );
  };
}

async function runMcpStdioLive(label, env) {
  const mcp = startMcpProcess(env);
  try {
    const initialize = assertMcpSuccess(
      await mcp.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      `${label} initialize`
    );
    if (initialize.serverInfo?.name !== 'wikiai-mcp-adapter') {
      throw new Error(`${label} initialize returned unexpected serverInfo`);
    }

    const tools = assertMcpSuccess(
      await mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      `${label} tools/list`
    );
    const toolNames = (tools.tools || []).map((tool) => tool.name);
    for (const expected of ['wikiai_capabilities', 'wikiai_search', 'wikiai_chat']) {
      if (!toolNames.includes(expected)) throw new Error(`${label} tools/list is missing ${expected}`);
    }

    const capabilities = assertMcpSuccess(
      await mcp.request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'wikiai_capabilities', arguments: {} },
      }),
      `${label} wikiai_capabilities`
    );
    if (!capabilities.content?.[0]?.text?.includes('"mcpEnabled"')) {
      throw new Error(`${label} capabilities did not return mcpEnabled`);
    }

    const search = assertMcpSuccess(
      await mcp.request({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'wikiai_search', arguments: { query: 'кухни', topK: 1, format: 'compact' } },
      }),
      `${label} wikiai_search`
    );
    if (!search.content?.[0]?.text?.includes('"results"')) {
      throw new Error(`${label} search did not return results`);
    }

    const chat = assertMcpSuccess(
      await mcp.request({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'wikiai_chat', arguments: { message: 'кухни', topK: 1 } },
      }),
      `${label} wikiai_chat`
    );
    if (!chat.content?.[0]?.text) {
      throw new Error(`${label} chat did not return text content`);
    }
    record(label, 'pass', 'stdio JSON-RPC');
  } finally {
    await mcp.close();
  }
}

function bearerBranchRequired() {
  return externalApiMcpAuthMode === 'bearer' || externalApiMcpAuthMode === 'both';
}

function cookieBranchRequired() {
  return externalApiMcpAuthMode === 'cookie' || externalApiMcpAuthMode === 'both';
}

function shouldRunBearerBranch(capabilities) {
  if (bearerBranchRequired()) {
    if (!externalAccessToken) throw new Error('missing_wikiai_access_token: set WIKIAI_ACCESS_TOKEN for Bearer live E2E');
    if (capabilities.oidcConfigured !== true) throw new Error('no_idp_or_oidc_config: Bearer live E2E requested but oidcConfigured=false');
    return true;
  }
  return externalApiMcpAuthMode === 'auto' && Boolean(externalAccessToken) && capabilities.oidcConfigured === true;
}

function shouldRunCookieBranch(capabilities, runBearer) {
  if (cookieBranchRequired()) return true;
  if (externalApiMcpAuthMode !== 'auto') return false;
  if (!runBearer) return true;
  return Boolean(externalCookie) && capabilities.oidcConfigured !== true;
}

function requireCookieForExternalE2e() {
  if (!externalCookie) {
    throw new Error('missing_wikiai_cookie: set WIKIAI_COOKIE, WIKIAI_ADMIN_COOKIE, or MW_TEST_COOKIE for cookie External API/MCP live E2E');
  }
}

async function runExternalApiMcpChecks() {
  if (!runExternalApiMcp) {
    record('External API / MCP live E2E', 'skip', 'set RUN_EXTERNAL_API_MCP_E2E=1');
    return;
  }

  let restoreExternalApiConfig = async () => undefined;
  if (externalConfigAdminCookie) {
    restoreExternalApiConfig = await setupExternalApiMcpForLive();
  } else {
    record('External API config setup for live E2E', 'skip', 'set WIKIAI_ADMIN_COOKIE, MW_TEST_COOKIE, or admin WIKIAI_COOKIE');
  }

  try {
    let capabilities;
    await assertJsonEndpoint('External API capabilities', `${gatewayBaseUrl}/api/v1/capabilities`, (body) => {
      if (body.searchEnabled !== true) throw new Error('External API search is not enabled');
      if (body.chatEnabled !== true) throw new Error('External API chat is not enabled');
      if (body.mcpEnabled !== true) throw new Error('External API MCP flag is not enabled');
      if (!Array.isArray(body.retrievalProfiles)) throw new Error('External API capabilities do not include retrievalProfiles');
      if (!Array.isArray(body.authModes) || !body.authModes.includes('cookie')) {
        throw new Error('External API capabilities do not allow cookie auth fallback');
      }
      capabilities = body;
    });

    const runBearer = shouldRunBearerBranch(capabilities);
    const runCookie = shouldRunCookieBranch(capabilities, runBearer);

    if (runBearer) {
      await assertJsonRequest('External API Bearer search', `${gatewayBaseUrl}/api/v1/search`, {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ query: 'кухни', topK: 1, format: 'compact' }),
      }, (body) => {
        if (!Array.isArray(body.results)) throw new Error('External API Bearer search did not return results');
        if (body.authMode !== 'oidc') throw new Error(`External API Bearer search returned authMode=${body.authMode}`);
      });
      await assertJsonRequest('External API Bearer chat', `${gatewayBaseUrl}/api/v1/chat`, {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ message: 'кухни', topK: 1, stream: false }),
      }, (body) => {
        if (typeof body.answer !== 'string') throw new Error('External API Bearer chat did not return answer');
      });
      await runMcpStdioLive('MCP adapter Bearer live', {
        WIKIAI_GATEWAY_URL: gatewayBaseUrl,
        WIKIAI_ACCESS_TOKEN: externalAccessToken,
        WIKIAI_COOKIE: '',
      });
    } else {
      record('External API / MCP Bearer live E2E', 'skip', 'no_idp_or_token; cookie fallback is the live auth path');
    }

    if (runCookie) {
      requireCookieForExternalE2e();
      await assertJsonRequest('External API cookie fallback search', `${gatewayBaseUrl}/api/v1/search`, {
        method: 'POST',
        headers: cookieHeaders(),
        body: JSON.stringify({ query: 'кухни', topK: 1, format: 'compact' }),
      }, (body) => {
        if (!Array.isArray(body.results)) throw new Error('External API cookie fallback search did not return results');
        if (body.authMode !== 'mediawiki_cookie') {
          throw new Error(`External API cookie fallback search returned authMode=${body.authMode}`);
        }
      });
      await assertJsonRequest('External API cookie fallback chat', `${gatewayBaseUrl}/api/v1/chat`, {
        method: 'POST',
        headers: cookieHeaders(),
        body: JSON.stringify({ message: 'кухни', topK: 1, stream: false }),
      }, (body) => {
        if (typeof body.answer !== 'string') throw new Error('External API cookie fallback chat did not return answer');
      });
      await runMcpStdioLive('MCP adapter cookie fallback live', {
        WIKIAI_GATEWAY_URL: gatewayBaseUrl,
        WIKIAI_ACCESS_TOKEN: '',
        WIKIAI_COOKIE: externalCookie,
      });
    } else {
      record('External API / MCP cookie fallback', 'skip', `RUN_EXTERNAL_API_MCP_AUTH_MODE=${externalApiMcpAuthMode}`);
    }
  } finally {
    await restoreExternalApiConfig();
  }
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
  await runExternalApiMcpChecks();

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
