#!/usr/bin/env bash
# OMK Release Guard — optional npm audit summary for release gates
set +e

if [ ! -f "package.json" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK npm audit summary: skipped because package.json is absent."}}'
  exit 0
fi

if [ "$OMK_RUN_NPM_AUDIT_SUMMARY" != "1" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK npm audit summary: not run automatically. For release/security claims, run npm audit or set OMK_RUN_NPM_AUDIT_SUMMARY=1 and capture the result."}}'
  exit 0
fi

if ! command -v npm &>/dev/null || ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK npm audit summary: skipped because npm or node is unavailable."}}'
  exit 0
fi

TMP="$(mktemp)"
npm audit --audit-level=high --omit=dev --json > "$TMP" 2>&1
STATUS=$?

node - "$TMP" "$STATUS" <<'NODE'
const fs = require('node:fs');
const filePath = process.argv[2];
const status = Number(process.argv[3] || 0);
let raw = '';
try {
  raw = fs.readFileSync(filePath, 'utf8');
} catch {}

let context;
try {
  const parsed = JSON.parse(raw);
  const total = parsed.metadata?.vulnerabilities?.total ?? 'unknown';
  const high = parsed.metadata?.vulnerabilities?.high ?? 'unknown';
  const critical = parsed.metadata?.vulnerabilities?.critical ?? 'unknown';
  context = status === 0
    ? 'OMK npm audit summary: passed for high+ prod dependencies. total=' + total + ', high=' + high + ', critical=' + critical + '.'
    : 'OMK npm audit summary: attention required. total=' + total + ', high=' + high + ', critical=' + critical + '. Inspect npm audit output before release.';
} catch {
  context = status === 0
    ? 'OMK npm audit summary: command completed but JSON could not be parsed.'
    : 'OMK npm audit summary: npm audit failed or returned non-JSON output; inspect command output before release.';
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    permissionDecision: 'allow',
    additionalContext: context,
  },
}) + '\n');
NODE
rm -f "$TMP"
