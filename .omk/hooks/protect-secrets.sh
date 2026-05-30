#!/usr/bin/env bash
# Secret/environment variable protection
set -e

# Close security gate if jq/python3 is missing (deny by default)
if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"python3 not installed — protect-secrets cannot validate files"}}'
  exit 0
fi

INPUT=$(cat)
OMK_HOOK_INPUT="$INPUT" "$PY" - <<'PY'
import json
import os
import re

def respond(decision, reason=None):
    payload = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision}}
    if reason:
        payload["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(payload, separators=(",", ":")))

try:
    data = json.loads(os.environ.get("OMK_HOOK_INPUT", "{}") or "{}")
except Exception:
    respond("deny", "Invalid hook input")
    raise SystemExit(0)

tool_input = data.get("tool_input", {})
if not isinstance(tool_input, dict):
    respond("allow")
    raise SystemExit(0)

def walk(value, key=""):
    if isinstance(value, str):
        yield key, value
    elif isinstance(value, dict):
        for child_key, child_value in value.items():
            yield from walk(child_value, str(child_key))
    elif isinstance(value, list):
        for child_value in value:
            yield from walk(child_value, key)

SENSITIVE_PATHS = (".env", ".pem", ".key", "id_rsa", "id_ed25519", "credentials", "service-account", ".p12", ".pfx", ".keystore")
SECRET_PATTERN = re.compile(r"(password|secret|api_key|auth|bearer|token|private_key|aws_access_key_id|aws_secret_access_key|akiai|asiai|ghp_|github_pat|sk-|glpat-|npm_|pypi_|docker_auth|private.?key|BEGIN .* PRIVATE KEY|ssh-rsa|ssh-ed25519)", re.IGNORECASE)

for key, value in walk(tool_input):
    key_lower = key.lower()
    if ("path" in key_lower or "file" in key_lower) and any(marker in value for marker in SENSITIVE_PATHS):
        respond("deny", "Direct modification of sensitive file blocked")
        raise SystemExit(0)

for _, value in walk(tool_input):
    if SECRET_PATTERN.search(value):
        respond("deny", "Potential secret leak detected")
        raise SystemExit(0)

respond("allow")
PY
