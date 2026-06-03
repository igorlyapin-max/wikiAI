#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const defaultExcludes = [':!.agents/**', ':!.kimi/**', ':!.omk/**', ':!package-lock.json'];

const scans = [
  {
    label: 'placeholder defaults',
    pattern: ['change', 'me-'].join(''),
    pathspec: ['.', ':!README.md', ':!docs/**', ...defaultExcludes],
  },
  {
    label: 'private key material',
    pattern: ['BE', 'GIN ', '.*', 'PRI', 'VATE KEY'].join(''),
    pathspec: ['.', ...defaultExcludes],
  },
  {
    label: 'AWS access keys',
    pattern: ['A', 'K', 'I', 'A', '[0-9A-Z]{16}'].join(''),
    pathspec: ['.', ...defaultExcludes],
  },
  {
    label: 'OpenAI-style API keys',
    pattern: ['s', 'k-', '[A-Za-z0-9_-]{20,}'].join(''),
    pathspec: ['.', ...defaultExcludes],
  },
  {
    label: 'Slack tokens',
    pattern: ['x', 'ox', '[baprs]-', '[A-Za-z0-9-]{20,}'].join(''),
    pathspec: ['.', ...defaultExcludes],
  },
];

const findings = [];

for (const scan of scans) {
  const result = spawnSync('git', ['grep', '-nE', scan.pattern, '--', ...scan.pathspec], {
    encoding: 'utf8',
  });

  if (result.status === 0) {
    findings.push(`## ${scan.label}\n${result.stdout.trim()}`);
    continue;
  }

  if (result.status !== 1) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

if (findings.length > 0) {
  console.error('Potential secrets or unsafe placeholders found:');
  console.error(findings.join('\n\n'));
  process.exit(1);
}

console.log('secret scan ok');
