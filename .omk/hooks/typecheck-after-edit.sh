#!/usr/bin/env bash
# TypeScript product preset: run project typecheck after TS edits when available.
set +e

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

case "$FILEPATH" in
  *.ts|*.tsx|*.mts|*.cts) ;;
  *) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'; exit 0 ;;
esac

if [ ! -f "package.json" ] || ! command -v npm &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.check ? 0 : 1)" >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

TMP=$(mktemp)
npm run check >"$TMP" 2>&1
STATUS=$?
if [ $STATUS -eq 0 ]; then
  rm -f "$TMP"
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

tail -n 40 "$TMP" | $PY -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow","additionalContext":"Typecheck failed after edit. Inspect npm run check output:\n"+sys.stdin.read()}}))'
rm -f "$TMP"
