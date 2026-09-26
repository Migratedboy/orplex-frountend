---
sidebar_position: 6
---

# Driving Orplex from Claude Code

Orplex speaks MCP in both directions. This guide covers the **server** direction: exposing Orplex's isolated-run engine to Claude Code (or any MCP client), so another agent can launch Orplex runs, read back the review patch, and merge them — while the isolation, approvals, and audit trail remain Orplex's.

```
Claude Code (MCP client)
   │  stdio (JSON-RPC)
   ▼
scripts/orplex-mcp-server.mjs   ← the proxy (a tiny stdio MCP server)
   │  HTTP POST /api/mcp  (Bearer token)
   ▼
Orplex server  →  git worktree run  →  branch  →  your review  →  merge
```

Why this is interesting: Claude Code gets a **worktree-isolated executor with a review gate** it doesn't have natively. Orplex gets **more agents driving it** without Orplex building its own UI. Neither needs the other to exist.

## Prerequisites

- Orplex running locally (`npm run dev` — the app listens on **http://localhost:5000**)
- Claude Code installed with MCP support
- One or more completed Orplex runs in the Manager, so you can recognize the flow

## Step 1 — Set the gateway token

The proxy authenticates to Orplex with a bearer token. Generate a long random value and add it to your Orplex environment (`.env`):

```bash
ORPLEX_MCP_TOKEN=<long random string>
```

Then restart `npm run dev`. The `/api/mcp` route refuses every request until this is set — the gateway is opt-in, never silently open.

## Step 2 — Register the proxy in Claude Code

Add the proxy server to Claude Code's MCP config (`.mcp.json` in the project, or the global config file):

```json
{
  "mcpServers": {
    "orplex": {
      "command": "node",
      "args": ["<absolute path to orplex>/scripts/orplex-mcp-server.mjs"],
      "env": {
        "ORPLEX_URL": "http://localhost:5000",
        "ORPLEX_MCP_TOKEN": "<the same long random string>"
      }
    }
  }
}
```

Two details that matter:

- `ORPLEX_URL` must point at the port Orplex actually listens on — `5000` with this repo's default `npm run dev`. If you changed the port, change this.
- Use an **absolute path** in `args`; the proxy is plain Node with no dependencies, so no build step or `npx` needed.

Restart Claude Code (or run `/mcp` to reconnect). You should see the `orplex` server listed with four tools.

## Step 3 — The four tools

| Tool | What it does |
|---|---|
| `spawn_run` | Queue a Manager run: `{ "prompt": "..." , "autonomyPolicy": "approval" }` → returns `runId` |
| `list_runs` | Recent runs with id, status, branch, timestamps (up to 25) |
| `get_run_review` | One run's lifecycle events + the **unified patch** (diff vs base branch) |
| `merge_run` | Merge or discard the reviewed branch: `{ "runId": "...", "action": "merge" }` |

## Step 4 — Try the loop end to end

Ask Claude Code something like:

> Use the orplex tools: spawn a run that adds a `/health` endpoint to the app, then when it's done show me the diff and ask me before merging.

What happens:

1. Claude Code calls `spawn_run`. Orplex creates the run (`pending`), and the persistent server executor leases it, creates a git worktree on an `orplex/run-*` branch, and executes the task there. Your working tree is untouched the whole time.
2. If the task needs a risky command and `autonomyPolicy` is `approval`, the run parks on `waiting_approval` — the approval is decided in the Orplex UI (Manager → run drawer), not by Claude Code. The gate stays human.
3. On completion, `get_run_review` returns the timeline and the patch. Claude Code can summarize the diff for you.
4. You decide. `merge_run` with `action: "merge"` fast-forwards the review into your branch — or `action: "discard"` throws it away. Both go through the same guardrails as the UI's merge button: refuse on a dirty tree, clean abort on conflicts.

## The rules of the gateway

- **Local only, by design.** The proxy talks to `ORPLEX_URL` over your machine's loopback. Don't expose `/api/mcp` to a network; the token is meant for machine-to-machine use on one machine.
- **Runs are attributed to the local user.** The gateway resolves the first user in the database — the one who signed into the app. There is no per-token impersonation.
- **The merge is the only write outside Orplex.** Everything else (spawn, list, review) is read-only or creates work that only lands after your explicit review.
- **Audit trail intact.** Runs spawned via MCP carry a `via: "mcp"` spawn event, appear in the Manager board like any other run, and export the same tamper-evident audit bundle.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ORPLEX_MCP_TOKEN not configured or invalid` (401) | Token missing in the server env, not restarted, or different from the proxy's `ORPLEX_MCP_TOKEN` |
| Proxy exits immediately | `ORPLEX_MCP_TOKEN` env var not set for the proxy process |
| `no user exists — sign in once in the app first` | The database has no users yet — open Orplex and sign in once |
| `MCP server limit reached` when *Orplex* uses MCP tools | That's the client-side cap (2 servers) from `orplex.config.json` — see the [config reference](./orplex-config.md) |
| Tools listed but calls time out | Orplex isn't running on `ORPLEX_URL`, or the port is wrong |

## The other direction

This guide is about Claude Code → Orplex. For Orplex → external tools (giving *Orplex's* agent MCP servers from your Claude Code config), see the [orplex.config.json reference](./orplex-config.md). The two compose: Claude Code can drive Orplex, and Orplex runs can use the same MCP ecosystem.
