---
sidebar_position: 5
---

# orplex.config.json Reference

Two features are configured in a single file, `orplex.config.json`, at the **root of your workspace**. Both are read at run time — edit the file and the change applies without restarting Orplex.

```json
{
  "mcpServers": { ... },
  "toolHooks": { ... }
}
```

Unknown fields are ignored. An unreadable or unparseable file is treated as "no configuration" — the agent keeps running, it just has no MCP tools or hooks. Config errors never take your agent down.

---

## `mcpServers` — extend the agent with external tools

Orplex speaks the [Model Context Protocol](https://modelcontextprotocol.io) as a **client**. Servers you declare here are launched as child processes and their tools are merged into the agent's tool roster for every server-executed run.

The format is deliberately identical to Claude Code's server config, so an existing `.mcp.json` can be pasted in unmodified:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

:::warning Low-spec budget
Each entry is a **real process** on your machine. Orplex enforces a hard cap of **2 concurrent MCP servers**. With three configured, the third fails honestly with "MCP server limit reached" rather than being silently dropped — remove one.
:::

### How the tools appear to the agent

Each tool from server `S` named `T` becomes `mcp__S__T` and is listed in the run's system prompt with its description:

```
- mcp__github__create_issue — Create a GitHub issue in a repository
```

The agent calls it like any built-in tool. Results come back as tool results, capped at 30,000 characters per call. The timeline emits `mcp-tools-loaded` (count + servers) at run start and `mcp-server-error` events if a server fails to start or times out.

### Runtime limits

| Limit | Value | Why |
|---|---|---|
| Concurrent servers | 2 | 8GB-RAM budget: each server is a process |
| Tool-call timeout | 120 s | A hung child on 4 cores is worse than a failed call |
| Idle reaping | 5 min | Unused servers are killed, restarted on demand |
| Result size | 30,000 chars | Keeps a chatty tool from eating the context budget |

### Which servers make sense

Good candidates: documentation lookup (`context7`), GitHub issues/PRs, database introspection, internal APIs. Poor candidates: servers that spawn their own browsers or models — Orplex already has browser tools and your provider key is used by the run itself.

## `toolHooks` — deny and notify rules

Declarative gating for the agent's tool calls. Two rule lists, both regexes (case-insensitive), both applied to **every** tool call in **both** agent loops (client tab and server executor), including MCP tools.

```json
{
  "toolHooks": {
    "deny": ["rm\\s+-rf", "drop\\s+table", "force\\s+push"],
    "notify": ["^run_command$", "write_file", "mcp__github__"]
  }
}
```

### `deny` — block, with a reason the agent can read

Matched against `<tool name> <args summary>` (e.g. `run_command command=npm test`). On a hit, the call **does not execute**; the agent receives `blocked by toolHooks.deny rule: /rm\s+-rf/i` as the tool result and adapts — same failure mode as a failed command, so no special handling needed. A `tool-denied` event appears on the run timeline.

### `notify` — watch, don't block

A rule fires when it matches the **tool name** (so `^run_command$` matches exactly that tool) or the **full name+args summary** (so a keyword like `secrets` fires on any tool whose args mention it). A `tool-notify` event appears on the timeline; execution proceeds.

### Working example

```json
{
  "toolHooks": {
    "deny": [
      "rm\\s+-rf\\s+[~\\/]",          // rm -rf of home or root
      "drop\\s+table",                 // destructive SQL
      "git\\s+push.*--force"           // force pushes
    ],
    "notify": [
      "^run_command$",                 // every shell command
      "mcp__github__",                 // every GitHub MCP call
      "path=\\.env"                    // any tool touching .env files
    ]
  }
}
```

### Rules of the road

- Regexes are compiled case-insensitive; a rule that fails to compile is skipped, not fatal. Max 50 rules per list, each ≤200 chars.
- Rules are evaluated **before** the tool runs, for every call — the cost is a handful of regex tests, no I/O.
- Process-spawning hooks are deliberately not supported: arbitrary per-call exec is a risk and a RAM cost this product refuses.
- Config is cached for 60 s — edits apply within a minute, without restarts.

## Related

- [Driving Orplex from Claude Code](./claude-code.md) — the other MCP direction: let Claude Code launch Orplex runs
- [Install](../getting-started/install.md) — where Orplex looks for config
- [Self-hosting](./self-hosting.md) — running the executor persistently
- [Plugins](./plugins.md) — the in-process alternative to MCP servers
