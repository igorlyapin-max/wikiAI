import Redis from 'ioredis';
import { QdrantClient } from '@qdrant/js-client-rest';

if (process.env.RUN_LIVE_INTEGRATION !== '1') {
  console.log('Skipping live integration smoke; set RUN_LIVE_INTEGRATION=1 to run it.');
  process.exit(0);
}

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:16379/1';
const qdrantUrl = process.env.QDRANT_URL ?? 'http://localhost:6333';
const ollamaUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const ollamaModel = process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text';
const gatewayUrl = process.env.GATEWAY_BASE_URL ?? 'http://localhost:3000';
const mwBaseUrl = process.env.MW_BASE_URL ?? 'http://localhost:8082';
const mwApiPath = process.env.MW_API_PATH ?? '/api.php';
const runId = `wiki_ai_test_${Date.now()}`;

function makeVector(seed) {
  const vector = new Array(768).fill(0).map((_, index) => Math.sin(seed + index * 0.1));
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

async function checkRedis() {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await redis.set(`${runId}:ping`, 'ok', 'EX', 60);
    const value = await redis.get(`${runId}:ping`);
    if (value !== 'ok') throw new Error('Redis roundtrip mismatch');
    console.log('Redis: ok');
  } finally {
    await redis.del(`${runId}:ping`).catch(() => undefined);
    redis.disconnect();
  }
}

async function checkQdrant() {
  const qdrant = new QdrantClient({ url: qdrantUrl });
  const collection = runId;
  try {
    await qdrant.createCollection(collection, {
      vectors: { size: 768, distance: 'Cosine' },
    });
    await qdrant.upsert(collection, {
      points: [{
        id: 1,
        vector: makeVector(1),
        payload: { allowed_groups: ['*'], title: 'Integration smoke' },
      }],
    });
    const result = await qdrant.search(collection, {
      vector: makeVector(1),
      limit: 1,
      with_payload: true,
    });
    if (result.length !== 1) throw new Error('Qdrant search returned no points');
    console.log('Qdrant: ok');
  } finally {
    await qdrant.deleteCollection(collection).catch(() => undefined);
  }
}

async function checkOllama() {
  const res = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, prompt: 'integration smoke' }),
  });
  if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
    throw new Error('Ollama returned empty embedding');
  }
  console.log('Ollama: ok');
}

async function checkGateway() {
  const res = await fetch(`${gatewayUrl}/health`);
  if (!res.ok && res.status !== 503) throw new Error(`Gateway health failed: ${res.status}`);
  const data = await res.json();
  if (!data.status || !data.checks) throw new Error('Gateway health shape is invalid');
  console.log(`Gateway: ${data.status}`);
}

async function checkMediaWikiIfConfigured() {
  const cookie = process.env.MW_TEST_COOKIE;
  if (!cookie) {
    console.log('MediaWiki: skipped; set MW_TEST_COOKIE for authenticated userinfo smoke.');
    return;
  }
  const url = new URL(mwApiPath, mwBaseUrl);
  url.searchParams.set('action', 'query');
  url.searchParams.set('meta', 'userinfo');
  url.searchParams.set('uiprop', 'groups');
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`MediaWiki userinfo failed: ${res.status}`);
  const data = await res.json();
  if (!data.query?.userinfo?.id) throw new Error('MediaWiki did not return an authenticated user');
  console.log('MediaWiki: ok');
}

await checkRedis();
await checkQdrant();
await checkOllama();
await checkGateway();
await checkMediaWikiIfConfigured();
console.log('Local live integration smoke completed.');
