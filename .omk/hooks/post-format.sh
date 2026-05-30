#!/usr/bin/env bash
# Auto-format after save (single file target)
set -e

if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

INPUT=$(cat)
FILEPATH=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))')

if [ -z "$FILEPATH" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Detect project root and run formatter (target file only)
if [ -f "package.json" ] && [ -f "$FILEPATH" ]; then
  npx prettier --write "$FILEPATH" >/dev/null 2>&1 || true
fi

if [ -f "Cargo.toml" ] && [ -f "$FILEPATH" ]; then
  rustfmt "$FILEPATH" >/dev/null 2>&1 || true
fi

echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
