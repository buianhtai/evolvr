# evolvr

> Self-evolving memory for AI agents. Tracks tool-call patterns, detects failure loops, and surfaces learned behaviors across sessions.

---

## What it does

Every AI coding session is a black box — the agent makes mistakes, loops on the same calls, reads files it already read, and then forgets everything when the session ends. **evolvr** fixes that.

It records every tool call your agent makes, runs a rule-based failure classifier at session end, and builds a persistent lesson store. The next session, lessons are injected into the system prompt so the agent starts smarter.

### Three failure detectors (v0.1)

| Detector | Triggers when… |
|---|---|
| **Exact-repeat loop** | The same tool is called with identical args and produces identical results 3+ times |
| **Read-only streak** | 8+ consecutive non-mutating calls with no writes |
| **Same-result cycling** | A tool returns the same result from 4+ different input variations |

---

## Packages

| Package | Description |
|---|---|
| `@evolvr/core` | Types, SQLite + Postgres adapters, classifier, Evolvr class |
| `@evolvr/cli` | `evolvr` CLI — init, status, tasks, lessons, hook |
| `@evolvr/mcp` | MCP server for Claude, OpenCode, Codex integration |

---

## Quick start

```bash
npm install -g @evolvr/cli   # or pnpm add -g

cd your-project
evolvr init          # creates .evolvr/config.json + evolvr.db
evolvr status        # shows journal stats
evolvr lessons       # lists learned behaviors
```

---

## Integration

### Claude Code (via settings.json hooks)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "evolvr hook --event pre-tool --task $CLAUDE_SESSION_ID --tool $TOOL_NAME"
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "evolvr hook --event post-tool --task $CLAUDE_SESSION_ID --tool $TOOL_NAME --args-hash $ARGS_HASH --result-hash $RESULT_HASH --latency $LATENCY_MS"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "evolvr hook --event stop --task $CLAUDE_SESSION_ID --outcome success"
      }]
    }]
  }
}
```

### MCP (any MCP-compatible agent)

Add to your MCP config:

```json
{
  "mcpServers": {
    "evolvr": {
      "command": "evolvr-mcp",
      "args": ["--project-root", "/path/to/your/project"]
    }
  }
}
```

The MCP server exposes 4 tools:

- `evolvr_record_tool_call` — log a tool invocation
- `evolvr_session_end` — finalize a session, run classifier
- `evolvr_get_lessons` — get lessons for injection into system prompt
- `evolvr_get_status` — journal stats

---

## CLI reference

```bash
evolvr init [--storage sqlite|postgres] [--postgres-url URL]
evolvr status
evolvr tasks [--agent claude] [--outcome failed] [--limit 20] [--show-tool-calls]
evolvr lessons [--agent claude] [--class exact_repeat_loop] [--promote]
evolvr hook --event start|pre-tool|post-tool|stop [options]
```

---

## Architecture

```
packages/
  core/   — types, adapters (SQLite via libsql, Postgres), classifier, Evolvr class
  cli/    — Commander.js CLI, hook command for agent integration
  mcp/    — @modelcontextprotocol/sdk server, 4 tools
```

Storage is SQLite (default, local `file:`) or Postgres. The classifier is deterministic (rule-based) — no LLM calls in v0.1.

---

## Roadmap

- **v0.2** — Stage 2 classifier (LLM-based pattern recognition for unknown failure modes)
- **v0.3** — Auto-promote high-confidence lessons to `AGENTS.md`
- **v0.4** — OpenCode plugin, Pi extension, Codex adapter
- **v1.0** — Lesson diffing, cross-project lesson sharing

---

## License

MIT
