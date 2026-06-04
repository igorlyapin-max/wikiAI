import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { callTool, listTools } from './server.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = {
  WIKIAI_GATEWAY_URL: process.env.WIKIAI_GATEWAY_URL,
  WIKIAI_ACCESS_TOKEN: process.env.WIKIAI_ACCESS_TOKEN,
  WIKIAI_COOKIE: process.env.WIKIAI_COOKIE,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('lists WikiAI MCP tools', () => {
  assert.deepEqual(listTools().tools.map((tool) => tool.name), [
    'wikiai_capabilities',
    'wikiai_search',
    'wikiai_chat',
  ]);
});

test('forwards Gateway requests with cookie and bearer headers', async () => {
  const requests = [];
  process.env.WIKIAI_GATEWAY_URL = 'http://gateway.example/base/';
  process.env.WIKIAI_ACCESS_TOKEN = 'token-1';
  process.env.WIKIAI_COOKIE = 'mw=1';
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ results: [{ title: 'CorpIT:VPN' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const response = await callTool('wikiai_search', {
    query: 'vpn',
    topK: 3,
    format: 'compact',
    retrievalProfileId: 'prod_hybrid_colbert',
  });

  assert.equal(response.content[0].type, 'text');
  assert.match(response.content[0].text, /CorpIT:VPN/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://gateway.example/base/api/v1/search');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer token-1');
  assert.equal(requests[0].init.headers.Cookie, 'mw=1');
  assert.equal(requests[0].init.headers['X-WikiAI-Client'], 'mcp');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    query: 'vpn',
    topK: 3,
    format: 'compact',
    retrievalProfileId: 'prod_hybrid_colbert',
  });
});

test('returns MCP errors for invalid tool input', async () => {
  await assert.rejects(
    () => callTool('wikiai_search', {}),
    /query is required/
  );
});
