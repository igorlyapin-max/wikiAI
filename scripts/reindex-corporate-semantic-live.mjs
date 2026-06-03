#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MediaWikiApiClient } from './mediawiki-api-client.mjs';

const container = process.env.MW_CONTAINER || 'mediawiki';
const baseUrl = process.env.MW_BASE_URL || 'http://127.0.0.1:8082';
const serviceUser = process.env.MW_SYNC_SERVICE_USER || 'wiki_sync_service';
const namespaceAcl = process.env.NAMESPACE_ACL || '{"3000":["*"],"3010":["ai-hr","ai-exec"],"3020":["ai-finance","ai-exec"],"3030":["ai-it","ai-exec"],"3040":["sysop","aiadmin","ai-exec"]}';
const enableAttachments = process.env.ENABLE_ATTACHMENTS || 'false';

function dockerExec(args) {
  return execFileSync('docker', ['exec', container, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createServiceUser(password) {
  dockerExec([
    'php',
    '/var/www/html/maintenance/run.php',
    'createAndPromote',
    '--force',
    '--bot',
    '--custom-groups',
    'ai-exec',
    '--reason',
    'WikiAI live semantic reindex service account',
    serviceUser,
    password,
  ]);
}

async function getServiceCookie(password) {
  const client = new MediaWikiApiClient(baseUrl);
  await client.login(serviceUser, password);
  const cookie = client.cookieHeader();
  if (!cookie) {
    throw new Error('MediaWiki login succeeded but no session cookie was captured');
  }
  return cookie;
}

const password = `${randomBytes(24).toString('base64url')}A1!`;

console.log(`Preparing MediaWiki sync service user: ${serviceUser}`);
createServiceUser(password);

console.log('Opening MediaWiki service session in memory');
const cookie = await getServiceCookie(password);

console.log('Running corporate semantic reindex without OpenAI');
const result = spawnSync('npm', ['--prefix', 'packages/syncer', 'run', 'reindex'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    MW_BASE_URL: baseUrl,
    MW_API_PATH: process.env.MW_API_PATH || '/api.php',
    MW_SYNC_COOKIE: cookie,
    NAMESPACE_ACL: namespaceAcl,
    SMW_SYNC_ENABLED: process.env.SMW_SYNC_ENABLED || 'true',
    ENABLE_ATTACHMENTS: enableAttachments,
    QDRANT_URL: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || 'wiki_chunks',
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
  },
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
