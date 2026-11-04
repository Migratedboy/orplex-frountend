# MODULE-MAP.md — where responsibilities live in Orplex Code

Companion to `MODULARIZATION-AUDIT.md`. Purpose: an AI agent or human should be able to locate the right file without loading the repo.

Architecture overview doc: `ARCHITECTURE.md` (repo root). This map is the fast lookup layer.

Do not update this file per-feature; update it when a responsibility **moves**.

## Tool / agent

| Responsibility | Lives in | Notes |
|---|---|---|
| Canonical tool registry (source of truth) | `src/lib/tool-definitions.ts` (42-tools roster) | Client prompt roster derives from `M3_TOOL_DEFINITIONS`. |
| Prompt doctrine / one prompt for all lanes | `src/lib/master-prompt.ts` | + `buildToolRoster(names?)` — lanes pass their real roster. |
| Provider conversion (schema → model) | `src/lib/ai-providers.ts` | + server-side SSE reading (`sseTransform`). |
| Client SSE reading (model→app) | `src/lib/stream-reader.ts` | Also display hygiene (thinking/fences). |
| Tool-call parsing skills (turn output) | `src/lib/tool-text.ts` | XML wrappers, bare JSON, param-pair native templates. |
| Turn loop / truncation detection | `src/lib/agent/loop-engine.ts` | Dedupes native-template pairs and tool extraction. |
| Loop/progress detection | `src/lib/loop-detect.ts` | Also `READ_ONLY_TOOLS`. |
| Client tool dispatch (42 branches) | `src/lib/agent/native-tools.ts` | `ToolContext` contract at segment 143. |
| Shared pure contracts (both lanes) | `src/lib/agent/contract/*` | `tools.ts` (validation), `results.ts` (formatter — currently unused by lanes), `browser.ts`. |
| Server lane (worktree runs) | `src/lib/server-executor/executor.ts` | Own dispatcher `executeTool`; `buildNativeToolDefs`; DB approvals. |
| Worktree helpers | `src/lib/server-executor/worktree.ts` | Git worktree primitives, shared. |
| Server-worker runtime | `src/lib/agent/runtime/` | Scheduler, types, instance state. |
| Client chat lane | `src/lib/background-worker.ts` | Token budget, gates, verification lanes, ledger. Chat session struct + run phases in `src/lib/background-chat.ts`. |
| Compaction | `src/lib/compaction.ts` | ONE hierarchical compactor used by both lanes. |
| Verification (real browser) | `src/lib/browser-verification/` | Shared by the `verify_app` tool and the browser-verification lane. |
| Role-classifier / jail | `src/lib/risk-classifier.ts`, `src/lib/reliability/` | Approval gating + incident drivers. |
| Command acceptance | `src/lib/exec-guard.ts` | Screened allow-list; backstop twin lives in `electron/terminal.ts`. |
| Web search chain (ONE) | `src/lib/web-search.ts` | Used by `/api/search` AND server lane tool. |
| Effort budgeting | `src/lib/effort.ts` | Leaf lib. |
| Skill/position/budget/output caps | `src/lib/model-output-caps.ts` | Clamp before sending to the model. |

## Electron (windows, framework processes, IPC)

| Responsibility | Lives in |
|---|---|
| App entry / lifecycle / window / port takeover / crash recovery | `electron/main.ts` |
| Next-children kill lane (shared by will-quit + SIGTERM/SIGINT) | `electron/next-children.ts` |
| IPC bridge surface (renderer-side) | `electron/preload.ts` |
| Terminal / exec / serve children + safe env / toolchain | `electron/terminal.ts` |
| MCP OAuth + SSRF-guarded passthrough | `electron/mcp-bridge.ts` |
| Auth deep links (`orplex://`) | `electron/auth-desktop.ts` |
| Updater | `electron/updater.ts` |
| Tray + event notifications | `electron/tray.ts` |
| Runtime mode helpers | `electron/dev-mode.ts` |

## API routes (`src/app/api/**/route.ts`)

115 routes. Largest / logic-heavy ones worth knowing by name:

| Route | What to know |
|---|---|
| `/api/chat/route.ts` | Model call pipeline: routing → one prompt/one roster → provider retry loop with lean-on-413. Failure classification + user-copy live in `src/lib/provider-failure-policy.ts`; model-id/ctx-window helpers in `src/lib/model-context-windows.ts`. |
| `/api/agent/exec/route.ts` | Three exec lanes: Vercel sandbox → CI sandbox → local spawn. |
| `/api/agent/serve/route.ts` | Detached serve lane: registry + auth/ownership in the route; pure process helpers (`detectPort`, `waitUntilListening`, `treeKill`) in `src/lib/serve-process.ts`. |
| `/api/agent/ledger/route.ts` | Thin coordinator; payload rules + persistence live in `src/lib/task-ledger.ts`. |
| `/api/search/route.ts` | Thin wrapper over `src/lib/web-search.ts`. |

Most other routes are auth + Prisma thin handlers — keep them that way.

## UI

| Responsibility | Lives in |
|---|---|
| Chat session state (client) | `src/hooks/useChatSession.ts` + background-chat context |
| Prompt surface | `src/components/ChatInput.tsx` (model catalog engine), `src/components/PromptBar.tsx` (menus/picker/effort) |
| Right side panel (tabs) | `src/components/RightPanel.tsx` — Changes / Files / Browser preview / Terminal / Scratch tabs |
| Agent runs UI | `src/components/AgentManager.tsx`, `src/components/RunBoard.tsx` |
| MCP connectors | `src/components/ConnectorsPanel.tsx` |
| Settings | `src/app/settings/page.tsx` |
| Model catalog (client rules) | `src/lib/model-catalog.ts` + `src/lib/catalog-sync.ts`/`catalog-ingest.ts` |

## Storage / persistence

| Responsibility | Lives in |
|---|---|
| Checkpoints | `src/lib/checkpoints.ts`, `src/lib/auto-checkpoint.ts`, `src/lib/file-history.ts`, `workspace-history.ts` |
| Local conversations (desktop) | `electron/conversations-store.ts` (pure Node, jest-tested) |
| Project sync | `src/lib/project-sync.ts`, `src/lib/sync-transport.ts` |
| Workspace cwd resolution | `src/lib/workspace-cwd.ts` |
| Atomic writes pattern | temp-write + rename (see `attachment-store.ts:182`), follow it for any new store |

## Boundary rules (hard edges)

- `electron/**` must not import `src/**` (electron tsconfig `rootDir: "."`). Cross-layer contracts are deliberate, documented keeps-in-sync copies.
- `src/**` must not import `electron/**`.
- `src/lib` leaf modules (`tool-text`, `tool-definitions`, `loop-detect`, `effort`, `web-search`) must stay free of React, Prisma, Next and Electron imports.
- Exactly ONE implementation of: compaction, web search, master prompt, tool registry, SSE reading per side. If you are about to copy one, you are about to break a lane-parity rule.
