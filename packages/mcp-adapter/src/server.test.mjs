import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

function parseMessages(buffer) {
  const messages = [];
  let remaining = buffer;
  while (true) {
    const separator = remaining.indexOf('\r\n\r\n');
    if (separator < 0) break;
    const header = remaining.slice(0, separator);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = separator + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    messages.push(JSON.parse(remaining.slice(bodyStart, bodyEnd)));
    remaining = remaining.slice(bodyEnd);
  }
  return messages;
}

function waitForMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response. stdout=${buffer}`));
    }, 3000);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`MCP adapter exited with code ${code}`));
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      for (const message of parseMessages(buffer)) {
        if (predicate(message)) {
          cleanup();
          resolve(message);
          return;
        }
      }
    }

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function withAdapter(env, fn) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    return await fn(child);
  } finally {
    child.kill('SIGTERM');
  }
}

test('lists WikiAI MCP tools', async () => {
  await withAdapter({}, async (child) => {
    child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const response = await waitForMessage(child, (message) => message.id === 1);

    assert.deepEqual(response.result.tools.map((tool) => tool.name), [
      'wikiai_capabilities',
      'wikiai_search',
      'wikiai_chat',
    ]);
  });
});

test('forwards Gateway requests with cookie and bearer headers', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ req, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'CorpIT:VPN' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    await withAdapter({
      WIKIAI_GATEWAY_URL: `http://127.0.0.1:${port}`,
      WIKIAI_ACCESS_TOKEN: 'token-1',
      WIKIAI_COOKIE: 'mw=1',
    }, async (child) => {
      child.stdin.write(encodeMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'wikiai_search',
          arguments: { query: 'vpn', topK: 3, format: 'compact' },
        },
      }));
      const response = await waitForMessage(child, (message) => message.id === 2);

      assert.equal(response.result.content[0].type, 'text');
      assert.match(response.result.content[0].text, /CorpIT:VPN/);
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].req.method, 'POST');
    assert.equal(requests[0].req.url, '/api/v1/search');
    assert.equal(requests[0].req.headers.authorization, 'Bearer token-1');
    assert.equal(requests[0].req.headers.cookie, 'mw=1');
    assert.deepEqual(JSON.parse(requests[0].body), {
      query: 'vpn',
      topK: 3,
      format: 'compact',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns MCP errors for invalid tool input', async () => {
  await withAdapter({}, async (child) => {
    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wikiai_search', arguments: {} },
    }));
    const response = await waitForMessage(child, (message) => message.id === 3);

    assert.equal(response.error.code, -32000);
    assert.equal(response.error.message, 'query is required');
  });
});
