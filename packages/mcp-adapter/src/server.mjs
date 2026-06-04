#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

let inputBuffer = Buffer.alloc(0);

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function requestGateway(path, method = 'GET', body) {
  const gatewayUrl = (process.env.WIKIAI_GATEWAY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const accessToken = process.env.WIKIAI_ACCESS_TOKEN || '';
  const cookie = process.env.WIKIAI_COOKIE || '';
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (cookie) headers.Cookie = cookie;
  headers['X-WikiAI-Client'] = 'mcp';

  const response = await fetch(`${gatewayUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return payload;
}

export function listTools() {
  return {
    tools: [
      {
        name: 'wikiai_capabilities',
        description: 'Read WikiAI external API capabilities.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'wikiai_search',
        description: 'Search the MediaWiki knowledge base through WikiAI Gateway.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            topK: { type: 'number', minimum: 1, maximum: 50 },
            format: { type: 'string', enum: ['compact', 'full'] },
            retrievalProfileId: { type: 'string', minLength: 1, maxLength: 120 },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'wikiai_chat',
        description: 'Ask WikiAI chat through the Gateway external API.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 1 },
            conversationId: { type: 'string' },
            topK: { type: 'number', minimum: 1, maximum: 50 },
            retrievalProfileId: { type: 'string', minLength: 1, maxLength: 120 },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    ],
  };
}

export async function callTool(name, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'wikiai_capabilities') {
    return toolResult(await requestGateway('/api/v1/capabilities'));
  }
  if (name === 'wikiai_search') {
    if (typeof input.query !== 'string' || input.query.trim() === '') {
      throw new Error('query is required');
    }
    return toolResult(await requestGateway('/api/v1/search', 'POST', {
      query: input.query,
      topK: typeof input.topK === 'number' ? input.topK : undefined,
      format: typeof input.format === 'string' ? input.format : undefined,
      retrievalProfileId: typeof input.retrievalProfileId === 'string' ? input.retrievalProfileId : undefined,
    }));
  }
  if (name === 'wikiai_chat') {
    if (typeof input.message !== 'string' || input.message.trim() === '') {
      throw new Error('message is required');
    }
    return toolResult(await requestGateway('/api/v1/chat', 'POST', {
      message: input.message,
      conversationId: typeof input.conversationId === 'string' ? input.conversationId : undefined,
      topK: typeof input.topK === 'number' ? input.topK : undefined,
      retrievalProfileId: typeof input.retrievalProfileId === 'string' ? input.retrievalProfileId : undefined,
      stream: false,
    }));
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleMessage(message) {
  const { id, method, params } = message || {};
  if (typeof method !== 'string') return;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'wikiai-mcp-adapter', version: '0.1.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      respond(id, listTools());
      return;
    }
    if (method === 'tools/call') {
      const name = params && typeof params.name === 'string' ? params.name : '';
      const args = params && params.arguments ? params.arguments : {};
      respond(id, await callTool(name, args));
      return;
    }
    if (!method.startsWith('notifications/')) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    respondError(id, -32000, err instanceof Error ? err.message : String(err));
  }
}

function readNextMessage() {
  const separator = inputBuffer.indexOf('\r\n\r\n');
  if (separator < 0) return undefined;
  const header = inputBuffer.subarray(0, separator).toString('utf8');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) {
    inputBuffer = inputBuffer.subarray(separator + 4);
    return undefined;
  }
  const length = Number(match[1]);
  const bodyStart = separator + 4;
  const bodyEnd = bodyStart + length;
  if (inputBuffer.length < bodyEnd) return undefined;

  const body = inputBuffer.subarray(bodyStart, bodyEnd).toString('utf8');
  inputBuffer = inputBuffer.subarray(bodyEnd);
  return JSON.parse(body);
}

export function startStdioServer() {
  process.stdin.on('data', (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    let message = readNextMessage();
    while (message !== undefined) {
      void handleMessage(message);
      message = readNextMessage();
    }
  });

  process.stdin.resume();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStdioServer();
}
