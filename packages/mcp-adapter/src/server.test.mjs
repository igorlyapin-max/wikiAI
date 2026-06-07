import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { callTool, handleMessage, listTools } from './server.mjs';

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

function parseNextJsonRpcMessage(buffer) {
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

async function captureJsonRpcResponse(message) {
  let stdoutBuffer = Buffer.alloc(0);
  const originalWrite = process.stdout.write;
  process.stdout.write = function writeForTest(chunk, encoding, callback) {
    const data = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    await handleMessage(message);
  } finally {
    process.stdout.write = originalWrite;
  }

  const parsed = parseNextJsonRpcMessage(stdoutBuffer);
  if (!parsed) throw new Error('MCP handler did not write a framed JSON-RPC response');
  assert.equal(parsed.remaining.length, 0);
  return parsed.message;
}

function installMockGatewayFetch({ gatewayFailure = false } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    const record = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body,
    };
    requests.push(record);
    if (gatewayFailure) {
      return new Response(JSON.stringify({ error: 'retrieval_profile_not_ready' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let payload;
    if (record.method === 'GET' && parsedUrl.pathname.endsWith('/api/v1/capabilities')) {
      payload = { searchEnabled: true, chatEnabled: true, mcpEnabled: true, received: record };
    } else if (record.method === 'POST' && parsedUrl.pathname.endsWith('/api/v1/search')) {
      payload = { results: [{ title: 'CorpIT:VPN' }], received: record };
    } else if (record.method === 'POST' && parsedUrl.pathname.endsWith('/api/v1/chat')) {
      payload = { answer: 'Use MFA.', sources: [{ title: 'CorpIT:VPN' }], received: record };
    } else {
      return new Response(JSON.stringify({ error: 'not_found', received: record }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return requests;
}

function assertJsonRpcSuccess(message, label) {
  if (message.error) {
    throw new Error(`${label} returned MCP error: ${JSON.stringify(message.error)}`);
  }
  if (!message.result) {
    throw new Error(`${label} returned no MCP result`);
  }
  return message.result;
}

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

test('serves MCP tools through stdio JSON-RPC and forwards Gateway requests', async () => {
  process.env.WIKIAI_GATEWAY_URL = 'http://gateway.example/base/';
  process.env.WIKIAI_ACCESS_TOKEN = 'token-1';
  process.env.WIKIAI_COOKIE = 'mw=1';
  installMockGatewayFetch();

  const initialize = assertJsonRpcSuccess(
    await captureJsonRpcResponse({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    'initialize'
  );
  assert.equal(initialize.protocolVersion, '2024-11-05');
  assert.equal(initialize.serverInfo.name, 'wikiai-mcp-adapter');

  const tools = assertJsonRpcSuccess(
    await captureJsonRpcResponse({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    'tools/list'
  );
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'wikiai_capabilities',
    'wikiai_search',
    'wikiai_chat',
  ]);

  const capabilities = assertJsonRpcSuccess(
    await captureJsonRpcResponse({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wikiai_capabilities', arguments: {} },
    }),
    'wikiai_capabilities'
  );
  assert.match(capabilities.content[0].text, /"mcpEnabled": true/);
  const capabilitiesPayload = JSON.parse(capabilities.content[0].text);

  const search = assertJsonRpcSuccess(
    await captureJsonRpcResponse({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'wikiai_search',
        arguments: {
          query: 'vpn',
          topK: 3,
          format: 'compact',
          retrievalProfileId: 'prod_hybrid_colbert',
        },
      },
    }),
    'wikiai_search'
  );
  assert.match(search.content[0].text, /CorpIT:VPN/);
  const searchPayload = JSON.parse(search.content[0].text);

  const chat = assertJsonRpcSuccess(
    await captureJsonRpcResponse({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'wikiai_chat',
        arguments: {
          message: 'How do I connect VPN?',
          conversationId: 'conv-1',
          topK: 4,
          retrievalProfileId: 'prod_hybrid_colbert',
        },
      },
    }),
    'wikiai_chat'
  );
  assert.match(chat.content[0].text, /Use MFA/);
  const chatPayload = JSON.parse(chat.content[0].text);

  assert.equal(capabilitiesPayload.received.url, 'http://gateway.example/base/api/v1/capabilities');
  assert.equal(searchPayload.received.url, 'http://gateway.example/base/api/v1/search');
  assert.equal(chatPayload.received.url, 'http://gateway.example/base/api/v1/chat');
  for (const payload of [capabilitiesPayload, searchPayload, chatPayload]) {
    assert.equal(payload.received.headers.Authorization, 'Bearer token-1');
    assert.equal(payload.received.headers.Cookie, 'mw=1');
    assert.equal(payload.received.headers['X-WikiAI-Client'], 'mcp');
  }
  assert.deepEqual(searchPayload.received.body, {
    query: 'vpn',
    topK: 3,
    format: 'compact',
    retrievalProfileId: 'prod_hybrid_colbert',
  });
  assert.deepEqual(chatPayload.received.body, {
    message: 'How do I connect VPN?',
    conversationId: 'conv-1',
    topK: 4,
    retrievalProfileId: 'prod_hybrid_colbert',
    stream: false,
  });
});

test('returns JSON-RPC errors for unknown methods, unknown tools and Gateway non-2xx responses', async () => {
  process.env.WIKIAI_GATEWAY_URL = 'http://gateway.example';
  installMockGatewayFetch({ gatewayFailure: true });

  const unknownMethod = await captureJsonRpcResponse({ jsonrpc: '2.0', id: 10, method: 'bad/method' });
  assert.deepEqual(unknownMethod.error, {
    code: -32601,
    message: 'Method not found: bad/method',
  });

  const unknownTool = await captureJsonRpcResponse({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'wikiai_missing', arguments: {} },
  });
  assert.equal(unknownTool.error.code, -32000);
  assert.match(unknownTool.error.message, /Unknown tool: wikiai_missing/);

  const gatewayFailure = await captureJsonRpcResponse({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'wikiai_search', arguments: { query: 'vpn' } },
  });
  assert.equal(gatewayFailure.error.code, -32000);
  assert.equal(gatewayFailure.error.message, 'retrieval_profile_not_ready');
});
