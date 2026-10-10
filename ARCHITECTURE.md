# Architecture — Orplex Code

## Overview

Orplex Code is an AI coding agent built as an **Electron desktop app** around an
internal Next.js 16 + React 18 + PostgreSQL backend. The user never runs the
backend: `npm run dev` (or the packaged binary) launches Electron, which spawns
Next.js as an invisible child process, owns its lifecycle, and renders the UI
in a native window. The product surface is: streaming agent chat, a real
embedded Chromium browser (user-facing AND agent-driven), live workspace file
editing with undo/checkpoints, multi-provider AI routing, durable run
orchestration with a Manager board, workspace memory, plugins/skills/MCP, and a
full admin/observability layer.

Stack: TypeScript everywhere, Next.js App Router, Prisma + PostgreSQL
(hosted Supabase for the cloud backend; an optional embedded local Postgres
for desktop/offline mode — skipped in lightweight mode), NextAuth
(Google/GitHub OAuth + dev bypass), Tailwind, Playwright (verification + E2E),
Electron 41.

## How It Runs (desktop-first)

```
npm run dev          # fetch fonts → compile electron main → launch Electron
                     # Electron: single-instance lock → start embedded Postgres
                     #           (skipped when ORPLEX_LIGHTWEIGHT=1)
                     #           → spawn `next dev` (port 5000) as child
                     #           → wait for HTTP → open BrowserWindow
npm start            # same, against a production build
npm run electron:dist# package installers (NSIS / DMG / AppImage)
```

- **Single instance**: a second launch focuses the existing window
  (`app.requestSingleInstanceLock`); two copies never fight over the port.
- **Port safety**: only a stale Orplex server from a crashed run is taken over
  on port 5000. The user's own processes are never killed.
- **Quit = teardown**: the Next child is killed with the app (Windows:
  `taskkill /T /F`); the embedded DB is left running (cheap to restart).

## High-Level Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    Electron Shell (main process)               │
│  tray + notifications · WebContentsView preview tabs           │
│  agent browser view · IPC bridge (preload) · single instance   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ loadURL(http://localhost:5000)
┌──────────────────────────┴─────────────────────────────────────┐
│                     Renderer (React UI)                        │
│  Chat page · RightPanel (browser/terminal/changes/queue/files) │
│  Manager board · Settings · History · Plugins · Admin          │
│  Context providers → hooks → background chat worker (client)   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP / SSE  (src/proxy.ts — auth + cloud forward)
┌──────────────────────────┴─────────────────────────────┐
│                Next.js API layer (87 route handlers)           │
│  /api/chat · /api/agent/* (38) · /api/admin/* (6) · auth ·     │
│  conversations · settings · workspaces · sync · MCP · models   │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  AI providers (OpenRouter · NVIDIA · OpenAI · Anthropic · …)   │
│  Server executor (claims runs) · verification harness          │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  Data: Prisma · PostgreSQL (Supabase or embedded .localpg)     │
│  Workspace files (.orplex/ history, checkpoints, memory)       │
└────────────────────────────────────────────────────────────────┘
```

---

# Major Features

## 1. Desktop Shell (Electron)

| Piece | File | What it does |
|---|---|---|
| Main process | `electron/main.ts` | Owns the Next child process, embedded Postgres bootstrap (`scripts/local-db.mjs`, port 5433; skipped entirely in `ORPLEX_LIGHTWEIGHT=1` mode), single-instance lock, port takeover, IPC for preview + agent browser, tray wiring, graceful shutdown (SIGTERM/SIGINT cleanup registry, cron-reset + backup cron in instrumentation) |
| Preload bridge | `electron/preload.ts` | `window.orplexDesktop`: `preview.*` (create/navigate/bounds/show/back/forward/reload/screenshot/events), `agentBrowser.*` (show/showId/getId/navigate/read/elements/interact+ref/console/find/waitFor/hover/select/tabs/network/screenshot(fullPage,viewport)/evaluate), `openExternal`, `getPathForFile`, versions |
| Tray | `electron/tray.ts` | Static template icon + native notifications; polls the local run-board summary and fires on status transitions only |
| Window | `electron/main.ts` | 1440×900, dark background, menu (View/Edit roles), `window.open` → OS browser |

## 2. Embedded Browser (Preview panel) — native Chromium

Real Chromium `WebContentsView`s owned by the main process, layered over the
RightPanel viewport and positioned via IPC (`preview:setBounds`). Isolated
`persist:orplex-preview` partition (no cookie sharing with the app).

- **Tabs**: per-tab history, back/forward, reload, open-in-OS-browser, favicons,
  `target=_blank` becomes a new preview tab.
- **Omnibox**: Chrome-style normalization — search terms → real Google search
  (genuine browser fingerprints, real Google UI), bare hosts → https, localhost
  → http.
- **New-tab page**: live port detection (`/api/localhost-probe` TCP probes
  3000/5173/8080/4200 every 10s) — click a dotted port to open a running dev
  server with working HMR websockets (no proxy involved).
- **Failure surfaces**: `did-fail-load` error codes mapped to honest copy
  (DNS, refused, timeout, offline, SSL) with Retry / Open-in-Chrome actions.
- **Agent mirror**: the agent's own browser view appears as an "Agent Browser"
  tab and can be watched live.
- Deliberately **no iframe/proxy fallback**: the desktop app renders everything
  natively; without the shell the panel says "Desktop app required".

## 3. Agent Browser Automation (`browser_*` tools)

The agent gets a dedicated WebContentsView (visible to the user) driven over
IPC — the full op set: `browser_navigate`, `browser_read`, `browser_find`,
`browser_click`, `browser_type`, `browser_select`, `browser_hover`,
`browser_press`, `browser_scroll`, `browser_wait_for`, `browser_tabs`,
`browser_console`, `browser_network`, `browser_screenshot`,
`browser_evaluate`.

- Read returns URL/title/text/headings plus **links, buttons, and inputs with
  selectors** for follow-up actions.
- **`browser_find` is the precision path**: it enumerates visible actionable
  elements with ARIA-ish roles, accessible names, and *stable CSS selectors*
  (id / data-testid / nth-of-type paths), returning refs `e1…eN`. Click/type/
  hover/select accept a `ref` instead of a selector — no CSS guessing on
  minified or generated markup. Stale refs (element gone after navigation)
  return an actionable "run browser_find again" error; the find snapshot is
  reset on every navigation and tab switch.
- Click/type fall back from exact CSS to **text/aria-label/placeholder
  matching**; typing uses the React-safe prototype value setter; clicking fires
  realistic pointer/mouse event sequences.
- **`browser_wait_for`** waits for text to appear, a selector to become
  visible, or a fixed delay (capped 15s) — the anti-pattern it replaces is
  blind read-retry loops after SPA clicks.
- **`browser_tabs`** manages up to 4 tabs (list / new [with URL] / switch /
  close); console and network capture attach to every tab, not just the
  first. All navigation — including new-tab URLs — passes the SSRF policy.
- **`browser_network`** exposes failed requests: HTTP 4xx/5xx responses and
  aborted requests in a bounded ring (60 events) — the diagnosis path for
  "page loads blank / data missing".
- **`browser_screenshot`** takes `fullPage` captures and named viewports
  (`desktop` 1280×720 · `tablet` 768×1024 · `mobile` 390×844) so the agent can
  verify responsive layouts itself.
- **`browser_evaluate`** runs page JS and auto-retries multi-statement
  snippets wrapped as an IIFE when the bare expression fails.
- Console messages are captured in a per-view ring buffer (agent's eyes on page
  errors).
- **Non-desktop parity**: `src/lib/agent-browser-session.ts` + `/api/agent/browser`
  run the identical op set through headless Playwright (installed Chrome when
  present), with SSRF guards enforced pre-session AND at the network layer,
  per-user sessions, session/tab caps, bounded logs, and idle reaping — the
  model sees one identical tool contract in both environments. Op/argument
  validation fires before any browser launch.
- **Desktop lane parity**: the Electron bridge
  (`window.orplexDesktop.agentBrowser`) implements the SAME op set natively —
  find (page-side discovery script storing the ref snapshot main-side),
  wait_for (page-polling with timeouts), hover/select (shared resolver with
  interact), tabs (up to 4 agent-owned views; refs reset on tab switch), and
  network telemetry via the CDP Network domain (4xx/5xx + non-aborted
  failures, bounded ring per view). Ref targeting (e1…eN) resolves main-side
  in both lanes; snapshots reset on navigation and tab switch in each.
  Screenshot supports fullPage (single grow-the-view capture + restore) and
  named viewports (desktop/tablet/mobile) in both lanes.

## 4. Streaming Agent Chat + Tool Loop

`background-worker.ts` runs the tool-calling loop client-side as a background
singleton (survives navigation/reload via `background-chat.ts` snapshots).
Both execution modes (this worker + the claimed server executor in
`server-executor/executor.ts`) import their shared tool-loop logic from ONE
place — `src/lib/agent/contract/` (tool arg rules, risk tiers, loop
detection, scratchpad, browser backends, result formatting). Neither loop
re-implements tool logic; backends (Electron IPC, Playwright) plug in at the
edges.

- **Context building** (`context-builder.ts`, `client-signatures.ts`): M3-aware
  workspace context — full contents for small repos, signature tiers for large.
- **Budgeting**: token estimation, `fitMessagesToBudget` (line-boundary caps
  with explicit cut markers), rolling-60s TPM pacing (`reserveTokenWindow`),
  and **summarizing compaction** (`compaction.ts`) — evicted turns become a
  `<context_so_far>` summary instead of disappearing.
- **Streaming**: `stream-reader.ts` parses native `tool_calls` + thinking and
  legacy XML tags; `tool-text.ts` dedups word-repetition pathologies, strips
  redundant fences, normalizes thinking blocks, repairs interleaved replays.
- **Safety caps**: 120 tool turns, streak-based loop detection
  (`loop-detect.ts` — identical call 3x, same target with noisy args 4x, the
  same multi-call turn 3x, or one state-changing tool 5 turns in a row — all
  trip BEFORE dispatch; read-only exploration is exempt from the tool streak).
  Loop trips self-heal once with an evidence-carrying `[LOOP BREAK]` directive
  (repeated call + its last result + "no progress claims without a successful
  write/edit"); a second trip stops the task with an honest note. Write and
  turn caps still become a "keep going?" question (max 5 extensions).
- **Anti-laziness gates**: FORCE-TOOLS nudge when a build request produced no
  writes; SPARC plan-first gate (plan + read before write) on complex tasks.
- **Scratchpad**: `scratchpad_update` writes private working memory
  (plan/hypotheses/findings/next) re-injected into every turn
  (`scratchpad.ts`) — complex tasks start seeded, others get a
  `[SCRATCHPAD]` nudge at turn 2; the RightPanel Scratch tab renders it.
  Never a user-facing deliverable; the server executor gets the same tool.
- **Modes**: ask · code · plan (hard plan-approval gate before any write) ·
  self-review pass with one repair turn after the loop.
- **Failure learning**: `failure-memory.ts` + persistent `run-ledger.ts`
  (Postgres via API) re-seed new tasks with what actually failed last time;
  `master-prompt.ts` renders the Adaptive Failure Doctrine.
- **Low-memory honesty**: `memory-note.ts` probes the local
  `/api/system/memory` route (500 ms budget, degrades to null) and the worker
  appends "Low memory: system RAM at NN% used" to failure messages, so
  RAM-pressure deaths say why they happened.

## 5. Tool Belt (what the agent can do)

`tool-definitions.ts` + `agent/native-tools.ts` + `tool-handlers.ts`:
`read_file` (line ranges, deduped), `write_file` (+chunked), `edit_file`,
`batch_edit`, `list_files`, `search_code` (real server-side grep —
`grep-search.ts`, ripgrep→grep→Node fallback chain), `run_command`,
`run_in_sandbox`, `undo_last_change` (serve commands passed to `run_command` are
auto-detected and detached — there is no separate serve tool),
`web_search` (Google→Bing RSS chain, `/api/search`), `take_screenshot`,
`preview_browser`, `verify_app`, `todo_list`, `ask_question`, `scratchpad_update`, plus the full
`browser_*` set. Every tool result is explicit XML — unknown tools error
instead of hanging.

- **Exec security**: `exec-guard.ts` screens command text against
  env-assignment/encode-pipe tricks beyond the static blocklist in
  `constants.ts`; hosted deployments run with `AGENT_EXEC_DISABLED=1`.
- **Risk gating**: `risk-classifier.ts` → low auto-approved, medium approval
  dialog (`approval-store.ts` + `ApprovalDialog`), high forced review.

## 6. Verification Lanes (prove it works)

- **Typecheck lane**: after UI-relevant writes the worker runs
  `npx tsc --noEmit` in the workspace and feeds failures to a repair turn
  (max 2 rounds).
- **Browser lane**: `browser-verification/index.ts` + `/api/agent/verify` —
  spawns the project's dev server (command picked by `ui-paths.ts`: Next/Vite/
  static), loads the page in headless Chromium, captures console
  errors/warnings + screenshot + **replayable walkthrough** (`walkthrough.ts`:
  navigate → interactions → screenshot frames). Failures trigger one model
  repair turn, then re-verify. URL policy: default private-host/metadata
  SSRF denylist + allow/denylists.
- **Server-executor parity**: `server-executor/executor.ts` implements the same
  lanes for claimed runs (see §8), plus auto-checkpointing, tool-hooks, MCP,
  and review artifacts.

## 7. Files: History (exactly two layers) + Checkpoints as Snapshots

- **Layer 1 — working/session history**: `file-history.ts` (50-entry snapshots,
  sessionStorage mirror) powers `undo_last_change` and the Changes tab.
  Short-lived, UI-facing.
- **Layer 2 — durable history**: `workspace-history.ts` appends every change to
  `<workspace>/.orplex/history.jsonl`; `/api/agent/history` GET/PUT undo
  survives tabs, days, and machines. Path containment enforced (`safeJoinWorkspace`).
- **Checkpoints are snapshots OF Layer 2, not a parallel system**:
  `checkpoints.ts` + `auto-checkpoint.ts` — before first mutating write per
  file, a restorable snapshot (git tree-commit under
  `refs/orplex/checkpoints/<runId>/<n>` or shadow-clone JSON) that records its
  Layer-2 offset (`historyLength`); restore appends inverse entries to the
  durable history, so restore is itself undoable via `/api/agent/history`.
  `checkpoint-sync.ts` pushes ONLY the checkpoint namespace to the workspace's
  own remote (opt-in).
- **Parallel workspaces**: `parallel-workspaces/index.ts` + `server-executor/
  worktree.ts` — each agent task gets its own git worktree (or directory
  copy); `merge/crdt.ts` is a line-level CRDT (peerId+lamport identities,
  tombstones, property-tested convergence) for merging results.

## 8. Manager Board, Runs, Missions, Morning Queue

- **AgentRun rows** mirror live tasks (`run-sync.ts`) and are claimed by the
  server executor: `agent/runtime/{scheduler,service}` + `/api/agent/runs/claim`
  (CAS claim — two tabs can never take one run). Stuck runs are swept
  (ghost-run reaper).
- **Manager UI** (`/manager`, `RunBoard`, `RunTimeline`, `RunLiveStatus`,
  `AgentManager`, `AgentProgress`, `StepList`, `AgentActivityLog`): board feed
  with statuses, pending approvals, token/cost estimates, per-run event
  timeline (cursor feed — never misses/duplicates events).
- **Missions**: `/api/agent/missions` — one parent run + N child runs grouped
  on the board, children inherit parent context with a subtask prepended.
- **Morning queue**: `/api/agent/runs/batch` — up to 8 prompts scheduled at
  staggered times; the queue runner (`queue-runner.ts`, idle browser tab)
  claims and executes them serially; each lands on its own branch.
- **Server approvals**: risky actions in claimed runs pause on the
  ApprovalRequest table; decide from anywhere via `/api/agent/runs/[id]/approve`.
- **Artifacts + review chain**: runs emit artifacts (`/api/agent/artifacts`)
  with review status (draft→reviewed→approved/rejected) and inline comments
  that reach the agent's next prompt (`CommentInput`, `ArtifactCard`,
  `ReviewStrip`, `BranchReviewPanel`).
- **Flight recorder**: `/api/agent/runs/[id]/export` builds a self-verifying
  bundle (hash-chained events, artifacts, manifest.md — `audit-bundle.ts`)
  with a `/verify` endpoint for tamper checks.
- **Worktrees/merge**: `/api/agent/runs/[id]/merge` previews/applies merges.

## 9. Memory (exactly three permanent buckets + one ephemeral scratchpad)

All writes go through the tiny API in `memory.ts` (`remember`,
`record_failure`, `update_scratchpad`, `captureFromCompaction`,
`postRunToLedger`); readers query the same buckets. No lane touches memory
tables directly.

| Bucket | File | Purpose |
|---|---|---|
| Project instructions | `project-memory.ts` | User-owned `orplex.md` hierarchy injected into system prompts (CLAUDE.md parity), token-disciplined |
| Workspace learnings | `workspace-memory.ts` (+client) | Evidence-backed memories derived server-side from completed runs; score-based retrieval (path overlap + recency); `/remember <fact>` pinning; forget API; eviction capture folded in here |
| Run / failure ledger | `run-ledger.ts` (persistent client) + `failure-memory.ts` (session doctrine) | What actually failed and why; learning survives restarts |
| Scratchpad (ephemeral) | `scratchpad.ts` | Current plan / hypotheses / findings / next — per-task only, never persisted |

Folded away (no parallel stores): `compaction-memory.ts` is a re-export shim
over the learnings bucket; the playbook is a derived view (search reads
playbooks + learnings together, executor `playbook_search` merges both);
`semantic-cache.ts` is deprecated with zero callers (similar tasks surface via
learnings + ledger). `memory-note.ts` probes local RAM for failure annotation.

## 10. Models & Providers

- **Provider registry** (`provider-registry.ts`): single source of truth —
  OpenRouter, NVIDIA, OpenAI, Anthropic (OpenAI-compatible), MiniMax… adding a
  provider is one entry.
- **AI layer** (`ai-providers.ts`): OpenAI-compatible base adapter, streaming,
  one-adapter-many-ecosystems; `retry.ts` for transient 504/429 blips;
  `circuit-breaker.ts` (+ Postgres auto-reset) per provider; `key-pool.ts`
  round-robin keys with quota tracking; `key-encryption.ts` at rest.
- **Model routing** (`model-router.ts`): 3-tier task routing.
- **Live catalog** (`model-catalog.ts` + `/api/models/available`): probes every
  platform-provider model with a real completion — only answering models are
  listed; cold-start models tagged `cold`.
- **BYOK** (`provider-models.ts`, `/api/settings/keys*`): user keys list their
  own live models (cached, key never stored/logged); prompt-bar picker merges
  platform + user models.
- **Free-tier discipline**: `free-tier/quota-manager.ts`, `rate-limiter.ts`
  (sliding window), `rate-limit-store.ts`, `tpm-pacer.ts` (process-wide token
  bucket shared by ALL callers so concurrent runs can't blow the account TPM),
  `prompt-meter.ts` (per-task full-vs-compact prompt accounting),
  `cost-estimator.ts`, `spend-format.ts` + `/api/agent/spend` (cost dashboard
  with SVG chart), `/api/free/*` signup/usage.
- **Mock AI** (`mock-ai.ts`): `MOCK_AI=1` deterministic keyless stream for dev
  and E2E.
- **Skills catalog**: `skills.ts` — 100+ built-in coding skills with frontmatter
  menus; `user-skills.ts` discovers `.orplex/skills/<name>/SKILL.md`.

## 11. Extensibility: Plugins, Hooks, MCP

- **Plugin system**: `plugins/{types,registry,initializer,server-middleware}` —
  tools, hooks, and route protection; 26 built-ins under `plugins/builtin/`:
  API scaffold, build watcher, code review, complexity estimator, cost tracker,
  DB migration, dep updater, doc gen, docker scaffold, export manager, git
  auto-commit, input sanitizer, linter, logger, memory sync, model-router
  config, file-edit hooks, path traversal guard, pattern learner, prompt
  enhancer, response cache, secret scanner, task queue, test gen, type
  checker, UI components.
- **Plugin bundles**: `plugin-bundles.ts` + `/api/agent/plugins` — install
  skills+hooks+MCP as one data-only `.orplex-plugin.json` unit.
- **Built-in plugin library**: `plugin-library.ts` + `/api/agent/plugin-library`
  + the Plugins page — 5 one-click installable built-ins (quality, security,
  devops, domain, intelligence) materialized through the SAME installPlugin()
  path (existing user files always win), with content-based installed
  detection. Hook rules compile and enforce through the production
  tool-hooks path and are unit-tested. Per-workspace enable/disable lives
  in `.orplex/bundles.json` — the Plugins page toggles a bundle's hook
  rules on/off without deleting its skill files; enforcement merges only
  enabled, physically installed bundles (installed-but-unknown defaults
  to on, corrupt state falls back to catalog defaults).
- **Declarative hooks**: `tool-hooks.ts` — `orplex.config.json` deny/notify
  rules for both agent loops.
- **Command hooks**: `user-hooks.ts` — `.orplex/hooks.json` commands run
  through exec-guard with timeouts, caps, and `ORPLEX_HOOK_*` env.
- **MCP**: `mcp-client.ts` (150-line wire-protocol stdio client, low-spec
  budget), `mcp-gateway.ts` + `/api/mcp` (token-gated, timing-safe) with
  `scripts/orplex-mcp-server.mjs` stdio proxy — drive Orplex from any MCP host.
  Hardened: argv/URL validation in connectServer, spawn re-check, session key
  by user, Electron SSRF gates, OAuth verifier encryption, scope wipe on
  needs_reauth/disconnect, verify-fail wipes grant, strict risk booleans,
  catalog OAuth entries fixed, plugin-bundles prototype guards, hub waiter
  settlement, transport regex fix, native arg pass-through, executor
  target-wins ordering.

## 12. Terminal & Dev Servers

- **Persistent shell** (`shell-session.ts`, `/api/agent/terminal/session`):
  real shell per user — `cd`/env persist, servers keep running, SSE streaming
  to the RightPanel Terminal tab (up/down history, Ctrl+L clear, Esc abort).
- **One-shot exec** (`/api/agent/exec`) and **serve lane** (`/api/agent/serve`):
  long-running servers detach (never burn exec timeouts), tracked in a
  registry, port-conflict hints (`diagnosePortConflict`).
- **Workspace CWD** (`workspace-cwd.ts`): the renderer registers the user's
  real folder; every command lane executes there, not in Orplex's own dir.
  Workspace file access follows the Freebuff model: opening a folder only
  maps the tree (paths are cheap) — no bulk indexing. The AI reads files on
  demand from disk (oversized files return a ~200 KB window), search runs
  server-side via ripgrep/git-grep/node-scan (`grep-search.ts`), and the
  renderer keeps only a ~10 MB LRU hot-set with anti-clobber write guards.

## 13. Admin, Ops, Observability

- **Admin area** (`/api/admin/*`, admin pages): backups (`backup.ts` pg_dump
  rotation, Windows-safe, manual trigger), keys, usage, system snapshot
  (executor state, cron, TPM pacer, hardware, event ring), janitor control,
  health.
- **Runtime state** (`runtime-state.ts`/`runtime-log.ts`): globalThis
  singletons survive dev-bundle duplication; ring-buffer logs.
- **Hardware watchdog** (`hardware.ts`): RAM pressure ladder (70/85/92%) —
  pause claims, shed lanes, janitor sweep — before Windows OOM-kills.
- **Janitor** (`janitor.ts`): whitelist-only deletion of re-creatable
  artifacts (caches, oversized logs, >24h orphaned tmp worktrees); protected
  paths refused.
- **Instrumentation** (`instrumentation.ts`): boots watchdog, executor, janitor
  sweep, backup schedule at server start.
- **Cron**: `cron-reset.ts` (advisory-locked daily quota reset).
- **Graceful shutdown**: `graceful-shutdown.ts` cleanup registry.
- **Error tracking**: `error-tracking.ts` (Bugsink/Sentry SDK protocol).
- **Logging**: `logger.ts` (Pino + pretty in dev).
- **Audit bundle**: hash-chained per-run export (see §8).

## 14. Sync, Storage, Deployment

- **Peer sync**: `sync-transport.ts` + `/api/sync/{push,pull}` — signed gzip
  envelopes move checkpoint refs and file-history between machines via a hub.
- **Blob storage**: `storage-service.ts` — content-addressed sha256 chunks
  (local `.orplex/storage/` or any S3-compatible endpoint), dedup + GC.
- **Local database (optional)**: the desktop shell boots an embedded
  Postgres (`.localpg/`, port 5433) for local-only/offline mode. Cloud
  setups set `ORPLEX_LIGHTWEIGHT=1` (repo `.env`) to skip it — ~30s faster
  boot and one less failure class (port conflicts, stale clusters). Nothing
  in cloud mode needs it: page loads, local-only routes, and the full jest
  suite pass with port 5433 down.
- **Deploy targets**: Vercel (`vercel.json`), Fly (`fly.toml`), Railway,
  Render, Docker (`Dockerfile.deploy`, `Containerfile`, `podman-compose.yml`);
  split-frontend/API mode via `NEXT_PUBLIC_API_BASE_URL` (`api-base.ts`).
- **HTTP gatekeeper + cloud API forward**: `src/proxy.ts` (formerly
  middleware.ts) — Edge JWT page auth, dynamic credentialed CORS, CSRF
  (content-type/XRW + origin checks), request-ID/timing headers, CSP.
  EVERY `/api/*` request is rewritten to the cloud backend (`ORPLEX_API_URL`,
  else `NEXT_PUBLIC_API_BASE_URL`) so the browser stays same-origin —
  first-party cookies, zero CORS — while the real handlers run in the cloud;
  with no origin configured the local handlers serve instead.
  `LOCAL_ONLY_API_ROUTES` opts machine-local diagnostics out (currently
  `/api/system/memory` — the cloud would report Vercel's RAM, not the
  user's). Auth-heartbeat forwards fail soft as JSON 503 instead of the
  plain-text 500 that breaks the next-auth client; a cached HEAD probe
  (30s ok / 5s fail) gates the rewrite decision.

## 15. UI Surface (every panel & page)

- **Chat page** (`/`): ChatInput (attachments, drag-drop, images, model
  picker), PromptBar (slash skill menu + model picker, 50-row chunked
  scroll-to-load menus), MessageList/MessageContent/MarkdownRenderer,
  ThinkingCard
  (collapsible reasoning), ToolCallDisplay, ThoughtStream/ThoughtLine,
  QuestionCard (agent questions), ApprovalDialog, TodoBar, QuotaIndicator,
  PromptMeterStrip, WelcomeSection + Onboarding, VirtualList (long chats),
  LatticeLoader, ProgressBar, Skeletons.
- **RightPanel**: Queue · Changes (hunk review) · Files (tree + filter) ·
  Preview (native browser) · Terminal (persistent shell) · Scratch (agent
  working memory). Resizable grip
  (double-click reset), tab persistence, per-tab error boundary.
- **Manager** (`/manager`): RunBoard (batch, approvals, missions, provider
  badge), RunTimeline, RunLiveStatus, QueueRunnerProvider (idle-tab claimer).
- **Other pages**: /history (conversation history), /runs, /settings (keys,
  models, provider & cost dashboard), /plugins (bundles), /packages, /admin
  (system/keys/usage/backups/janitor/health), /auth/signin.
- **Shared**: Sidebar (recent chats), Header/TopBar (search), CommandPalette,
  ThemeProvider/ThemeInit, Toast, AppProviders/AppLayout, Icons
  (@hugeicons), FilePreviewModal, CodeEditor (Monaco), MemoryPanel,
  ConflictCard, BugReportModal (mailto transporter, lazy), DragDropZone,
  FileUpload.
- **Hooks**: useChatSession, useBackgroundChat, useConversation, useMessages,
  useFileSystem (+FileSystemProvider), useFileProcessor, useHunkDecisions
  (+HunkDecisionProvider), useKeyboardShortcuts (Ctrl+T preview etc.),
  useActiveRunCount, useBootProgress, useReducedMotion.
- **Misc UX**: `navigation-events.ts` (sidebar→chat deep links),
  `walkthrough` narration on artifacts, brand fonts self-hosted
  (`scripts/fetch-fonts.mjs`).

## 16. Auth & Multi-user

NextAuth (Google/GitHub) with Prisma adapter; Edge JWT checks in proxy.ts;
split-domain cookies (`AUTH_COOKIE_DOMAIN`); dev bypass
(`/api/dev/session`, `dev-seed.ts` seeds non-empty UI states, disabled in
production); workspaces with owner/admin/member roles
(`/api/workspace/*`, `/api/workspaces/*` incl. parallel-workspace
create/destroy/merge); users' own API keys per provider; quotas per tier.

**Security posture**:
- 7-day session maxAge with daily rotation (`updateAge: 24h`) — stolen cookies
  expire within a week even if the user never signs out.
- `allowDangerousEmailAccountLinking` disabled — OAuth providers cannot
  auto-link to existing accounts by email.
- Desktop OAuth flow uses double-submit cookie binding (`orplex_desktop_flow`)
  to prevent login CSRF — only the browser that initiated the flow can arm
  the one-time code.
- Desktop auth routes are rate-limited by client IP (`clientIp()` helper:
  x-real-ip first, x-forwarded-for fallback).
- Admin surface fails closed: `ADMIN_USER_IDS` unset in production denies all
  admin access (loudly, so it reads as misconfiguration).
- MarkdownRenderer allowlists `https:`/`mailto:` for links and
  `https:`/`data:image/` for images — `javascript:`/`data:` URIs are stripped.
- Electron `setWindowOpenHandler` only allows `http(s):` URLs — `file:`,
  `javascript:`, and custom schemes are denied.
- Sync hub signatures use timing-safe comparison (double-hash) — no timing
  oracle for HMAC verification.

## 17. Quality Infrastructure

- **Eval harness**: `eval/` — 52 tasks across 10 categories (type errors,
  logic bugs, React bugs, API routes, security, performance, error handling,
  API integration, refactors, new features), exact + fuzzy scoring, CLI
  (`eval/cli.ts`), runs against a virtual FS.
- **Hard verdicts + rubric recorder**: `rubric-recorder.ts` — grades live runs
  against the master-prompt rubric into JSONL. Every finished run gets a
  binary PASS/FAIL verdict (`computeVerdict`: done AND no failed lane —
  skipped lanes never fail) with exit-code evidence; verdict-first trend
  reports catch prompt regressions.
- **Agent CI (headless executor battery)**: `scripts/agent-ci-run.mjs` +
  `.github/workflows/agent-ci.yml` — boots the REAL server executor (lease →
  worktree → tool loop → verify lane → commit) against a throwaway embedded
  Postgres with the model replaced by a deterministic fixture provider
  (`AI_PROVIDER=ci-fixture`, scripted turns via `AgentRun.modelOverride`).
  Fixed task battery; each task gets a HARD verdict from behavior checks run
  against the produced output — an LLM's "looks done" never counts. The
  battery opens with DETERMINISTIC GATES (tsc, jest, eslint — judged only by
  exit codes) and refuses to run when any fails.
- **CI sandboxed exec**: `ci-sandbox.ts` + `.github/workflows/agent-sandbox.yml`
  — when local exec is disabled (hosted), `run_command` dispatches to an
  ephemeral GitHub Actions runner and returns the artifact-embedded
  stdout/stderr/exit-code. Correlated by a run-name token; same exec-guard
  screening as local.
- **Benchmark report**: `benchmark-report.ts` + `npm run bench:report` —
  cost-adjusted aggregation over TaskRun rows (pass rate, hard-verdict mix,
  lane health, duration percentiles, estimated USD via cost-estimator;
  per-hard-PASS cost is the headline number).
- **SWE-bench Lite harness**: `scripts/swe-bench/` +
  `.github/workflows/agent-swe-bench.yml` — fetches instances from the HF
  datasets-server, shards across matrix jobs, verifies FAIL_TO_PASS tests are
  red before any patch, then applies a gold patch (harness smoke test) or an
  agent command hook (`ORPLEX_SWE_AGENT_CMD`) and verifies green. Documented
  caveat: measures the dataset's own test commands on plain clones — not the
  official dockerized evaluation.
- **Tests**: 123 Jest suites (~1205 tests) under `src/**/__tests__`; Playwright
  E2E (`e2e/chat.spec.ts`, `e2e/seed.spec.ts`) using the mock-AI seam.
- **Custom ESLint rules**: `tools/eslint-rules/`; wiring auditor
  (`scripts/audit-wiring.mjs`).
- **Companion surfaces**: `cli/` (Orplex CLI), `vscode-extension/` (chat
  sidebar, code lens, inline chat, diagnostics), `docs-site/` (Docusaurus),
  `logo/` (widget).

---

# Module Map

## `src/lib/` — Core

| File | Purpose |
|---|---|
| `constants.ts` | All magic numbers, timeouts, limits, blocked commands |
| `types.ts` | Branded types, discriminated unions, type guards |
| `errors.ts` | AppError hierarchy (ValidationError, RateLimitError…) |
| `validators.ts` | Zod schemas + sanitization + injection detection |
| `logger.ts` | Pino logging |
| `prisma.ts` | Prisma singleton (PgBouncer-aware) |
| `graceful-shutdown.ts` | SIGTERM/SIGINT cleanup registry |
| `error-tracking.ts` | Bugsink/Sentry integration |
| `api-base.ts` | Same-origin/split API base resolution |
| `navigation-events.ts` | Conversation deep-link events |
| `lazy-modules.ts` | Deferred heavy imports (tree-sitter…) |
| `tool-text.ts` | Shared pure string/parse helpers |
| `message-content.ts` | Pure assistant-content segment parser (status/result pills, thinking, tool cards) — unit-testable, no React |

## `src/lib/` — Agent loop & prompts

| File | Purpose |
|---|---|
| `background-worker.ts` | The main client-side tool-calling loop |
| `background-chat.ts` | Global chat store (survives navigation/reload) |
| `agent-events.ts` | Status/activity/preview event emission |
| `stream-reader.ts` | SSE parsing: native tool_calls + XML, thinking |
| `master-prompt.ts` | Single source of truth for every system prompt + doctrines |
| `tool-definitions.ts` | OpenAI function schemas for all tools |
| `tool-handlers.ts` | Extracted tool handlers |
| `agent/native-tools.ts` | Tool dispatch via the shared contract (+ Electron IPC transport) |
| `agent/contract/` | THE shared tool-loop contract: `tools` (arg rules), `risk`, `loop`, `scratchpad`, `browser` (one op set, Electron + Playwright backends, one result formatter), `results`, `index` barrel — used by both execution modes |
| `memory.ts` | Tiny memory API (all writes go through here — see §9) |
| `agent/file-ops.ts` | Audited write/edit path |
| `agent/serve-helpers.ts` | Server-command detection, port-conflict hints |
| `agent/runtime/*` | Run scheduler + service (claiming, sweeping) |
| `context-builder.ts` | M3 context windows (full vs tiered) |
| `client-signatures.ts` | Regex signature extraction for context |
| `compaction.ts` | Transcript compaction under TPM budget |
| `compaction-memory.ts` | SHIM — re-exports eviction capture from the learnings bucket (no separate store) |
| `failure-memory.ts` | Adaptive failure doctrine state |
| `run-ledger.ts` | Persistent run/failure ledger client |
| `scratchpad.ts` | Agent private working memory (plan/hypotheses/findings/next), re-shown every turn |
| `loop-detect.ts` | Streak loop detection (identical-call + same-target + repeated-turn + same-tool, O(1)) + `[LOOP BREAK]` directive builder |
| `memory-note.ts` | Low-memory failure annotation (local `/api/system/memory`, degrades to null) |
| `prompt-meter.ts` | Full-vs-compact token accounting |
| `tpm-pacer.ts` | Global TPM token bucket |
| `queue-runner.ts` | Idle-tab claiming of scheduled runs |
| `risk-classifier.ts` | Tool risk tiers |
| `plan-gate.ts` | Plan-mode approval latch |
| `approval-store.ts` | Pending approval registry |
| `reflection-loop.ts` | Self-correcting generation |
| `code-quality-checker.ts` | Static quality scoring |
| `code-generators.ts` | Tests/security/perf/docs generation |
| `vision-preprocessor.ts` | Image prep for vision models |
| `walkthrough.ts` | Replayable verification walkthroughs |
| `rubric-recorder.ts` | Live-run rubric grading + trends |
| `board-format.ts` / `spend-format.ts` | Pure UI presentation helpers |
| `ui-paths.ts` | UI-work detection, verify port, dev-command picker |

## `src/lib/` — Reasoning & orchestration

| File | Purpose |
|---|---|
| `strategy-router.ts` | Deterministic strategy pick + all 5 strategies (replaced sparc/tot/swarm/blueprint/m3-client) |
| `semantic-cache.ts` | DEPRECATED — zero callers (learnings + ledger cover it); exports kept for tests, scheduled for deletion |
| `model-router.ts` | 3-tier task→model routing |
| `semantic-cache.ts` | Similar-task response cache |
| `cost-estimator.ts` | Pre-run cost estimation |
| `benchmark-report.ts` | Cost-adjusted aggregation over the TaskRun ledger |

## `src/lib/` — Providers & keys

| File | Purpose |
|---|---|
| `ai-providers.ts` | OpenAI-compatible adapters + streaming |
| `provider-registry.ts` | Canonical provider defs |
| `provider-models.ts` | BYOK live model listing/verification |
| `model-catalog.ts` | Platform model probing for the picker |
| `retry.ts` | Transient-error retry helpers |
| `circuit-breaker.ts` / `circuit-breaker-reset.ts` | Provider resilience + SQL auto-reset |
| `key-pool.ts` / `key-encryption.ts` | Key pooling + encryption at rest |
| `chat-middleware.ts` | Composable chat API validation chain |
| `mock-ai.ts` | Keyless mock stream (dev/E2E) |
| `skills.ts` / `user-skills.ts` | 100+ built-in skills + user SKILL.md |
| `free-tier/quota-manager.ts` | Tier quotas |

## `src/lib/` — Browser & verification

| File | Purpose |
|---|---|
| `agent-browser-session.ts` | Server-side Playwright browser_* sessions: multi-tab, find/ref targeting, wait_for, network telemetry, viewport screenshots |
| `browser-verification/index.ts` | Dev-server boot + Playwright verify harness, URL policy |

## `src/lib/` — Files, history, checkpoints

| File | Purpose |
|---|---|
| `virtual-fs.ts` | In-memory FS for agent/evals |
| `file-history.ts` | Session undo snapshots |
| `file-adapter.ts` | Compat barrel |
| `file-utils.ts` / `file-download.ts` | File helpers / markdown export |
| `diff-hunks.ts` | Unified diff → accept/reject hunks |
| `workspace-history.ts` | Durable JSONL change history |
| `checkpoints.ts` / `auto-checkpoint.ts` / `checkpoint-sync.ts` | Restorable snapshots, auto policy, remote sync |
| `parallel-workspaces/index.ts` | Per-task worktrees/copies |
| `merge/crdt.ts` | Line-level CRDT for merges |
| `workspace-cwd.ts` | Real workspace path registry |
| `workspace/workspace-manager.ts` | Workspace CRUD/queries |
| `workspace-memory.ts` / `workspace-memory-client.ts` | Learnings store + browser client |
| `project-memory.ts` | orplex.md injection |

## `src/lib/` — Execution, servers, search

| File | Purpose |
|---|---|
| `server-executor/executor.ts` | Claims + executes Manager runs (full lane parity) |
| `server-executor/review.ts` | Review artifact generation |
| `server-executor/verify-gate.ts` | Verification gating + per-run ports |
| `server-executor/worktree.ts` / `worktree-helpers.ts` / `executor-config.ts` | Git worktree plumbing |
| `shell-session.ts` | Persistent per-user shells |
| `exec-guard.ts` | Command screening |
| `grep-search.ts` | Real code search (rg→grep→Node chain) |
| `tool-hooks.ts` / `user-hooks.ts` | Declarative + command hooks |

## `src/lib/` — Extensibility & infra

| File | Purpose |
|---|---|
| `plugins/*` (+26 builtins) | Plugin system |
| `plugin-bundles.ts` | Bundle install units |
| `mcp-client.ts` / `mcp-gateway.ts` | MCP stdio client + gateway auth |
| `hardware.ts` / `janitor.ts` | RAM watchdog / whitelist cleanup |
| `runtime-state.ts` / `runtime-log.ts` | Cross-bundle singletons + ring logs |
| `backup.ts` / `cron-reset.ts` | Backups / quota reset |
| `storage-service.ts` / `sync-transport.ts` / `checkpoint-sync.ts` | Content blobs / peer sync |
| `audit-bundle.ts` | Hash-chained flight recorder |
| `run-sync.ts` | Live→AgentRun mirroring |
| `rate-limiter.ts` / `rate-limit-store.ts` | Sliding-window limits + `clientIp()` helper |
| `desktop-auth.ts` | Desktop OAuth one-time codes + flow cookie binding |
| `playbook.ts` | Learning loop: derive/merge/search playbooks from completed runs |
| `admin-auth.ts` | Admin gate (fails closed in production when unset) |
| `dev-seed.ts` / `client-signatures.ts` | Dev data / signatures |
| `user-hooks.ts` / `user-skills.ts` | User extension files |

## `src/components/` (77)

Chat: `ChatInput`, `MessageList`, `MessageContent`, `MarkdownRenderer`,
`ThinkingCard`, `ThoughtStream`, `ThoughtLine`, `ToolCallDisplay`,
`QuestionCard`, `ApprovalDialog`, `TodoBar`, `VirtualList`, `WelcomeSection`,
`Onboarding`, `ModeSelector`, `PromptBar`, `QuotaIndicator`, `PromptMeterStrip`,
`FileUpload`, `DragDropZone`, `FilePreviewModal`.
Right panel: `RightPanel` (browser/tabs/changes/files/terminal/scratch),
`DiffView`,
`CodeEditor`, `Terminal`.
Runs: `AgentManager`, `RunBoard`, `RunTimeline`, `RunLiveStatus`, `StepList`,
`AgentProgress`, `AgentActivityLog`, `ReviewStrip`, `BranchReviewPanel`,
`ArtifactCard`, `ArtifactPanel`, `CommentInput`, `ConflictCard`, `MemoryPanel`,
`QueueRunnerProvider`.
Shell: `AppLayout`, `AppProviders`, `Providers`, `Sidebar`, `Header`, `TopBar`,
`CommandPalette`, `ThemeProvider`, `ThemeInit`, `Toast`, `Icons`, `Skeleton`,
`PanelSkeletons`, `ProgressBar`, `LatticeLoader`, `FileSystemProvider`,
`HunkDecisionProvider`, `ConversationProvider`, `BugReportModal`,
`AuthProvider`.
Families: `ui/` (`AgentStatus`, `AISuggestions`, `FileTree`,
`KeyboardShortcuts`, `ModelSelector`, `OnboardingTour`, `QuickActions`,
`SplitView`, `TaskProgress`), `loader/` (`BootGate`, `BrandSpinner`,
`GeometricLoader`).

## `src/hooks/` (13)

`useChatSession`, `useBackgroundChat`, `useConversation`, `useMessages`,
`useFileSystem`, `useFileProcessor`, `useHunkDecisions`,
`useKeyboardShortcuts`, `useActiveRunCount`, `useBootProgress`,
`useReducedMotion`, `useProjects`, `useScratchpad`.

## API Routes (87 handlers)

**Core**: `/api/chat` (+`/chat/fast`), `/api/conversations` (+`[id]`),
`/api/health`, `/api/auth/[...nextauth]`, `/api/debug/user`, `/api/dev/session`,
`/api/notifications`, `/api/bug-report`, `/api/open-external`,
`/api/localhost-probe`, `/api/system/memory` (local-only, never forwarded).
**Models/keys/settings**: `/api/models/available`, `/api/models/warm`
(cold-start wake engine), `/api/settings`, `/api/settings/keys` (+`/models`).
**Workspaces**: `/api/workspace` (+create/delete/invite/members/update-member),
`/api/workspaces/create|destroy|merge`, `/api/workspace-file`.
**Agent (38 handlers)**: `approve`, `artifacts/[artifactId]` (+comments),
`browser`, `changes`, `checkpoints` (create/restore), `context-budget`, `exec`,
`grep`, `history` (record/list/undo), `memory` (+capture), `missions`,
`notifications` (+read), `orchestrate` (SPARC/ToT/blueprint/swarm-review/plan),
`plugin-library`, `plugins`, `preview`, `provider-status`, `runs` (+batch,
claim, `[id]`, `[id]/approve`, `[id]/events`, `[id]/export` (+verify),
`[id]/merge`), `screenshot`, `serve`, `spend`, `terminal` (+session, stream),
`uptime`, `verify`, `workspace-cwd`.
**Admin (6)**: `backups`, `health`, `janitor`, `keys`, `system`, `usage`.
**Free tier**: `signup`, `usage`, `/api/user/quota`.
**Interop**: `/api/mcp` (token-gated gateway), `/api/sync/push|pull`,
`/api/search` (Google→Bing chain), `/api/plugins` (registry).
**Learning**: `/api/playbook` (+`[id]`, `capture`), `/api/session-search`.

## Electron, CLI, Extension, Scripts, E2E

- `electron/`: `main.ts`, `preload.ts`, `tray.ts` (+`tsconfig.json`).
- `cli/`: TypeScript CLI (`src/commands`, `bin/`).
- `vscode-extension/`: chat sidebar, code lens, inline chat, diagnostics,
  provider selector.
- `scripts/`: fetch-fonts (+check-fonts-sync, font-targets), fetch-pgdump,
  local-db (embedded Postgres), orplex-mcp-server, restore-drill, audit-wiring,
  clean, codemod-apibase, test-models (+test-chat-models, verify-freebuff-model),
  setup-codespace.sh, agent-ci-run (headless executor battery),
  bench-report (cost-adjusted benchmark), swe-bench/ (Lite harness:
  fetch-instances, run-shard, merge-results).
- `e2e/`: Playwright chat + seed specs (keyless via MOCK_AI + dev bypass).
- `tools/eslint-rules/`: custom lint rules.

---

# Data Flows

### Chat message (interactive)
```
ChatInput → useChatSession.sendMessage → POST /api/chat (SSE)
  → provider chain (registry → keys → circuit breaker → TPM pacer)
  → stream-reader parses tool_calls/thinking
  → background-worker dispatches via native-tools (risk gate → approval?)
  → tool results feed next model turn (budget/compaction between turns)
  → self-review pass → auto typecheck/browser verify (UI work) → done
  → run ledger + workspace-memory capture → board mirrors via run-sync
```

### File write (audited)
```
write_file → risk classify → approval (if needed) → recordChange(prev)
  → File System Access write → hooks/plugins → durable history append
  → auto-checkpoint (pre-write snapshot) → Changes tab diff
```

### Claimed run (Manager/morning queue)
```
POST /api/agent/runs (or /batch schedules) → pending row
  → executor/tab claims (CAS) → worktree → hooks/project-memory context
  → same tool loop → approvals via ApprovalRequest table
  → artifacts + review chain → merge branch → export/verify bundle
```

### Verification
```
UI writes detected → pick dev command → free-port check (4310)
  → spawn server → Playwright load → console errors + screenshot + walkthrough
  → failures → 1 repair turn → re-verify → PASS/ISSUES verdict
```

# Key Patterns

- **Desktop owns the server**: Next.js is a child process; nothing user-facing
  points at it. All browser work is native Chromium.
- **Background singleton store**: chat/tool loop survives navigation;
  sessionStorage snapshots survive reloads.
- **Provider pattern** (React): Auth/Toast/Theme → BootGate → FileSystem →
  HunkDecisions → Conversation → QueueRunner → AppLayout.
- **Everything budgeted**: TPM pacer (global), compaction, prompt profiles,
  checkpoint caps, janitor — the 8GB/free-tier machine is the target.
- **Two loops, one contract**: interactive client worker and claimed server
  executor share `src/lib/agent/contract/` (tool schemas/rules, risk, loop
  detection, scratchpad, browser backends, result formatting) — no
  re-implemented tool logic on either side.
- **Honest failures**: every lane surfaces infrastructure-failure distinctly
  from app failure; no silent degradation.
- **Same-origin API, cloud handlers**: the browser only ever calls `/api/*`
  on its own origin; `proxy.ts` forwards everything to the cloud backend
  (zero CORS in the app) and opts machine-local routes out via
  `LOCAL_ONLY_API_ROUTES`.
