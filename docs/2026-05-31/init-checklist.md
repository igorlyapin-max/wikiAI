# 2026-05-31 Required Init Checklist

**Run ID:** chat-2026-05-31T05-29-35-239Z-1233713
**Ontology graph:** `.omk/memory/graph-state.json`

## Required Artifacts
- ✅ `AGENTS.md` — critical; top-level operating contract
- ✅ `.kimi/AGENTS.md` — critical; Kimi-specific operating rules
- ✅ `DESIGN.md` — support; design/brand source of truth
- ✅ `.omk/config.toml` — critical; OMK project runtime settings
- ✅ `.omk/agents/root.yaml` — critical; root coordinator agent
- ✅ `.kimi/mcp.json` — critical; Kimi project MCP registry
- ✅ `.omk/mcp.json` — support; legacy OMK MCP fallback
- ✅ `.omk/lsp.json` — support; TypeScript LSP config
- ✅ `.omk/hooks/pre-shell-guard.sh` — critical; destructive shell guard
- ✅ `.omk/hooks/protect-secrets.sh` — critical; secret write guard
- ✅ `.omk/memory/graph-state.json` — critical; local ontology graph database
- ✅ `.kimi/skills` — support; Kimi skill directory
- ✅ `.agents/skills` — support; portable skill directory

## Recovery Command
```bash
omk init
omk doctor
```
