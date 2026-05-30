#!/usr/bin/env bash
# OMK PreCompact Checkpoint — compact without losing recovery state
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreCompact","additionalContext":"Before compaction: record goal, changed files, verification state, blockers, and next action. Never store secrets."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK pre-compaction checkpoint.',
  '- Preserve current goal, changed files, verification state, blockers, and intended next action.',
  '- If available, write concise notes to .omx/notepad.md or project-local memory; never store secrets.',
  '- After compaction, refresh from the checkpoint before editing or claiming completion.',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreCompact',
    additionalContext: context,
  },
}) + '\n');
NODE
