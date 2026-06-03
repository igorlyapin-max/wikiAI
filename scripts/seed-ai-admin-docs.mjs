#!/usr/bin/env node
import {
  AI_ADMIN_DOC_NAMESPACE,
  AI_ADMIN_DOC_PAGES,
  LEGACY_AI_ADMIN_DOC_PAGES,
} from './ai-admin-docs-fixtures.mjs';
import { MediaWikiApiClient, MediaWikiApiError } from './mediawiki-api-client.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const mwBaseUrl = process.env.MW_BASE_URL ?? 'http://localhost:8082';

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

try {
  const client = new MediaWikiApiClient(mwBaseUrl);
  await client.login(adminUser, adminPassword);
  await assertNamespaceConfigured(client);

  for (const page of AI_ADMIN_DOC_PAGES) {
    await client.editPage(page.title, page.text, 'WikiAI AI admin docs seed');
    console.log(`[DOC] updated ${page.title}`);
  }
  for (const page of LEGACY_AI_ADMIN_DOC_PAGES) {
    await client.editPage(page.title, page.text, 'WikiAI AI admin docs legacy cleanup');
    console.log(`[DOC] legacy stub ${page.title}`);
  }

  console.log('AI admin documentation seed completed.');
  console.log(`Pages overwritten: ${AI_ADMIN_DOC_PAGES.length}`);
  console.log(`Legacy public pages stubbed: ${LEGACY_AI_ADMIN_DOC_PAGES.length}`);
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
    throw new Error(`Missing required env ${name}. Use --dry-run to inspect pages without credentials.`);
  }
  return value;
}

async function assertNamespaceConfigured(client) {
  const data = await client.siteInfo();
  const namespaces = new Set(
    Object.values(data?.query?.namespaces ?? {})
      .map((namespace) => namespace?.['*'])
      .filter(Boolean)
  );

  if (!namespaces.has(AI_ADMIN_DOC_NAMESPACE)) {
    throw new Error(
      [
        `MediaWiki namespace ${AI_ADMIN_DOC_NAMESPACE} is not configured.`,
        'Include packages/mw-extension/config/corporate-test-settings.php after wfLoadExtension(\'AIAssistant\').',
      ].join('\n')
    );
  }
}

function printSummary() {
  console.log('AI admin documentation seed dry run');
  console.log(`MediaWiki: ${mwBaseUrl}`);
  console.log('Update policy: overwrite managed pages on every deployment seed run.');
  console.log(`Protected pages: ${AI_ADMIN_DOC_PAGES.length}`);
  for (const page of AI_ADMIN_DOC_PAGES) {
    console.log(`[DOC] ${page.title}`);
  }
  console.log(`Legacy public pages to stub: ${LEGACY_AI_ADMIN_DOC_PAGES.length}`);
  for (const page of LEGACY_AI_ADMIN_DOC_PAGES) {
    console.log(`[LEGACY] ${page.title}`);
  }
}

function printHelp() {
  console.log(`Usage:
  MW_BASE_URL=http://localhost:8082 \\
  MW_ADMIN_USER=Admin \\
  MW_ADMIN_PASSWORD=... \\
  node scripts/seed-ai-admin-docs.mjs

Options:
  --dry-run  Print managed documentation pages without connecting to MediaWiki.

Behavior:
  The script overwrites all managed AI admin documentation pages on every run.
  New documentation is written to the protected ${AI_ADMIN_DOC_NAMESPACE} namespace.
  Legacy CorpCommon admin documentation pages are replaced with safe stubs.
  Each generated page starts with a warning about automatic overwrite.
`);
}
