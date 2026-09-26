---
sidebar_position: 1
---

# Features

What Orplex actually does today — no roadmap items on this page. Every feature below ships in the repo; the agent-loop features were verified end-to-end against a live server run (spawn → poll → review → merge gate).

## BYOK frontier mode

Orplex runs on **your** API keys — no subscription, no middleman, no logging proxy. The provider factory (`src/lib/ai-providers.ts`) supports four OpenAI-compatible ecosystems:

| Provider | Env vars | Notes |
|---|---|---|
| NVIDIA | `NVIDIA_API_KEY` | Default provider. Free tier available. |
| OpenRouter | `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL` | Any hosted frontier model. |
| Groq | `GROQ_API_KEY`, optional `GROQ_MODEL` | Very fast inference. |
| Custom | `AI_PROVIDER=custom`, `AI_BASE_URL`, `AI_API_KEY` | Point at any OpenAI-compatible endpoint (Anthropic, Gemini OpenAI-compat, local gateways). |

Check what the harness will actually use at `GET /api/agent/provider-status` — it reports the selected provider, model, and where each value came from. Every agent run can carry a per-run `modelOverride` so one queue can mix models.

## Morning PR queue

Queue agent work the evening before; review the branches with your coffee. Runs carry a `notBefore` timestamp and a `priority`, and the executor's claim query skips anything whose time hasn't come:

```bash
curl -X POST http://localhost:5000/api/agent/runs/batch \
  -H "Content-Type: application/json" \
  -d '{"prompts":["upgrade deps","write missing tests","clean dead exports"],"staggerMinutes":45,"priority":5}'
```

Up to 8 runs, staggered at `staggerMinutes` intervals, all executing unattended in isolated git worktrees. Each finished run pushes its branch and hands you a PR-compare link — the merge stays a human decision.

## MCP interop — Claude Code drives Orplex

Orplex is both an **MCP client** (it can attach your own MCP servers to agent runs via `orplex.config.json`) and an **MCP server** (other agents can drive Orplex). The stdio proxy `scripts/orplex-mcp-server.mjs` exposes four tools over the token-gated `/api/mcp` gateway:

- `spawn_run` — queue a run (isolated worktree, server executor)
- `list_runs` — statuses for recent runs
- `get_run_review` — lifecycle events + the unified-diff review patch
- `merge_run` — merge/discard the reviewed branch (the final gate stays human: a dirty workspace is refused with 409)

Register it in Claude Code's MCP config:

```json
{
  "mcpServers": {
    "orplex": {
      "command": "node",
      "args": ["<repo>/scripts/orplex-mcp-server.mjs"],
      "env": {
        "ORPLEX_URL": "http://localhost:5000",
        "ORPLEX_MCP_TOKEN": "<same value as the server env>"
      }
    }
  }
}
```

Enablement steps (token, executor flag) live in [Self-hosting → Agent automation flags](/docs/guides/self-hosting); the full walkthrough is in [Claude Code interop](/docs/guides/claude-code).

## Flight recorder — tamper-evident audit bundle

Every run's lifecycle is recorded as a SHA-256 hash-chained event log. `GET /api/agent/runs/[id]/export` produces one self-verifying JSON bundle (run row + chained events + artifacts); `GET /api/agent/runs/[id]/export/verify` re-checks the chain. Replay-style step walkthroughs (screenshots + per-step error deltas) are stored as artifacts for UI work and visible in the run drawer.

## Runs that survive reality

The executor is built for the machine you actually have: agent runs execute in parallel up to `ORPLEX_MAX_CONCURRENT_RUNS` (clamped to 3 — a hard 8 GB-RAM ceiling, not a suggestion) while browser verification stays globally serialized so only one dev server can ever boot. Workspace registration persists in the database, so merging a reviewed branch works after a server restart. Runs orphaned by a crash are requeued at startup (three strikes, then an honest failure). Providers are retried with exponential backoff honoring `Retry-After`, an opt-in `AI_FAILOVER` chain keeps runs alive through rate limits, and native function-calling plus per-run token metering (`usage` timeline events, `tokenUsage` on the run) make weak-model loops and costs observable instead of guessed.

## Context discipline for low-spec machines

- **Transcript compaction** — evicted turns become a summarized `<context_so_far>` block instead of being lost.
- **Real ripgrep search** — `search_code` runs actual `rg` with per-server command caps.
- **Worktree isolation + NTFS junctions** — agent runs never touch your working copy; `node_modules` is linked, not reinstalled (8 GB-RAM friendly).
- **Server executor opt-in** — all automation flags are off by default; see [Self-hosting](/docs/guides/self-hosting) for the safe-enablement list.

## What Orplex is not (yet)

Honest scope: single-user local desktop app; one workspace registered per session; no distributed workers, team features, or hosted sync. The [architecture guide](/docs/guides/architecture) explains how the pieces fit if you want to change that.
