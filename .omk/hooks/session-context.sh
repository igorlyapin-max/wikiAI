#!/usr/bin/env bash
# OMK SessionStart Context — keeps high-value local workflows visible
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"OMK session started. Read project rules, use graph-view for memory relationships, use open-design for localhost design, and verify before final."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK session startup context.',
  '- Read AGENTS.md and .kimi/AGENTS.md before edits; read DESIGN.md before UI/frontend/visual work.',
  '- For local design iteration, use /open-design or omk design open-design --open to launch localhost.',
  '- For memory/risk/file relationships, use /graph-view or omk graph view --open before broad repo edits.',
  '- Treat release, push, publish, and deployment as not done unless the exact command ran and fresh evidence was collected.',
  '- Final reports should list changed files, commands run, pass/fail/not-run status, and remaining risk.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}) + '\n');
NODE
