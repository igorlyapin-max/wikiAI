#!/usr/bin/env bash
# OMK Branch Diff Snapshot — records merge-review metadata without full diff contents
set +e

SNAP_DIR=".omk/runs/_branch-snapshots"
mkdir -p "$SNAP_DIR" >/dev/null 2>&1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo '{"hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":"Branch diff snapshot skipped: not inside a git worktree."}}'
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
safe_branch="$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '-')"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="$SNAP_DIR/$stamp-$safe_branch.md"

{
  echo "# OMK branch diff snapshot"
  echo
  echo "- branch: $branch"
  echo "- commit: $commit"
  echo "- captured_at: $stamp"
  echo
  echo "## Status"
  git status --short 2>/dev/null || true
  echo
  echo "## Diff stat"
  git diff --stat 2>/dev/null || true
  echo
  echo "## Changed files"
  git diff --name-only 2>/dev/null || true
} > "$snapshot"

printf '{"hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":"Branch diff snapshot saved: %s"}}\n' "$snapshot"
