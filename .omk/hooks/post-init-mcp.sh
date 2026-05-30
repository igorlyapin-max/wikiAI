#!/usr/bin/env bash
# Post-init MCP validation — non-blocking health check after omk init
set -uo pipefail

LOG_DIR=".omk/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/mcp-init-check.json"

# Run doctor silently and capture JSON output if available
if command -v omk &>/dev/null; then
  omk mcp doctor --json 2>/dev/null > "$LOG_FILE" || true
else
  echo '{"note":"omk not in PATH during hook execution"}' > "$LOG_FILE"
fi
