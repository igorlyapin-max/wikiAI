#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assertIncludes(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label} must include ${needle}`);
}

function assertPathContract(openApi, pathName, method) {
  const pathPattern = new RegExp(`^  ${pathName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm');
  assert.ok(pathPattern.test(openApi), `Gateway OpenAPI must document ${pathName}`);
  const pathIndex = openApi.search(pathPattern);
  const nextPathIndex = openApi.slice(pathIndex + 1).search(/^  \//m);
  const block = nextPathIndex >= 0
    ? openApi.slice(pathIndex, pathIndex + 1 + nextPathIndex)
    : openApi.slice(pathIndex);
  assertIncludes(block, `    ${method}:`, `${pathName} contract`);
}

const gatewayOpenApi = read('docs/contracts/gateway-openapi.yaml');
assertIncludes(gatewayOpenApi, 'openapi: 3.0.3', 'Gateway OpenAPI');
for (const [pathName, method] of [
  ['/live', 'get'],
  ['/ready', 'get'],
  ['/health', 'get'],
  ['/metrics', 'get'],
  ['/api/v1/capabilities', 'get'],
  ['/api/v1/search', 'post'],
  ['/api/v1/chat', 'post'],
]) {
  assertPathContract(gatewayOpenApi, pathName, method);
}
assertIncludes(gatewayOpenApi, 'text/plain:', '/metrics contract');

const webhookSchema = readJson('docs/contracts/syncer-webhook.schema.json');
assert.equal(webhookSchema.type, 'object');
assert.deepEqual(webhookSchema.required, ['event', 'page_id', 'namespace', 'timestamp']);
assert.deepEqual(webhookSchema.anyOf, [{ required: ['title'] }, { required: ['new_title'] }]);
for (const eventName of ['edit', 'delete', 'move', 'protect', 'page_save', 'page_delete', 'page_move', 'page_protect']) {
  assert.ok(webhookSchema.properties.event.enum.includes(eventName), `Webhook schema must allow ${eventName}`);
}

const mcpContract = read('docs/contracts/mcp-adapter.md');
const mcpAdapterSource = read('packages/mcp-adapter/src/server.mjs');
const documentedTools = [...mcpContract.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]).sort();
const implementedTools = [...mcpAdapterSource.matchAll(/name: '(wikiai_[^']+)'/g)].map((match) => match[1]).sort();
assert.deepEqual(implementedTools, ['wikiai_capabilities', 'wikiai_chat', 'wikiai_search']);
assert.deepEqual(documentedTools, implementedTools);
for (const gatewayPath of ['/api/v1/capabilities', '/api/v1/search', '/api/v1/chat']) {
  assertIncludes(mcpContract, gatewayPath, 'MCP contract');
  assertIncludes(mcpAdapterSource, gatewayPath, 'MCP adapter source');
}

console.log('contract validation ok');
