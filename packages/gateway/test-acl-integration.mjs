import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? 'http://localhost:6333',
  ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
});
const COLLECTION = 'wiki_chunks';

function makeVector(seed) {
  const v = new Array(768).fill(0).map((_, i) => Math.sin(seed + i * 0.1));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

const testDocs = [
  { id: 1, title: 'Правила офиса', groups: ['*'], text: 'В офисе запрещено курить. Рабочий день с 9 до 18.' },
  { id: 2, title: 'Архитектура API v2', groups: ['engineer'], text: 'Микросервисы построены на Fastify. База данных PostgreSQL.' },
  { id: 3, title: 'CI/CD Pipeline', groups: ['engineer'], text: 'GitLab CI запускает тесты на каждый merge request.' },
  { id: 4, title: 'Бюджет Q3 2024', groups: ['finance', 'management'], text: 'Капитальные расходы составили 15 млн. Операционные — 8 млн.' },
  { id: 5, title: 'План пентеста', groups: ['security'], text: 'Внешний аудит запланирован на ноябрь. Область сканирования: DMZ.' },
  { id: 6, title: 'Roadmap 2025', groups: ['engineer', 'finance', 'management'], text: 'В первом квартале запуск нового портала. Во втором — интеграция с ERP.' },
];

const points = testDocs.map((doc) => ({
  id: doc.id,
  vector: makeVector(doc.id),
  payload: {
    page_id: 1000 + doc.id,
    title: doc.title,
    namespace: 0,
    text: doc.text,
    allowed_groups: doc.groups,
    chunk_index: 0,
    total_chunks: 1,
    last_modified: '2024-01-01T00:00:00Z',
  }
}));

await qdrant.upsert(COLLECTION, { points });
console.log(`Inserted ${points.length} test documents`);

async function searchAs(userGroups, description) {
  const queryVec = makeVector(42);
  const results = await qdrant.search(COLLECTION, {
    vector: queryVec,
    limit: 10,
    filter: {
      must: [{
        key: 'allowed_groups',
        match: { any: [...userGroups, '*'] }
      }]
    },
    with_payload: true,
  });

  const titles = results.map(r => r.payload.title);
  console.log(`\n[${description}] groups=${JSON.stringify(userGroups)}:`);
  console.log('  Found:', titles.length > 0 ? titles.join(', ') : '(none)');
}

await searchAs(['user'], 'Обычный пользователь');
await searchAs(['user', 'engineer'], 'Инженер');
await searchAs(['user', 'finance'], 'Финансист');
await searchAs(['user', 'management'], 'Менеджер');
await searchAs(['user', 'security'], 'Security');
await searchAs(['user', 'engineer', 'management'], 'Инженер + Менеджер');

console.log('\n✅ ACL test completed');
