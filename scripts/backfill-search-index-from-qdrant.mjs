#!/usr/bin/env node

const qdrantUrl = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const collection = process.env.QDRANT_COLLECTION || 'wiki_chunks';
const gatewayBaseUrl = (process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const adminToken = process.env.SYNCER_ADMIN_TOKEN || '';
const dryRun = process.argv.includes('--dry-run');
const requestDelayMs = Number(process.env.SEARCH_INDEX_BACKFILL_DELAY_MS || '250');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPositiveInteger(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function asNonNegativeInteger(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  ));
}

async function scrollQdrantPoints() {
  const points = [];
  let offset;

  do {
    const response = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 100,
        offset,
        with_payload: true,
        with_vector: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Qdrant scroll failed: HTTP ${response.status} ${await response.text()}`);
    }

    const body = await response.json();
    const result = body.result || {};
    points.push(...(Array.isArray(result.points) ? result.points : []));
    offset = result.next_page_offset;
  } while (offset !== undefined && offset !== null);

  return points;
}

function groupPoints(points) {
  const byPage = new Map();

  for (const point of points) {
    const payload = point.payload || {};
    const pageId = asPositiveInteger(payload.page_id);
    const id = asPositiveInteger(point.id);
    const title = asString(payload.title);
    const text = asString(payload.text);
    const namespace = asNonNegativeInteger(payload.namespace);
    if (!pageId || !id || !title || !text || namespace === undefined) continue;

    const pageGroups = byPage.get(pageId) || new Map();
    const sourceType = asString(payload.source_type) || 'page';
    const attachmentFilename = asString(payload.attachment_filename);
    const groupKey = [
      namespace,
      title,
      sourceType,
      attachmentFilename,
    ].join('\u001f');

    const group = pageGroups.get(groupKey) || {
      pageId,
      title,
      namespace,
      sourceType,
      attachmentFilename,
      allowedGroups: asStringArray(payload.allowed_groups),
      lastModified: asString(payload.last_modified) || undefined,
      chunks: [],
    };

    group.chunks.push({
      id,
      text,
      chunkIndex: asNonNegativeInteger(payload.chunk_index) ?? group.chunks.length,
      totalChunks: asPositiveInteger(payload.total_chunks) ?? 1,
      sourceType,
      attachmentFilename: attachmentFilename || undefined,
    });
    pageGroups.set(groupKey, group);
    byPage.set(pageId, pageGroups);
  }

  return Array.from(byPage.values()).map((pageGroups) => (
    Array.from(pageGroups.values()).sort((a, b) => {
      if (a.sourceType === b.sourceType) return a.namespace - b.namespace;
      return a.sourceType === 'page' ? -1 : 1;
    })
  ));
}

async function sendGroup(group, replacePage) {
  if (dryRun) return { status: 'dry-run', chunks: group.chunks.length };

  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['x-wikiai-admin-token'] = adminToken;
  const requestBody = JSON.stringify({
    pageId: group.pageId,
    title: group.title,
    namespace: group.namespace,
    allowedGroups: group.allowedGroups,
    lastModified: group.lastModified,
    replacePage,
    chunks: group.chunks,
  });

  let response;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(`${gatewayBaseUrl}/api/internal/search-index/page`, {
      method: 'POST',
      headers,
      body: requestBody,
    });
    if (response.status !== 429) break;
    const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
    await response.text().catch(() => undefined);
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000);
  }

  if (!response) {
    throw new Error(`Gateway search-index failed for page ${group.pageId}: no response`);
  }
  if (!response.ok) {
    throw new Error(`Gateway search-index failed for page ${group.pageId}: HTTP ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return body.values || { status: 'ok', chunks: group.chunks.length };
}

const points = await scrollQdrantPoints();
const pages = groupPoints(points);
let chunks = 0;
let groups = 0;

for (const pageGroups of pages) {
  for (let index = 0; index < pageGroups.length; index++) {
    const result = await sendGroup(pageGroups[index], index === 0);
    chunks += result.chunks || pageGroups[index].chunks.length;
    groups++;
    if (!dryRun && requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }
  }
}

console.log(JSON.stringify({
  status: dryRun ? 'dry-run' : 'ok',
  qdrantPoints: points.length,
  pages: pages.length,
  groups,
  chunks,
}));
