#!/usr/bin/env node
import {
  CORPORATE_GROUPS,
  CORPORATE_NAMESPACES,
  CORPORATE_USERS,
  buildCorporatePages,
  getNamespaceAcl,
} from './corporate-content-fixtures.mjs';
import { MediaWikiApiClient, MediaWikiApiError } from './mediawiki-api-client.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipUsers = args.has('--skip-users');
const skipPages = args.has('--skip-pages');

const mwBaseUrl = process.env.MW_BASE_URL ?? 'http://localhost:8082';
const pages = buildCorporatePages();

if (args.has('--help')) {
  printHelp();
  process.exit(0);
}

if (dryRun) {
  printSummary();
  process.exit(0);
}

const adminUser = requiredEnv('MW_ADMIN_USER');
const adminPassword = requiredEnv('MW_ADMIN_PASSWORD');
const seedPassword = requiredEnv('MW_SEED_PASSWORD');

try {
  const client = new MediaWikiApiClient(mwBaseUrl);
  await client.login(adminUser, adminPassword);
  await assertMediaWikiConfigured(client);

  if (!skipUsers) {
    await seedUsers(client, seedPassword);
  }
  if (!skipPages) {
    await seedPages(client);
  }

  console.log('Corporate wiki seed completed.');
  console.log(`Pages ensured: ${skipPages ? 0 : pages.length}`);
  console.log(`Users ensured: ${skipUsers ? 0 : CORPORATE_USERS.length}`);
  console.log(`Set syncer NAMESPACE_ACL to: ${JSON.stringify(getNamespaceAcl())}`);
} catch (err) {
  if (err instanceof MediaWikiApiError) {
    console.error(err.message);
    if (err.details?.info) {
      console.error(err.details.info);
    }
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env ${name}. Use --dry-run to inspect the fixture without credentials.`);
  }
  return value;
}

function printSummary() {
  const departmentPages = pages.filter((page) => !page.title.startsWith('CorpCommon:')).length;
  const commonPages = pages.length - departmentPages;

  console.log('Corporate wiki seed dry run');
  console.log(`MediaWiki: ${mwBaseUrl}`);
  console.log(`Namespaces: ${CORPORATE_NAMESPACES.map((namespace) => namespace.name).join(', ')}`);
  console.log(`Groups: ${CORPORATE_GROUPS.join(', ')}`);
  console.log(`Users: ${CORPORATE_USERS.map((user) => user.username).join(', ')}`);
  console.log(`Pages: ${pages.length} total, ${departmentPages} department, ${commonPages} common`);
  console.log(`NAMESPACE_ACL: ${JSON.stringify(getNamespaceAcl())}`);
}

function printHelp() {
  console.log(`Usage:
  MW_ADMIN_USER=... MW_ADMIN_PASSWORD=... MW_SEED_PASSWORD=... node scripts/seed-corporate-wiki.mjs

Options:
  --dry-run     Print fixture summary without connecting to MediaWiki.
  --skip-users  Do not create users or assign groups.
  --skip-pages  Do not create or update pages.

Required MediaWiki config:
  Include packages/mw-extension/config/corporate-test-settings.php from LocalSettings.php.
`);
}

async function assertMediaWikiConfigured(client) {
  const data = await client.siteInfo();
  const namespaces = new Set(
    Object.values(data?.query?.namespaces ?? {})
      .map((namespace) => namespace?.['*'])
      .filter(Boolean)
  );
  const groups = new Set(
    (data?.query?.usergroups ?? [])
      .map((group) => group?.name)
      .filter(Boolean)
  );

  const missingNamespaces = CORPORATE_NAMESPACES
    .map((namespace) => namespace.name)
    .filter((name) => !namespaces.has(name));
  const missingGroups = CORPORATE_GROUPS.filter((group) => !groups.has(group));

  if (missingNamespaces.length > 0 || missingGroups.length > 0) {
    throw new Error(
      [
        'MediaWiki corporate test config is not loaded.',
        missingNamespaces.length > 0 ? `Missing namespaces: ${missingNamespaces.join(', ')}` : '',
        missingGroups.length > 0 ? `Missing groups: ${missingGroups.join(', ')}` : '',
        'Include packages/mw-extension/config/corporate-test-settings.php after wfLoadExtension(\'AIAssistant\').',
      ].filter(Boolean).join('\n')
    );
  }
}

async function seedUsers(client, password) {
  for (const user of CORPORATE_USERS) {
    const createResult = await client.createAccount({
      username: user.username,
      password,
      email: user.email,
      realName: user.realName,
    });
    const groupResult = await client.addUserGroups(user.username, user.groups);
    const createdText = createResult.created ? 'created' : 'exists';
    const groupsText = groupResult.changed ? `groups added: ${groupResult.added.join(', ')}` : 'groups already set';
    console.log(`[USER] ${user.username}: ${createdText}, ${groupsText}`);
  }
}

async function seedPages(client) {
  for (const page of pages) {
    await client.editPage(page.title, page.text, 'WikiAI corporate test seed');
    console.log(`[PAGE] ${page.title}`);
  }
}
