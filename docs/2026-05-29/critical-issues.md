# 2026-05-29 Critical Issues

## Critical Init Status
- No critical init artifacts were missing when this daily file was generated.
### Missing critical artifacts
- None detected.


## Critical Artifacts Present
- ✅ `AGENTS.md` — top-level operating contract
- ✅ `.kimi/AGENTS.md` — Kimi-specific operating rules
- ✅ `.omk/config.toml` — OMK project runtime settings
- ✅ `.omk/agents/root.yaml` — root coordinator agent
- ✅ `.kimi/mcp.json` — Kimi project MCP registry
- ✅ `.omk/hooks/pre-shell-guard.sh` — destructive shell guard
- ✅ `.omk/hooks/protect-secrets.sh` — secret write guard
- ✅ `.omk/memory/graph-state.json` — local ontology graph database

## Escalation Rule
- Treat missing shell/secret guards, root agent config, MCP registry, or ontology graph as critical until restored.
