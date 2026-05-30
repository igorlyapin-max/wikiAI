#!/usr/bin/env bash
# Final verification on Stop
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"Before final: list changed files, commands run, passed, failed, not run, and remaining risk. Do not claim deploy/publish unless verified."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK final response checklist.',
  '- Changed files: list authored files and note any ignored local runtime files refreshed.',
  '- Commands run: include exact verification commands and pass/fail/not-run status.',
  '- Deployment status: do not claim push, release, npm publish, or production deploy unless that command actually ran and evidence was read.',
  '- Remaining risk: state known gaps instead of saying complete without evidence.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    permissionDecision: 'allow',
    additionalContext: context,
  },
}) + '\n');
NODE
