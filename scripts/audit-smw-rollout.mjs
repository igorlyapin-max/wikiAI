#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const containerName = process.env.MW_CONTAINER || 'mediawiki';
const baseUrl = (process.env.MW_BASE_URL || 'http://127.0.0.1:8082').replace(/\/$/, '');
const outputJson = process.argv.includes('--json');

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      }).trim(),
      stderr: '',
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
      status: error.status,
    };
  }
}

function dockerExec(args) {
  return run('docker', ['exec', containerName, ...args]);
}

function extensionStatus(name) {
  const result = dockerExec([
    'sh',
    '-lc',
    `test -d /var/www/html/extensions/${name} && echo installed || echo missing`,
  ]);
  return result.ok && result.stdout === 'installed' ? 'installed' : 'missing';
}

function parseMounts(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function readSiteInfo() {
  const url = new URL(`${baseUrl}/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('meta', 'siteinfo');
  url.searchParams.set('siprop', 'general|extensions');
  url.searchParams.set('format', 'json');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WikiAI-SMWRolloutAudit/0.1',
      },
    });
    const text = await response.text();
    const data = JSON.parse(text);
    return {
      ok: response.ok && !data.error,
      status: response.status,
      data,
      error: data.error?.code,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const dockerPs = run('docker', ['ps', '--format', '{{.Names}}']);
const dockerAvailable = dockerPs.ok;
const containerRunning = dockerAvailable
  && dockerPs.stdout.split('\n').filter(Boolean).includes(containerName);

const phpVersion = containerRunning
  ? dockerExec(['php', '-r', 'echo PHP_VERSION;'])
  : { ok: false, stdout: '', stderr: 'container is not running' };

const composerPath = containerRunning
  ? dockerExec(['sh', '-lc', 'command -v composer || true'])
  : { ok: false, stdout: '', stderr: 'container is not running' };

const maintenanceRun = containerRunning
  ? dockerExec(['sh', '-lc', 'test -f /var/www/html/maintenance/run.php && echo present || echo missing'])
  : { ok: false, stdout: '', stderr: 'container is not running' };

const extensions = Object.fromEntries(
  ['VisualEditor', 'SemanticMediaWiki', 'PageForms', 'VEForAll', 'ParserFunctions']
    .map((name) => [name, containerRunning ? extensionStatus(name) : 'unknown']),
);

const inspect = run('docker', ['inspect', containerName, '--format', '{{json .Mounts}}']);
const mounts = inspect.ok ? parseMounts(inspect.stdout) : [];
const localSettingsMount = mounts.find((mount) => mount.Destination === '/var/www/html/LocalSettings.php');

const siteInfo = await readSiteInfo();
const siteGeneral = siteInfo.data?.query?.general || {};
const apiExtensions = siteInfo.data?.query?.extensions || [];

const warnings = [];
const blockers = [];

if (!containerRunning) {
  if (dockerAvailable) {
    blockers.push(`Docker container "${containerName}" is not running.`);
  } else {
    blockers.push(`Docker CLI is not available to this process: ${dockerPs.stderr || 'unknown error'}.`);
  }
}

if (!composerPath.stdout) {
  blockers.push('Composer is not available inside the MediaWiki container.');
}

if (!localSettingsMount) {
  warnings.push('LocalSettings.php mount was not detected by docker inspect.');
} else if (localSettingsMount.RW === false) {
  warnings.push(`LocalSettings.php is mounted read-only from ${localSettingsMount.Source}.`);
}

if (extensions.VisualEditor !== 'installed') {
  warnings.push('VisualEditor extension directory is missing; VEForAll depends on VisualEditor behavior.');
}

for (const required of ['SemanticMediaWiki', 'PageForms', 'VEForAll']) {
  if (extensions[required] !== 'installed') {
    warnings.push(`${required} extension directory is not installed yet.`);
  }
}

if (!siteInfo.ok) {
  warnings.push(`MediaWiki API is not reachable at ${baseUrl}/api.php: ${siteInfo.error || 'unknown error'}.`);
}

const report = {
  checkedAt: new Date().toISOString(),
  container: {
    name: containerName,
    dockerAvailable,
    running: containerRunning,
  },
  mediaWiki: {
    baseUrl,
    apiReachable: siteInfo.ok,
    apiVersion: siteGeneral.generator || null,
    phpVersion: phpVersion.ok ? phpVersion.stdout : null,
    composerPath: composerPath.stdout || null,
    maintenanceRun: maintenanceRun.stdout || null,
    apiExtensions: apiExtensions
      .map((extension) => ({
        name: extension.name,
        version: extension.version || null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  },
  filesystem: {
    localSettingsMount: localSettingsMount ? {
      source: localSettingsMount.Source,
      destination: localSettingsMount.Destination,
      readWrite: localSettingsMount.RW,
    } : null,
  },
  extensions,
  blockers,
  warnings,
  nextSteps: [],
};

const missingExtensions = ['SemanticMediaWiki', 'PageForms', 'VEForAll']
  .filter((name) => report.extensions[name] !== 'installed');

if (!report.mediaWiki.composerPath) {
  report.nextSteps.push('Install Composer or run Composer from a reproducible build/disposable container.');
}

if (missingExtensions.length) {
  report.nextSteps.push(`Install missing extension directories: ${missingExtensions.join(', ')}.`);
} else {
  report.nextSteps.push('Extension directories are present; verify API extension versions and maintenance status.');
}

if (report.mediaWiki.apiReachable) {
  const apiExtensionNames = new Set(report.mediaWiki.apiExtensions.map((extension) => extension.name));
  const missingApiExtensions = ['SemanticMediaWiki', 'PageForms', 'VEForAll']
    .filter((name) => !apiExtensionNames.has(name));
  if (missingApiExtensions.length) {
    report.nextSteps.push(`Enable missing extensions in LocalSettings.php: ${missingApiExtensions.join(', ')}.`);
  } else {
    report.nextSteps.push('SMW/PageForms/VEForAll are visible through MediaWiki API.');
  }
} else {
  report.nextSteps.push('Fix MediaWiki API before acceptance; it must return clean JSON.');
}

report.nextSteps.push('Run SMW rebuildData for semantic pages and corporate ACL live verification.');
report.nextSteps.push('Run AI reindex with service MW_SYNC_COOKIE before semantic facts are used by Gateway.');

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Wiki AI SMW rollout audit');
  console.log(`- Container: ${report.container.name} (${report.container.running ? 'running' : 'not running'})`);
  console.log(`- MediaWiki API: ${report.mediaWiki.apiReachable ? 'reachable' : 'not reachable'} at ${baseUrl}`);
  console.log(`- MediaWiki: ${report.mediaWiki.apiVersion || 'unknown'}`);
  console.log(`- PHP: ${report.mediaWiki.phpVersion || 'unknown'}`);
  console.log(`- Composer: ${report.mediaWiki.composerPath || 'missing'}`);
  console.log(`- maintenance/run.php: ${report.mediaWiki.maintenanceRun || 'unknown'}`);
  console.log('- Extension directories:');
  for (const [name, status] of Object.entries(report.extensions)) {
    console.log(`  - ${name}: ${status}`);
  }
  if (report.mediaWiki.apiExtensions.length) {
    console.log('- API extensions:');
    for (const extension of report.mediaWiki.apiExtensions) {
      if (['VisualEditor', 'SemanticMediaWiki', 'PageForms', 'VEForAll', 'AIAssistant'].includes(extension.name)) {
        console.log(`  - ${extension.name}: ${extension.version || 'version not reported'}`);
      }
    }
  }

  if (report.filesystem.localSettingsMount) {
    const mount = report.filesystem.localSettingsMount;
    console.log(`- LocalSettings.php: ${mount.source} -> ${mount.destination} (${mount.readWrite ? 'rw' : 'ro'})`);
  }

  if (report.blockers.length) {
    console.log('- Blockers:');
    for (const blocker of report.blockers) {
      console.log(`  - ${blocker}`);
    }
  }

  if (report.warnings.length) {
    console.log('- Warnings:');
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  console.log('- Recommended next steps:');
  for (const step of report.nextSteps) {
    console.log(`  - ${step}`);
  }
}
