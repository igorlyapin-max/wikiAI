#!/usr/bin/env bash
# OMK Worktree Create Guard — keeps worker lanes under .omk/worktrees by default
set -e

if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"python3 not installed — worktree-create-guard cannot validate commands"}}'
  exit 0
fi

INPUT=$(cat)
INPUT_JSON="$INPUT" "$PY" <<'PY'
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

try:
    data = json.loads(os.environ.get("INPUT_JSON", "{}"))
except Exception:
    respond("allow")

tool_input = data.get("tool_input", {})
raw_full = f"{tool_input.get('command', '')} {tool_input.get('args', '')}"
try:
    initial_tokens = as_tokens(tool_input.get("command", "")) + as_tokens(tool_input.get("args", ""))
except ValueError as exc:
    if "git" in raw_full and "worktree" in raw_full:
        respond("deny", f"Unable to parse git worktree command safely: {exc}")
    respond("allow")

def canonical_path(path):
    return os.path.realpath(os.path.abspath(path))

def resolve_path(path_arg, base_dir):
    return canonical_path(path_arg if os.path.isabs(path_arg) else os.path.join(base_dir, path_arg))

project_root = canonical_path(os.environ.get("OMK_PROJECT_ROOT") or os.getcwd())
allowed_root = canonical_path(os.path.join(project_root, ".omk", "worktrees"))
options_with_values = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
    "-b", "-B", "--reason", "--lock", "--orphan",
}

def path_within_allowed(path_arg, base_dir):
    base = canonical_path(base_dir)
    actual = resolve_path(path_arg, base)
    try:
        return os.path.commonpath([allowed_root, actual]) == allowed_root
    except ValueError:
        return False

def skip_git_globals(index):
    base_dir = canonical_path(os.getcwd())
    i = index
    while i < len(tokens):
        token = tokens[i]
        if token == "-C" and i + 1 < len(tokens):
            next_dir = tokens[i + 1]
            base_dir = resolve_path(next_dir, base_dir)
            i += 2
        elif token.startswith("-C") and len(token) > 2:
            next_dir = token[2:]
            base_dir = resolve_path(next_dir, base_dir)
            i += 1
        elif token in {"-c", "--git-dir", "--work-tree", "--namespace", "--config-env"} and i + 1 < len(tokens):
            i += 2
        elif token.startswith(("--git-dir=", "--work-tree=", "--namespace=", "--config-env=")):
            i += 1
        elif token == "--":
            i += 1
            break
        elif token.startswith("-"):
            i += 1
        else:
            break
    return i, base_dir

def find_worktree_path(index):
    i = index
    while i < len(tokens):
        token = tokens[i]
        if token == "--":
            i += 1
            break
        if token in options_with_values and i + 1 < len(tokens):
            i += 2
            continue
        if any(token.startswith(prefix) for prefix in ("--reason=", "--orphan=")):
            i += 1
            continue
        if token.startswith("-"):
            i += 1
            continue
        return token
    return tokens[i] if i < len(tokens) else None

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
                            if "git" in current[j + 1] and "worktree" in current[j + 1]:
                                respond("deny", f"Unable to parse shell-wrapped git worktree command safely: {exc}")
                    break
                if opt.startswith("-"):
                    j += 1
                    continue
                break
    return result

for tokens in expand_shell_wrappers(initial_tokens):
    i = 0
    while i < len(tokens):
        if posixpath.basename(tokens[i]) != "git":
            i += 1
            continue
        command_index, base_dir = skip_git_globals(i + 1)
        if command_index + 1 >= len(tokens) or tokens[command_index] != "worktree":
            i += 1
            continue
        action = tokens[command_index + 1]
        if action in {"remove", "prune"} and os.environ.get("OMK_ALLOW_WORKTREE_DELETE") != "1":
            respond("deny", "Worktree delete/prune blocked unless OMK_ALLOW_WORKTREE_DELETE=1 is set after review.")
        if action == "add" and os.environ.get("OMK_ALLOW_EXTERNAL_WORKTREE") != "1":
            path_arg = find_worktree_path(command_index + 2)
            if not path_arg or not path_within_allowed(path_arg, base_dir):
                respond("deny", "Worktree lanes must be created under .omk/worktrees/ unless OMK_ALLOW_EXTERNAL_WORKTREE=1 is set.")
        i = command_index + 2

respond("allow")
PY
