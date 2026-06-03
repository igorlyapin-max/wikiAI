import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_ADMIN_DOC_HOME,
  AI_ADMIN_DOC_PAGES,
  MANAGED_DOC_NOTICE,
} from './ai-admin-docs-fixtures.mjs';

test('AI admin documentation fixture has the expected managed pages', () => {
  assert.equal(AI_ADMIN_DOC_PAGES.length, 18);

  const titles = AI_ADMIN_DOC_PAGES.map((page) => page.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(titles[0], AI_ADMIN_DOC_HOME);
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/Обзор и состояние сервисов`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/LLM`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/Embeddings`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/RAG и Chunking`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/Индексация`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/FAQ и диагностика`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/Распознавание документов`));
  assert.ok(titles.includes(`${AI_ADMIN_DOC_HOME}/Логи администрирования`));
});

test('AI admin documentation pages clearly state overwrite policy', () => {
  for (const page of AI_ADMIN_DOC_PAGES) {
    assert.ok(page.text.startsWith(MANAGED_DOC_NOTICE), page.title);
    assert.match(page.text, /будет перезаписана при следующем развертывании/, page.title);
    assert.match(page.text, /\[\[Категория:WikiAI admin docs\]\]/, page.title);
  }
});

test('AI admin documentation home links all managed child pages', () => {
  const home = AI_ADMIN_DOC_PAGES.find((page) => page.title === AI_ADMIN_DOC_HOME);
  assert.ok(home);

  for (const page of AI_ADMIN_DOC_PAGES.slice(1)) {
    assert.ok(home.text.includes(`[[${page.title}|`), page.title);
  }
});
