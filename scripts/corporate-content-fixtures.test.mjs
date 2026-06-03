import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORPORATE_DEPARTMENTS,
  CORPORATE_GROUPS,
  CORPORATE_PAGE_ACL_RULES,
  CORPORATE_USERS,
  buildCorporatePages,
  getNamespaceAcl,
} from './corporate-content-fixtures.mjs';

test('corporate fixture has the expected department structure', () => {
  assert.equal(CORPORATE_DEPARTMENTS.length, 3);
  for (const department of CORPORATE_DEPARTMENTS) {
    assert.equal(department.sections.length, 3, department.department);
    for (const section of department.sections) {
      assert.ok(section.docs.length >= 3, `${department.department}/${section.name} has too few docs`);
      assert.ok(section.docs.length <= 4, `${department.department}/${section.name} has too many docs`);
    }
  }
});

test('corporate fixture pages are unique and sufficiently broad', () => {
  const pages = buildCorporatePages();
  const titles = pages.map((page) => page.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.ok(pages.length >= 40);
  assert.ok(titles.includes('CorpCommon:Приказы/Классификация корпоративной информации'));
  assert.ok(titles.includes('CorpIT:Информационная безопасность/Ротация секретов администрирования'));
});

test('corporate ACL rules reference existing pages and groups', () => {
  const pageTitles = new Set(buildCorporatePages().map((page) => page.title));
  for (const rule of CORPORATE_PAGE_ACL_RULES) {
    assert.ok(pageTitles.has(rule.title), rule.title);
    assert.ok(rule.groups.length > 0, rule.title);
    for (const group of rule.groups) {
      assert.ok(CORPORATE_GROUPS.includes(group), `${rule.title}: ${group}`);
    }
  }
});

test('corporate users and namespace ACL use known groups', () => {
  const groups = new Set(CORPORATE_GROUPS);
  for (const user of CORPORATE_USERS) {
    assert.ok(user.groups.length > 0, user.username);
    for (const group of user.groups) {
      assert.ok(groups.has(group), `${user.username}: ${group}`);
    }
  }

  const namespaceAcl = getNamespaceAcl();
  assert.deepEqual(namespaceAcl['0'], ['*']);
  assert.deepEqual(namespaceAcl['3000'], ['*']);
  for (const allowedGroups of Object.values(namespaceAcl)) {
    for (const group of allowedGroups) {
      assert.ok(group === '*' || groups.has(group), group);
    }
  }
});

test('page-level ACL rules are narrower than department namespace ACL', () => {
  for (const rule of CORPORATE_PAGE_ACL_RULES) {
    assert.deepEqual(rule.groups, ['ai-exec'], rule.title);
  }
});
