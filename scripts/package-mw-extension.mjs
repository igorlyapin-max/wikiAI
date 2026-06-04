#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const extensionRoot = path.join(repoRoot, 'packages', 'mw-extension');
const frontendRoot = path.join(extensionRoot, 'resources', 'ai-assistant');
const adminFrontendRoot = path.join(extensionRoot, 'resources', 'ai-admin');
const skipBuild = process.argv.includes('--skip-build');
const outputDirArg = readOption('--output-dir');
const outputDir = path.resolve(outputDirArg || process.env.MW_EXTENSION_ARTIFACT_DIR || path.join(repoRoot, 'dist'));

function readOption(name) {
  const prefixed = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);

  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];

  return undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function requirePath(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required extension artifact path: ${filePath}`);
  }
}

function assertContains(filePath, needle) {
  const content = readFileSync(filePath, 'utf8');
  if (!content.includes(needle)) {
    throw new Error(`Expected ${filePath} to contain ${needle}`);
  }
}

const extensionJsonPath = path.join(extensionRoot, 'extension.json');
const extensionJson = JSON.parse(readFileSync(extensionJsonPath, 'utf8'));
const version = extensionJson.version || '0.0.0';
const outputPath = path.join(outputDir, `wiki-ai-aiassistant-extension-${version}.tar.gz`);

if (!skipBuild) {
  run('npm', ['--prefix', frontendRoot, 'ci']);
  run('npm', ['--prefix', frontendRoot, 'run', 'build']);
  run('npm', ['--prefix', adminFrontendRoot, 'ci']);
  run('npm', ['--prefix', adminFrontendRoot, 'run', 'build']);
}

const requiredPaths = [
  'extension.json',
  'AIAssistant.alias.php',
  'src',
  'i18n',
  'config',
  'resources/ai-assistant/dist',
  'resources/ai-admin/dist',
];

for (const relativePath of requiredPaths) {
  requirePath(path.join(extensionRoot, relativePath));
}

assertContains(path.join(extensionRoot, 'src', 'SpecialAIAdmin.php'), 'data-ai-panel="retrieval-profiles"');
assertContains(path.join(extensionRoot, 'src', 'SpecialAIAdmin.php'), 'data-ai-panel="opensearch"');
assertContains(path.join(extensionRoot, 'i18n', 'ru.json'), 'aiadmin-section-colbert-index');
assertContains(path.join(extensionRoot, 'i18n', 'ru.json'), 'aiadmin-tab-retrieval-profiles');
assertContains(path.join(extensionRoot, 'i18n', 'ru.json'), 'aiadmin-tab-opensearch');
requirePath(path.join(frontendRoot, 'dist', 'index.js'));
requirePath(path.join(adminFrontendRoot, 'dist', 'index.js'));
assertContains(path.join(adminFrontendRoot, 'dist', 'index.js'), 'rag-colbertBaseUrl');
assertContains(path.join(adminFrontendRoot, 'dist', 'index.js'), 'colbert_full');
assertContains(path.join(adminFrontendRoot, 'dist', 'index.js'), 'aiadmin-retrieval-profiles');
assertContains(path.join(adminFrontendRoot, 'dist', 'index.js'), 'aiadmin-opensearch-config');
assertContains(path.join(adminFrontendRoot, 'dist', 'index.js'), 'svc-opensearch-enabled');
assertContains(path.join(adminFrontendRoot, 'dist', 'index.js'), '/api/admin/opensearch/status');

mkdirSync(outputDir, { recursive: true });

const stagingRoot = mkdtempSync(path.join(tmpdir(), 'wiki-ai-mw-extension-'));
const stagedExtensionRoot = path.join(stagingRoot, 'AIAssistant');

try {
  mkdirSync(stagedExtensionRoot, { recursive: true });
  for (const relativePath of ['extension.json', 'AIAssistant.alias.php', 'src', 'i18n', 'config']) {
    cpSync(path.join(extensionRoot, relativePath), path.join(stagedExtensionRoot, relativePath), {
      recursive: true,
    });
  }

  const stagedFrontendRoot = path.join(stagedExtensionRoot, 'resources', 'ai-assistant');
  mkdirSync(stagedFrontendRoot, { recursive: true });
  cpSync(path.join(frontendRoot, 'dist'), path.join(stagedFrontendRoot, 'dist'), {
    recursive: true,
  });
  const stagedAdminFrontendRoot = path.join(stagedExtensionRoot, 'resources', 'ai-admin');
  mkdirSync(stagedAdminFrontendRoot, { recursive: true });
  cpSync(path.join(adminFrontendRoot, 'dist'), path.join(stagedAdminFrontendRoot, 'dist'), {
    recursive: true,
  });

  run('tar', ['-C', stagingRoot, '-czf', outputPath, 'AIAssistant']);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

console.log(`MediaWiki extension artifact: ${outputPath}`);
