#!/usr/bin/env bash
# PreShellUse Guard — blocks dangerous commands
set -e

# Close security gate if jq/python3 is missing (deny by default)
if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"python3 not installed — pre-shell-guard cannot validate commands"}}'
  exit 0
fi

INPUT=$(cat)
DESTRUCTIVE_DECISION=$(INPUT_JSON="$INPUT" "$PY" <<'PY'
import json
import os
import posixpath
import shlex

def decision(reason):
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}}, separators=(",", ":")))

def as_tokens(value):
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        return shlex.split(value, comments=True, posix=True)
    return []

def expand_shell_wrappers(root_tokens):
    result = []
    queue = [root_tokens]
    while queue and len(result) < 8:
        current = queue.pop(0)
        result.append(current)
        for idx, token in enumerate(current):
            if posixpath.basename(token) not in {"bash", "sh", "zsh", "dash"}:
                continue
            j = idx + 1
            while j < len(current):
                opt = current[j]
                if opt == "--":
                    j += 1
                    break
                if opt in {"-c", "-lc"} or (opt.startswith("-") and not opt.startswith("--") and "c" in opt):
                    if j + 1 < len(current):
                        queue.append(as_tokens(current[j + 1]))
                    break
                if opt.startswith("-"):
                    j += 1
                    continue
                break
    return result

def flag_letters(token):
    if token.startswith("--"):
        return set()
    if token.startswith("-"):
        return set(token[1:])
    return set()

def has_rm_rf(tokens, index):
    letters = set()
    for token in tokens[index + 1:]:
        letters.update(flag_letters(token))
        if not token.startswith("-"):
            break
    return "r" in letters and "f" in letters

def has_git_clean_danger(tokens, index):
    rest = tokens[index + 1:]
    if "clean" not in rest:
        return False
    clean_index = rest.index("clean") + index + 1
    letters = set()
    for token in tokens[clean_index + 1:]:
        letters.update(flag_letters(token))
    return {"f", "d", "x"}.issubset(letters)

def has_pipe_to_shell(tokens):
    shell_names = {"bash", "sh", "zsh", "dash"}
    downloaders = {"curl", "wget"}
    for idx, token in enumerate(tokens):
        if token != "|":
            continue
        left = {posixpath.basename(item) for item in tokens[:idx]}
        right = {posixpath.basename(item) for item in tokens[idx + 1:]}
        if left & downloaders and right & shell_names:
            return True
    return False

def is_destructive(tokens):
    normalized = [str(token) for token in tokens]
    for idx, token in enumerate(normalized):
        exe = posixpath.basename(token)
        if exe == "sudo":
            return True
        if exe == "rm" and has_rm_rf(normalized, idx):
            return True
        if exe == "git" and has_git_clean_danger(normalized, idx):
            return True
        if exe == "chmod" and "-R" in normalized[idx + 1:] and "777" in normalized[idx + 1:]:
            return True
        if exe == "docker" and normalized[idx + 1:idx + 3] == ["system", "prune"]:
            return True
        if exe == "kubectl" and "delete" in normalized[idx + 1:]:
            return True
        if exe == "aws" and normalized[idx + 1:idx + 4] == ["s3", "rm", "--recursive"]:
            return True
        if exe.startswith("mkfs") or any(arg.startswith("if=") for arg in normalized[idx + 1:] if exe == "dd"):
            return True
    return has_pipe_to_shell(normalized)

try:
    data = json.loads(os.environ.get("INPUT_JSON", "{}"))
    tool_input = data.get("tool_input", {})
    tokens = as_tokens(tool_input.get("command", "")) + as_tokens(tool_input.get("args", ""))
    for expanded in expand_shell_wrappers(tokens):
        if is_destructive(expanded):
            decision("Potentially destructive command blocked by pre-shell-guard")
            break
except Exception as exc:
    decision("Unable to parse destructive command safely: " + str(exc))
PY
)
if [ -n "$DESTRUCTIVE_DECISION" ]; then
  echo "$DESTRUCTIVE_DECISION"
  exit 0
fi
COMMAND=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))')
ARGS=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("args",""))')

FULL="$COMMAND $ARGS"

# Block list
BLOCKED=(
  "rm -rf /"
  "rm -rf ~"
  "sudo"
  "git push --force"
  "git push -f"
  "git clean -fdx"
  "chmod -R 777"
  "docker system prune"
  "kubectl delete"
  "aws s3 rm --recursive"
  "curl | bash"
  "curl | sh"
  "wget | bash"
  "wget | sh"
  "mkfs"
  "dd if="
  "> /dev/"
  ":(){ :|:& };:"
)

for pattern in "${BLOCKED[@]}"; do
  if [[ "$FULL" == *"$pattern"* ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Potentially destructive command blocked by pre-shell-guard"}}'
    exit 0
  fi
done

# Release/deploy guard. These commands are not destructive like rm -rf, but
# they can publish external state. Parse tokens so common option/shell-wrapper
# variants cannot bypass the guard.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT_JSON="$INPUT" SCRIPT_DIR="$SCRIPT_DIR" "$PY" <<'PY'
import json
import os
import posixpath
import shlex
import sys

def respond(permission, reason=None):
    payload = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": permission}}
    if reason:
        payload["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(0)

def as_tokens(value):
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        return shlex.split(value, comments=True, posix=True)
    return []

def expand_shell_wrappers(root_tokens):
    result = []
    queue = [root_tokens]
    while queue and len(result) < 8:
        current = queue.pop(0)
        result.append(current)
        for idx, token in enumerate(current):
            if posixpath.basename(token) not in {"bash", "sh", "zsh", "dash"}:
                continue
            j = idx + 1
            while j < len(current):
                opt = current[j]
                if opt == "--":
                    j += 1
                    break
                if opt in {"-c", "-lc"} or (opt.startswith("-") and not opt.startswith("--") and "c" in opt):
                    if j + 1 < len(current):
                        try:
                            queue.append(as_tokens(current[j + 1]))
                        except ValueError as exc:
                            respond("deny", f"Unable to parse shell-wrapped release/deploy command safely: {exc}")
                    break
                if opt.startswith("-"):
                    j += 1
                    continue
                break
    return result

def skip_flags(tokens, index):
    value_flags = {
        "-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
        "--registry", "--userconfig", "--prefix", "--cache", "--filter", "--workspace",
        "--cwd", "--repo", "-R", "--ref", "--field", "-f", "--json", "--jq",
    }
    i = index
    while i < len(tokens):
        token = tokens[i]
        if token == "--":
            return i + 1
        if token in value_flags and i + 1 < len(tokens):
            i += 2
            continue
        if any(token.startswith(prefix + "=") for prefix in value_flags if prefix.startswith("--")):
            i += 1
            continue
        if token.startswith("-"):
            i += 1
            continue
        return i
    return i

def has_token_after(tokens, index, wanted):
    return any(token in wanted for token in tokens[index:])

def is_release_command(tokens):
    i = 0
    while i < len(tokens):
        exe = posixpath.basename(tokens[i])
        if exe == "git":
            command_index = skip_flags(tokens, i + 1)
            if command_index < len(tokens) and tokens[command_index] == "push":
                return True
            i = max(command_index + 1, i + 1)
            continue
        if exe == "npm":
            command_index = skip_flags(tokens, i + 1)
            if command_index < len(tokens) and tokens[command_index] in {"publish", "version"}:
                return True
            if has_token_after(tokens, i + 1, {"publish", "version"}):
                return True
            i += 1
            continue
        if exe == "pnpm":
            if has_token_after(tokens, i + 1, {"publish"}):
                return True
            i += 1
            continue
        if exe == "yarn":
            rest = tokens[i + 1:]
            if "publish" in rest:
                return True
            if len(rest) >= 2 and rest[0] == "npm" and rest[1] == "publish":
                return True
            i += 1
            continue
        if exe == "gh":
            command_index = skip_flags(tokens, i + 1)
            if command_index + 1 < len(tokens):
                pair = (tokens[command_index], tokens[command_index + 1])
                if pair in {("release", "create"), ("workflow", "run")}:
                    return True
            i += 1
            continue
        i += 1
    return False

try:
    data = json.loads(os.environ.get("INPUT_JSON", "{}"))
    tool_input = data.get("tool_input", {})
    tokens = as_tokens(tool_input.get("command", "")) + as_tokens(tool_input.get("args", ""))
except Exception as exc:
    respond("deny", f"Unable to parse release/deploy command safely: {exc}")

if os.environ.get("OMK_ALLOW_RELEASE") == "1":
    respond("allow")

# File-based override for environments where env vars don't propagate to hooks
allow_release_path = os.path.join(os.environ.get("SCRIPT_DIR", ""), ".allow-release")
if os.path.exists(allow_release_path):
    respond("allow")

for expanded in expand_shell_wrappers(tokens):
    if is_release_command(expanded):
        respond("deny", "Release/deploy command blocked by OMK release guard. Re-run with OMK_ALLOW_RELEASE=1 only after an explicit user request and fresh verification evidence.")

respond("allow")
PY
