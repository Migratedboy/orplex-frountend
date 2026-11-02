---
sidebar_position: 1
---

# Architecture

Orplex Code is an **Electron desktop app** around an internal Next.js 16 +
React 18 backend. `npm run dev` (or the packaged binary) launches Electron,
which spawns Next.js as an invisible child process on port 5000, owns its
lifecycle, and renders the UI in a native window. User data is **local-first**:
conversations, playbook learnings, the workspace registry, chat images and
staged files live on the device; the cloud backend (Vercel + Prisma/PostgreSQL)
owns authentication, model keys, the run database and cross-machine sync.

## High-Level Overview

```
┌────────────────────────────────────────────────────────────────┐
│                Electron Shell (main process)                    │
│  native Chromium preview tabs · agent browser view · tray      │
│  updater · conversations JSON store · IPC bridge (preload)     │
└──────────────────────────┬─────────────────────────────────────┘
                           │ loadURL(http://127.0.0.1:5000)
┌──────────────────────────┴─────────────────────────────────────┐
│                  Renderer (React UI)                            │
│  Chat · RightPanel (queue/changes/files/preview/terminal)      │
│  Manager board · Settings · Plugins · Playbook · Admin         │
│  background chat worker (client) runs the tool loop            │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP / SSE (src/proxy.ts — auth + cloud forward)
┌──────────────────────────┴─────────────────────────────────────┐
│              Next.js API layer (115 route handlers)             │
│  /api/chat · /api/agent/* (46) · /api/mcp/* (9) · auth · files │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  AI providers (12 registry entries, OpenAI-compatible)         │
│  Shared turn-loop engine · subagents · reliability gates       │
│  Verification lanes · Vercel Sandbox artifact execution        │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  Data: cloud Postgres (backend-owned Prisma)                   │
│  Device-local: conversations.json · playbook.json ·            │
│  workspaces.json · attachments · <workspace>/.orplex/ state    │
└────────────────────────────────────────────────────────────────┘
```

## Key Modules

| Module | Purpose |
|--------|---------|
| `electron/main.ts` | Child-process lifecycle, single instance, preview/agent-browser/terminal/conversation/updater IPC |
| `src/lib/background-worker.ts` | The client-side agent tool-calling loop |
| `src/lib/agent/loop-engine.ts` | The shared turn-loop skeleton both agent lanes run |
| `src/lib/agent/subagent.ts` | Read-only, depth-1 research subagents (`spawn_subagent`) |
| `src/lib/agent/contract/` | Pure shared contract: tool arg rules, risk, loop detection, browser ops |
| `src/lib/stream-reader.ts` | SSE parsing: native tool_calls + XML, thinking |
| `src/lib/master-prompt.ts` | Single source of truth for system prompts |
| `src/lib/playbook.ts` | Evidence-gated learning in a device-local JSON file |
| `src/lib/workspace-history.ts` | Durable per-workspace change history (`.orplex/history.jsonl`) |
| `src/lib/checkpoints.ts` | Restorable pre-write snapshots |
| `src/lib/reliability/` | Gate pipeline (typecheck/lint/test lanes), edit lock, path jail, taint/injection policies — behind `RELIABILITY_*` flags |
| `src/lib/vercel-sandbox.ts` | Sandboxed code execution and artifact serving on Vercel Sandbox microVMs |
| `src/lib/memory-file-store.ts` | `create_file` staging store (app memory, 4h TTL) |
| `src/lib/provider-registry.ts` | The 12-provider registry: auth style, listing path, free/paid, lanes |
| `src/lib/model-output-caps.ts` | Per-model output budgets; learns stated ceilings from 400s |
| `src/lib/default-models.ts` | The free-only curated default model list (live-verified, tested) |
| `src/lib/run-ledger.ts` | What actually failed across restarts (failure learning) |
| `src/lib/workspace-memory.ts` | Evidence-backed workspace learnings injected into future prompts |
| `src/proxy.ts` | Same-origin API gate: page auth, cloud forward, LOCAL_ONLY routes, 426 version handshake |

## Data Flow

1. User sends message via chat UI
2. `/api/chat` streams through the provider ladder (personal keys → key pool → env)
3. Per-model budget + reasoning-aware params are applied
4. The background worker parses tool calls and dispatches via the shared contract
5. Tools execute (file ops, commands, browser, subagents, MCP)
6. Results feed the next model turn (effort-tier caps, context meter, compaction)
7. Verification lanes run (typecheck, browser)
8. The loop continues until done — then the run ledger and workspace memory capture it

See the full accuracy-audited [`ARCHITECTURE.md`](https://github.com/Migratedboy/orplex-frountend/blob/main/ARCHITECTURE.md) in the repo root.
