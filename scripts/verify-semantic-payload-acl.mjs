#!/usr/bin/env node

const qdrantUrl = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
const collection = process.env.QDRANT_COLLECTION || 'wiki_chunks';
const namespaceAcl = JSON.parse(process.env.NAMESPACE_ACL || '{"3000":["*"],"3010":["ai-hr","ai-exec"],"3020":["ai-finance","ai-exec"],"3030":["ai-it","ai-exec"],"3040":["sysop","aiadmin","ai-exec"]}');
const outputJson = process.argv.includes('--json');

function normalizeGroups(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String))].sort();
}

function sameGroups(left, right) {
  const a = normalizeGroups(left);
  const b = normalizeGroups(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function scrollPoints(offset = undefined) {
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
    throw new Error(`Qdrant scroll failed: HTTP ${response.status}`);
  }
  return response.json();
}

const totals = {
  points: 0,
  semanticPoints: 0,
  semanticPages: new Set(),
  byNamespace: new Map(),
};
const errors = [];
let offset;

do {
  const data = await scrollPoints(offset);
  const points = data.result?.points ?? [];
  offset = data.result?.next_page_offset;

  for (const point of points) {
    totals.points++;
    const payload = point.payload ?? {};
    const facts = payload.semantic_facts;
    if (!facts || typeof facts !== 'object' || Object.keys(facts).length === 0) continue;

    totals.semanticPoints++;
    totals.semanticPages.add(payload.title);
    const namespace = String(payload.namespace);
    totals.byNamespace.set(namespace, (totals.byNamespace.get(namespace) ?? 0) + 1);

    const expected = namespaceAcl[namespace];
    if (!expected) {
      errors.push({
        title: payload.title,
        namespace: payload.namespace,
        issue: 'No namespace ACL rule for semantic payload',
      });
      continue;
    }

    if (!sameGroups(payload.allowed_groups, expected)) {
      errors.push({
        title: payload.title,
        namespace: payload.namespace,
        issue: 'allowed_groups does not match namespace ACL',
        actual: payload.allowed_groups,
        expected,
      });
    }
  }
} while (offset !== undefined && offset !== null);

const report = {
  qdrantUrl,
  collection,
  points: totals.points,
  semanticPoints: totals.semanticPoints,
  semanticPages: totals.semanticPages.size,
  semanticPointsByNamespace: Object.fromEntries([...totals.byNamespace.entries()].sort()),
  errors,
};

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Wiki AI semantic payload ACL verification');
  console.log(`- Qdrant: ${qdrantUrl}`);
  console.log(`- Collection: ${collection}`);
  console.log(`- Points scanned: ${report.points}`);
  console.log(`- Semantic points: ${report.semanticPoints}`);
  console.log(`- Semantic pages: ${report.semanticPages}`);
  console.log('- Semantic points by namespace:');
  for (const [namespace, count] of Object.entries(report.semanticPointsByNamespace)) {
    console.log(`  - ${namespace}: ${count}`);
  }
  if (errors.length > 0) {
    console.log('- Errors:');
    for (const error of errors) {
      console.log(`  - ${error.title}: ${error.issue}`);
    }
  } else {
    console.log('- Errors: none');
  }
}

if (errors.length > 0) {
  process.exitCode = 1;
}
