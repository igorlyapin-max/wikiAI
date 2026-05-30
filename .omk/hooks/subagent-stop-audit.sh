#!/usr/bin/env bash
# OMK SubagentStop Audit — leader must verify delegated work
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":"Subagent finished. Leader must review changed files, integrate results, and run relevant quality gates before final."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK subagent completion audit.',
  '- Do not claim success from a subagent report alone.',
  '- Review the concrete files changed, reconcile conflicts, and keep unrelated user edits intact.',
  '- Run the relevant quality gates locally and report pass/fail/not-run evidence.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SubagentStop',
    additionalContext: context,
  },
}) + '\n');
NODE
