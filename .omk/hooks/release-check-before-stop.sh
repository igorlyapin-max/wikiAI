#!/usr/bin/env bash
# OMK Release Guard — final checklist reminder for release/security work
set +e

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK release guard: verify secret scan, security review, quality gate, changelog/PR evidence, and do not publish/deploy without exact command evidence."}}'
  exit 0
fi

node <<'NODE'
const { execSync } = require('node:child_process');

function shell(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

const changed = [
  shell('git diff --name-only HEAD 2>/dev/null'),
  shell('git diff --cached --name-only 2>/dev/null'),
  shell('git ls-files --others --exclude-standard 2>/dev/null'),
].filter(Boolean).join('\n');

const releaseTouched = /(^|\n)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md|SECURITY\.md|\.npmrc|\.github\/workflows\/release\.ya?ml)(\n|$)/.test(changed);
const context = releaseTouched
  ? 'OMK release guard: release/security files changed. Before final or publish, collect secret scan, security review, quality gate, npm audit summary, changelog/PR evidence, and do not publish/deploy without explicit user request.'
  : 'OMK release guard: no release file changes detected. Still do not claim push, release, npm publish, or production deploy without exact command evidence.';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    permissionDecision: 'allow',
    additionalContext: context,
  },
}) + '\n');
NODE
