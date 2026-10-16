# Architecture — Orplex Code

> **Accuracy contract**: every file path, count and claim below is verified
> against the working tree. When a subsystem was removed, this document says
> so rather than describing it — see §18 *Removed subsystems* for the list of
> things that used to be documented here and no longer exist.

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

Stack: TypeScript everywhere, Next.js App Router (`output: "standalone"`),
Prisma + PostgreSQL (hosted Supabase for the cloud backend; an optional
embedded local Postgres for desktop/offline mode — skipped in lightweight
mode), NextAuth (Google/GitHub OAuth + dev bypass), Tailwind, Playwright
(verification + E2E), Electron 41.

## How It Runs (desktop-first)

```
npm run dev           # fetch fonts → compile electron main → launch Electron
                       # Electron: single-instance lock → crash-recovery marker
                       #           → read app-config.json defaults
                       #           → start embedded Postgres (skipped when lightweight)
                       #           → spawn `next dev` (port 5000) as child
                       #           → wait for HTTP → open BrowserWindow
npm start             # `electron .` — NOT packaged, so still runs next dev
npm run electron:dist # build → tsc electron main → stage → electron-builder
```

- **Single instance**: a second launch focuses the existing window
  (`app.requestSingleInstanceLock`); two copies never fight over the port.
- **Two possible Next children**: port **5000** is always the UI. Port **5010**
  is spawned **only when no `ORPLEX_API_URL` is set** (local-API mode); in
  cloud mode there is exactly one child and the UI proxies to the hosted
  backend.
- **Packaged mode does NOT run `next start`.** It runs the Next **standalone**
  bundle directly: `.next/standalone/server.js`, which ships inside the app
  directory as `resources/app/.next/standalone/server.js`. Standalone
  deliberately bundles no `next` CLI and has no top-level `.next/server`, so
  `next start` cannot work there. A missing `server.js` shows an explicit
  "install is incomplete" dialog and exits rather than failing silently.
- **Crash recovery**: a session-state file records whether the previous run
  ended cleanly; a launch without the marker offers "Recover previous
  session?" (`RecoverSessionPrompt`), and the run ledger still holds the runs.
- **Port safety**: only a stale Orplex server from a crashed run is taken over.
  The user's own processes are never killed.
- **Quit = teardown**: the Next child is killed with the app (Windows:
  `taskkill /T /F`); the embedded DB is left running (cheap to restart).
- **Config resolution order** (highest first): real shell env → repo-root
  `.env` → `electron/app-config.json`. The packaged app ships **no `.env`**
  (it holds the database password), so `app-config.json` is what carries
  `apiUrl` + `lightweight` into an installed build.

## High-Level Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    Electron Shell (main process)               │
│  tray + notifications · WebContentsView preview tabs           │
│  agent browser view · updater · IPC bridge (preload)           │
│  single instance · crash-recovery marker                      │
└──────────────────────────┬─────────────────────────────────────┘
                           │ loadURL(http://localhost:5000)
┌──────────────────────────┴─────────────────────────────────────┐
│                     Renderer (React UI)                        │
│  Chat page · RightPanel (queue/changes/files/preview/terminal/  │
│  scratch) · Manager board · Settings · History · Plugins ·     │
│  Admin · Playbook · Connectors                                │
│  Context providers → hooks → background chat worker (client)   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP / SSE (src/proxy.ts — auth + cloud forward)
┌──────────────────────────┴─────────────────────────────────────┐
│                Next.js API layer (100 route handlers)          │
│  /api/chat · /api/agent/* (41) · /api/admin/* (6) ·           │
│  /api/mcp/* (9) · auth · conversations · settings ·            │
│  workspaces · projects · sync · MCP · models                   │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  AI providers (12 registry entries, OpenAI-compatible)         │
│  Server executor (claims runs) · verification harness          │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  Data: Prisma · PostgreSQL (Supabase or embedded .localpg)    │
│  Workspace files (.orplex/ history, checkpoints, memory)      │
└────────────────────────────────────────────────────────────────┘
```

---

# Major Features

## 1. Desktop Shell (Electron)

| Piece | File | What it does |
|---|---|---|
| Main process | `electron/main.ts` | Owns the Next child(ren), embedded Postgres bootstrap (`scripts/local-db.mjs`, port 5433; skipped entirely in lightweight mode), single-instance lock, port takeover, IPC for preview + agent browser + terminal + MCP, tray wiring, updater registration, crash-recovery marker, graceful teardown |
| Preload bridge | `electron/preload.ts` | `window.orplexDesktop`: `preview.*` (`createTab`, `navigate`, `bounds`, `show`, `back`, `forward`, `reload`, `screenshot`, `events`, `closeTab`, `stop`, `diag`), `agentBrowser.*` (show/showId/getId/navigate/read/elements/interact+ref/console/find/waitFor/hover/select/tabs/network/screenshot(fullPage,viewport)/evaluate), `terminal.*`, `mcp.*`, `updates.*`, `openExternal`, `getPathForFile`, versions |
| Tray | `electron/tray.ts` | Static template icon + native notifications; polls the local run-board summary and fires on status transitions only |
| Updater | `electron/updater.ts` | GitHub-release update check / download / cancel / install, emits status to the renderer; wired at `main.ts:730, 1634` |
| Desktop auth | `electron/auth-desktop.ts` | Opens the system browser for the desktop OAuth flow and waits for the deep link |
| Terminal bridge | `electron/terminal.ts` | Runs commands on the **user's device** (see §12) |
| MCP bridge | `electron/mcp-bridge.ts` | Local MCP stdio bridge for the desktop lane |
| Shipped config | `electron/app-config.json` | `apiUrl` + `lightweight` — the packaged app has no `.env`, so this is where the cloud backend origin comes from |
| Window | `electron/main.ts` | 1440×900, dark background, menu (View/Edit roles), `window.open` → OS browser (`setWindowOpenHandler` allows only `http(s):`) |

## 2. Embedded Browser (Preview panel) — native Chromium

Real Chromium `WebContentsView`s owned by the main process, layered over the
RightPanel viewport and positioned via IPC (`preview:setBounds`). Isolated
`persist:orplex-preview` partition (no cookie sharing with the app).

- **Tabs**: per-tab history, back/forward, reload, close, open-in-OS-browser,
  favicons, `target=_blank` becomes a new preview tab.
- **Omnibox**: Chrome-style normalization — search terms → real Google search
  (genuine browser fingerprints, real Google UI), bare hosts → https, localhost
  → http.
- **New-tab page**: live port detection (`/api/localhost-probe` TCP probes
  **8 ports** — 3000, 5173, 8080, 4200, 3001, 8000, 5000, 4000) — click a
  dotted port to open a running dev server with working HMR websockets (no
  proxy involved). The polling cadence lives in the client caller, not the
  route.
- **Failure surfaces**: `did-fail-load` error codes mapped to honest copy
  (DNS, refused, timeout, offline, SSL) with Retry / Open-in-Chrome actions,
  plus `preview.diag` for structured diagnostics.
- **Agent mirror**: the agent's own browser view appears as an "Agent Browser"
  tab and can be watched live.
- Deliberately **no iframe/proxy fallback**: the desktop app renders everything
  natively; without the shell the panel says "Desktop app required".

## 3. Agent Browser Automation (`browser_*` tools)

The agent gets a dedicated WebContentsView (visible to the user) driven over
IPC. `BROWSER_OPS` is exactly **15 ops** (`agent/contract/browser.ts`):
`navigate`, `read`, `find`, `click`, `type`, `select`, `hover`, `press`,
`scroll`, `wait_for`, `tabs`, `console`, `network`, `screenshot`, `evaluate`.

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
  visible, or a fixed delay (capped **15s**) — the anti-pattern it replaces is
  blind read-retry loops after SPA clicks.
- **`browser_tabs`** manages up to **4** tabs (list / new [with URL] / switch /
  close); console and network capture attach to every tab, not just the
  first. All navigation — including new-tab URLs — passes the SSRF policy
  (`ssrf-guard.ts`), enforced pre-session **and** at the network layer.
- **`browser_network`** exposes failed requests: HTTP 4xx/5xx responses and
  aborted requests in a bounded ring (**60 events**).
- **`browser_screenshot`** takes `fullPage` captures and named viewports
  (`desktop` 1280×720 · `tablet` 768×1024 · `mobile` 390×844).
- **`browser_evaluate`** runs page JS and auto-retries multi-statement
  snippets wrapped as an IIFE when the bare expression fails.
- **Two backends, one contract**: `agent/contract/browser.ts` holds the op
  set, validation and result formatting (client-safe, no Node imports);
  `agent/contract/browser-server.ts` holds the server-only Playwright backend.
  The split exists because Turbopack traces dynamic imports into the **client**
  bundle — an unguarded `import("../../agent-browser-session")` from the
  contract broke `next build` with 100+ module-not-found errors.
- **Non-desktop parity**: `src/lib/agent-browser-session.ts` + `/api/agent/browser`
  run the identical op set through headless Playwright, with per-user sessions,
  session/tab caps, bounded logs and idle reaping.

## 4. Streaming Agent Chat + Tool Loop

`background-worker.ts` runs the tool-calling loop client-side as a background
singleton (survives navigation/reload via `background-chat.ts` snapshots).
Both execution modes (this worker + the claimed server executor in
`server-executor/executor.ts`) import their shared tool-loop logic from ONE
place — `src/lib/agent/contract/` (tool arg rules, risk tiers, loop
detection, scratchpad, browser backends, result formatting).

- **Context building** (`context-builder.ts`, `client-signatures.ts`): M3-aware
  workspace context — full contents for small repos, signature tiers for large.
- **Budgeting**: token estimation, `fitMessagesToBudget` (line-boundary caps
  with explicit cut markers), rolling-60s TPM pacing (`reserveTokenWindow`),
  and **summarizing compaction** (`compaction.ts`) — evicted turns become a
  `<context_so_far>` summary instead of disappearing.
- **Streaming**: `stream-reader.ts` parses native `tool_calls` + thinking and
  legacy XML tags; `tool-text.ts` dedups word-repetition pathologies, strips
  redundant fences, normalizes thinking blocks, repairs interleaved replays.
- **Safety caps**: **120 tool turns**, streak-based loop detection
  (`loop-detect.ts` — identical call 3×, same target with noisy args 4×, the
  same multi-call turn 3×, or one state-changing tool 5 turns in a row — all
  trip BEFORE dispatch; read-only exploration is exempt). Loop trips self-heal
  once with an evidence-carrying `[LOOP BREAK]` directive; a second trip stops
  the task with an honest note. Write/turn caps become a "keep going?"
  question (max **5** extensions).
- **Anti-laziness gates**: FORCE-TOOLS nudge when a build request produced no
  writes; SPARC plan-first gate on complex tasks.
- **Scratchpad**: `scratchpad_update` writes private working memory
  (plan/hypotheses/findings/next) re-injected into every turn. It reports
  what was **actually kept** — if content exceeds 2000 chars the tool says so
  rather than claiming the full length was banked.
- **Modes**: ask · code · plan (hard plan-approval gate before any write) ·
  self-review pass with one repair turn after the loop.
- **Failure learning**: `failure-memory.ts` + persistent `run-ledger.ts`
  re-seed new tasks with what actually failed last time; `master-prompt.ts`
  renders the Adaptive Failure Doctrine.
- **Message retry**: `message-retry.ts` drives retry of a failed assistant
  turn instead of stranding the conversation.
- **Honest failure vocabulary**: `error-guidance.ts` gives every lane a shared
  failure taxonomy so infrastructure failure never reads as app failure.

## 5. Tool Belt (what the agent can do)

Tool schemas live in `tool-definitions.ts`; dispatch is
`agent/native-tools.ts`. Every result is explicit XML — unknown tools error
instead of hanging.

**File & code**: `read_file` (offset/limit paging; paged re-reads are never
short-circuited by the duplicate-read guard), `write_file` (+chunked),
`edit_file`, `batch_edit`, `list_files`, `search_code`, `code_search`,
`grep`-backed server-side search (`grep-search.ts`, ripgrep→grep→Node chain).

**Execution**: `run_command`, `run_in_sandbox`, `undo_last_change`. Serve
commands passed to `run_command` are auto-detected and detached — there is no
separate serve tool.

**Web & media**: `web_search` (Google→Bing chain), `take_screenshot`,
`preview_browser`, `verify_app`.

**Reasoning aids**: `todo_list`, `ask_question`, `ask_clarification`,
`playbook_search`, `session_search`, `scratchpad_update`, `skill_create`,
`mcp_call` (universal MCP caller), plus the full `browser_*` set.

- **Provider tiering**: `COMPACT_TOOL_PROVIDERS` (groq, nvidia) receive the
  compact schema set because the full one exceeds their free-tier TPM cap;
  `FULL_TOOL_PROVIDERS` (11 entries) get everything; `usesCompactTools()`
  selects. One flat tool set is **not** always sent.
- **Exec security**: `exec-guard.ts` screens command text beyond the static
  blocklist in `constants.ts`; hosted deployments run `AGENT_EXEC_DISABLED=1`.
- **Risk gating**: `risk-classifier.ts` → low auto-approved, medium approval
  dialog (`approval-store.ts` + `ApprovalDialog`), high forced review.

## 6. Verification Lanes (prove it works)

- **Typecheck lane**: after UI-relevant writes the worker runs
  `npx tsc --noEmit` in the workspace and feeds failures to a repair turn.
- **Browser lane**: `browser-verification/index.ts` spawns the project's dev
  server (command picked by `ui-paths.ts`), loads the page in headless
  Chromium, captures console errors/warnings + screenshot + **replayable
  walkthrough** (`walkthrough.ts`). Failures trigger one model repair turn,
  then re-verify. URL policy: default private-host/metadata SSRF denylist +
  allow/denylists.
  Playwright is an **optional** dependency, so it is imported through a
  non-literal specifier — a literal makes the bundler fail to resolve a
  package that is legitimately absent.
- **Server-executor parity**: `server-executor/executor.ts` implements the same
  lanes for claimed runs (see §8), plus auto-checkpointing, tool-hooks, MCP,
  and review artifacts.

## 7. Files: History (exactly two layers) + Checkpoints as Snapshots

- **Layer 1 — working/session history**: `file-history.ts` (**50-entry**
  snapshots, sessionStorage mirror) powers `undo_last_change` and the Changes
  tab. Short-lived, UI-facing.
- **Layer 2 — durable history**: `workspace-history.ts` appends every change to
  `<workspace>/.orplex/history.jsonl`, with caps (**200 entries**, **8 MB** per
  file, **200k chars** per content blob) and periodic `compactHistory()`.
  `/api/agent/history` GET/PUT undo survives tabs, days, and machines. Path
  containment enforced (`safeJoinWorkspace`).
- **Checkpoints are snapshots OF Layer 2, not a parallel system**:
  `checkpoints.ts` + `auto-checkpoint.ts` — before the first mutating write per
  file, a restorable snapshot (git tree-commit under
  `refs/orplex/checkpoints/<runId>/<n>` or shadow-clone JSON) that records its
  Layer-2 offset (`historyLength`); restore appends inverse entries to the
  durable history, so **restore is itself undoable** via `/api/agent/history`.
- **Parallel workspaces**: `parallel-workspaces/index.ts` +
  `server-executor/worktree.ts` — each agent task gets its own git worktree (or
  directory copy). Merging is previewed/applied through
  `/api/agent/runs/[id]/merge`; conflicts surface as `ConflictCard`.

## 8. Manager Board, Runs, Missions, Morning Queue

- **AgentRun rows** mirror live tasks (`run-sync.ts`) and are claimed by the
  server executor: `agent/runtime/{scheduler,service}` +
  `/api/agent/runs/claim` (CAS claim — two tabs can never take one run). Stuck
  runs are swept by a ghost-run reaper (**30-min** window).
- **Manager UI** (`/manager`): board feed with statuses, pending approvals,
  token/cost estimates, per-run event timeline, live status strip.
- **Missions**: `/api/agent/missions` — one parent run + N child runs grouped
  on the board, children inherit parent context with a subtask prepended.
- **Morning queue**: `/api/agent/runs/batch` — up to **8** prompts scheduled at
  staggered times; the queue runner (`queue-runner.ts`, idle browser tab)
  claims and executes them serially; each lands on its own branch.
- **Server approvals**: risky actions in claimed runs pause on the
  ApprovalRequest table; decide from anywhere via `/api/agent/runs/[id]/approve`.
- **Artifacts + review chain**: runs emit artifacts (`/api/agent/artifacts`)
  with review status (draft→reviewed→approved/rejected) and inline comments
  that reach the agent's next prompt.
- **Flight recorder**: `/api/agent/runs/[id]/export` builds a self-verifying
  hash-chained bundle with `manifest.md` (`audit-bundle.ts`) and a `/verify`
  endpoint for tamper checks.
- **Run credential resolution**: `byok-credentials.ts` decides which API key a
  claimed run uses — preferring the run user's **own** key whose catalogue
  serves the requested model, falling back to the platform env. The executor
  previously read `process.env` only, so a user's paid key was honoured in
  chat and silently ignored in background runs.

## 9. Memory (three permanent buckets + one ephemeral scratchpad)

All writes go through the tiny API in `memory.ts` (`remember`,
`record_failure`, `update_scratchpad`, `captureFromCompaction`,
`postRunToLedger`).

| Bucket | File | Purpose |
|---|---|---|
| Project instructions | `project-memory.ts` | User-owned `orplex.md` hierarchy injected into system prompts, token-disciplined |
| Workspace learnings | `workspace-memory.ts` (+ client) | Evidence-backed memories derived from completed runs; score-based retrieval; `/remember <fact>` pinning; forget API; eviction capture (`extractEvictionFacts`) |
| Playbooks | `playbook.ts` | Its **own** Prisma store (the `Learning` table) with full CRUD — `/api/playbook`, `/[id]`, `/capture` and a `/playbook` page (pin / edit / delete). It is a first-class bucket, not a derived view; only the executor's `playbook_search` merges playbooks with learnings |
| Run / failure ledger | `run-ledger.ts` + `failure-memory.ts` | What actually failed and why; survives restarts |
| Scratchpad (ephemeral) | `scratchpad.ts` | Current plan / hypotheses / findings / next — per-task only, never persisted |

- **Retrieval substrate**: `embeddings.ts` runs a local MiniLM ONNX encoder
  (384-dim cosine similarity); the ONNX dependency is **optional** and loaded
  behind a runtime import.
- Folded away: `compaction-memory.ts` is a re-export shim over the learnings
  bucket. `semantic-cache.ts` is deprecated with **zero callers** (verified) —
  similar tasks surface via learnings + ledger. `memory-note.ts` probes local
  RAM for failure annotation.

## 10. Models & Providers

- **Provider registry** (`provider-registry.ts`): single source of truth with
  **12 providers** — `groq`, `nvidia`, `openrouter`, `anthropic`, `gemini`,
  `mistral`, `deepseek`, `together`, `xai`, `cerebras`, `fireworks`, `openai`.
  All are OpenAI-compatible for chat; listing differs per provider via
  `authStyle` + `listPath` + `extraHeaders`. Per-provider knobs:
  `modelsCap`, `maxListPages`, `probeSpacingMs`, `keyPrefix`, `fallbackModel`,
  `free`.
- **Adding a provider** is one registry entry plus (for bespoke behaviour) an
  adapter case in `ai-providers.ts` and any provider-specific branch in
  `model-catalog.ts`.
- **AI layer** (`ai-providers.ts`): OpenAI-compatible base adapter; `retry.ts`
  for transient errors (**408/429/5xx/522/524**); `circuit-breaker.ts`
  (threshold 3, 5-minute open window, lazy hydrate + fire-and-forget DB
  upsert — self-contained, no separate reset module); `key-pool.ts`
  round-robin with quota tracking; `key-encryption.ts` at rest.
- **Auth styles reach the transport**: `authStyle: "x-api-key"` providers get
  the key in that header on **both** the chat and executor lanes, not just
  listing. A provider registered as x-api-key that only received
  `Authorization: Bearer` would 401 — and 401 is terminal, so the key would be
  dropped with no diagnostic.
- **Per-model request budgets** (`model-output-caps.ts`): every request's
  output-token budget is resolved from the **model actually selected**, never
  from a global/effort-tier default. Reasoning families (o1/o3/o4/gpt-5) also
  get `max_completion_tokens` instead of `max_tokens` and **no** `temperature`
  (Claude 4.7+ rejects any temperature below 1; OpenAI reasoning models reject
  a non-default one). When a provider still rejects the budget, the retry
  ladder **learns its stated ceiling** from the 400 body across all providers
  and retries — and only ever accepts a ceiling *lower* than requested, so a
  mis-parse can never inflate the budget.
- **Model routing** (`model-router.ts`): 3-tier task routing. Its tier config
  is advisory only — it must never supply a per-model parameter.
- **Live catalog** (`model-catalog.ts` + `/api/models/available`): probes every
  platform-provider model with a real completion; only answering models are
  listed; cold-start models tagged `cold` and woken by a background engine.
  The endpoint never blocks on a sweep — cache answers instantly, cold start
  returns `[]` and sweeps in the background.
- **BYOK listing** (`provider-models.ts`): fetches a provider's **entire**
  catalogue with the user's key. The cap is a DoS backstop (**2000**) plus
  per-provider `modelsCap`, applied **after** ranking free-first then
  largest-context so a cap can never drop the best models. Follows pagination
  cursors, detects free models from `:free` suffixes, explicit flags and
  numeric *or* string pricing. Responses report `listedTotal` / `truncated` /
  `pages` so a clipped list is never presented as complete.
- **Autonomous catalogues** (`catalog-sync.ts`): adding a key populates it
  immediately, and opening the picker repairs any missing or stale (>6h)
  catalogue via `after()` — the user never clicks "Fetch models".
- **Keys**: `UserApiKey.apiKey` / `ApiKeyPool.apiKey` encrypted at rest
  (AES-256-GCM via `ENCRYPTION_SECRET`); ownership is scoped on both read and
  write, so a caller cannot write a catalogue onto another user's key.
- **Free-tier discipline**: `free-tier/quota-manager.ts`, `rate-limiter.ts`
  (**fixed** 60s window), `tpm-pacer.ts` (process-wide token bucket shared by
  ALL callers so concurrent runs can't blow the account TPM),
  `prompt-meter.ts`, `cost-estimator.ts`, `spend-format.ts` +
  `/api/agent/spend`, `/api/free/*`. A user's own **paid** key lifts the
  platform quota; a free-tier-only key does not, and free-tier shaping (token
  caps, compact prompts) applies by lane (`personal` / `pool` / `platform`),
  never by provider name.
- **Provider uptime**: `provider-uptime.ts` records per-provider reliability.
- **Mock AI** (`mock-ai.ts`): `MOCK_AI=1` deterministic keyless stream for dev
  and E2E.
- **Skills catalog**: `skills.ts` — 100+ built-in coding skills with frontmatter
  menus; `user-skills.ts` discovers `.orplex/skills/<name>/SKILL.md`.

## 11. Extensibility: Plugins, Hooks, MCP

- **Plugin system**: `plugins/{types,registry,initializer}` — tools and hooks.
  **25** built-ins under `plugins/builtin/`: API scaffold, build watcher, code
  review, complexity estimator, cost tracker, DB migration, dep updater, doc
  gen, docker scaffold, export manager, git auto-commit, input sanitizer,
  linter, logger, memory sync, model-router config, path traversal guard,
  pattern learner, prompt enhancer, response cache, secret scanner, task queue,
  test gen, type checker, UI components. (`onFileEdit` is a hook **type**, not
  a 26th plugin.)
- **Plugin bundles**: `plugin-bundles.ts` + `/api/agent/plugins` — install
  skills+hooks+MCP as one data-only `.orplex-plugin.json` unit.
- **Built-in plugin library**: `plugin-library.ts` + `plugin-library/` (5
  one-click bundles: quality, security, devops, domain, intelligence) +
  `plugin-library-state.ts` — materialized through the same `installPlugin()`
  path (existing user files always win), with content-based installed
  detection. Per-workspace enable/disable lives in `.orplex/bundles.json`; the
  Plugins page toggles a bundle's hook rules without deleting its skill files.
- **Declarative hooks**: `tool-hooks.ts` — `orplex.config.json` deny/notify
  rules for both agent loops.
- **Command hooks**: `user-hooks.ts` — `.orplex/hooks.json` commands run
  through exec-guard with timeouts, caps, and `ORPLEX_HOOK_*` env.
- **MCP is a ~22-file subsystem**, not one client:
  - `mcp/client.ts` — **361-line** wire-protocol stdio client (low-spec budget)
  - `mcp/registry.ts`, `mcp/dispatch.ts`, `mcp/hub.ts` — remote-SDK connection
    hub with a status machine, backoff and `needs_reauth`
  - `mcp/flow.ts`, `mcp/store.ts`, `mcp/pending.ts`, `mcp/provider.ts` —
    OAuth dynamic-registration flow + encrypted verifier storage + pending
    one-time states
  - `mcp/gate.ts`, `mcp/risk-db.ts` (server lane), `mcp/risk-hint.ts` (browser
    lane) — **dual-lane risk classification**, fails closed
  - `mcp/ssrf-fetch.ts` — SSRF guard across the whole SDK network surface
  - `mcp/tool-builder.ts`, `mcp/tool-snapshot.ts`, `mcp/roster-refresh.ts` —
    schema building, snapshots/annotations, roster refresh
  - `mcp-accounts.ts`, `mcp-auth.ts`, `mcp-catalog.ts`, `mcp-prompt.ts`,
    `mcp-gateway.ts` (thin 47-line auth shim)
  - **9 routes**: `/api/mcp` (gateway), `servers`, `catalog`, `connections`,
    `connections/[serverId]`, `connections/[serverId]/connect`, `oauth/callback`,
    `oauth/complete`, `test-connection`
  - Plus `scripts/orplex-mcp-server.mjs` stdio proxy — drive Orplex from any
    MCP host.

## 12. Terminal & Dev Servers

- **Persistent shell** (`shell-session.ts`, `/api/agent/terminal/session`):
  real shell **per user** — `cd`/env persist, servers keep running, SSE
  streaming to the RightPanel Terminal tab (history, Ctrl+L clear, Esc abort,
  exit code 130).
- **Two execution lanes** (`terminal-lane.ts`): the single selector for both
  user-typed and agent commands — **(1)** the Electron desktop bridge, which
  runs the command on the **user's own device**, and **(2)** the API lane
  (self-hosted/cloud). Output is capped at 4000 chars per chunk.
- **One-shot exec** (`/api/agent/exec`) and **serve lane**
  (`/api/agent/serve`): long-running servers detach (never burn exec
  timeouts), tracked in a registry, with port-conflict hints
  (`diagnosePortConflict`).
- **Workspace CWD** (`workspace-cwd.ts`): the renderer registers the user's
  real folder; every command lane executes there. This file holds **path
  validation only** (`MAX_PATH_LENGTH = 500`) — the read window and cache live
  in the renderer hook:
  - opening a folder only maps the tree (paths are cheap) — no bulk indexing
  - oversized files return a **200k-char window** with a `[.windowed read …]`
    marker (`useFileSystem.ts`)
  - the renderer keeps a **10 MB LRU hot-set** with 8 MB anti-clobber write
    guards
  - search runs server-side via ripgrep/git-grep/node-scan (`grep-search.ts`)

## 13. Admin, Ops, Observability

- **Admin area** (`/api/admin/*`, `/admin` + `/admin/system` pages): backups
  (`backup.ts` pg_dump rotation — 7 daily / 4 weekly, Windows-safe, manual
  trigger), keys, usage, system snapshot (executor state, cron, TPM pacer,
  hardware, event ring), janitor control, health.
- **Runtime state** (`runtime-state.ts`/`runtime-log.ts`): globalThis
  singletons survive dev-bundle duplication; ring-buffer logs.
- **Hardware watchdog** (`hardware.ts`): RAM pressure ladder
  (**70 / 85 / 92%**) with hysteresis — pause claims, shed lanes, janitor
  sweep — before Windows OOM-kills.
- **Janitor** (`janitor.ts`): whitelist-only deletion of re-creatable
  artifacts, scoped to `os.tmpdir()/orplex-worktrees`; **>24h** orphaned
  worktrees removed; protected paths refused.
- **Instrumentation** (`src/instrumentation.ts`): boots the hardware watchdog,
  executor, janitor sweep, backup schedule, **cron-reset**, graceful-shutdown
  registry and model warm-up at server start.
- **Cron**: `cron-reset.ts` (advisory-locked daily quota reset).
- **Error tracking**: `error-tracking.ts` (Bugsink/Sentry SDK protocol).
- **Logging**: `logger.ts` (Pino + pretty in dev).
- **Audit bundle**: hash-chained per-run export (see §8).

## 14. Sync, Storage, Deployment

- **Peer sync**: `sync-transport.ts` + `/api/sync/{push,pull}` — signed gzip
  envelopes move files and history between machines via a hub. Signatures use
  timing-safe **double-hash** comparison; a **25 MB** decompressed / **5 MB**
  compressed gzip-bomb guard and a 500-entry pull cap.
- **Project sync**: `project-sync.ts` + `/api/projects` — per-project
  registration, reopen and thread state.
- **Local database (optional)**: the desktop shell boots an embedded Postgres
  (`.localpg/`, port **5433**) for local-only/offline mode. Cloud setups are
  lightweight by default via `app-config.json`'s `lightweight: true`
  (`ORPLEX_LIGHTWEIGHT`) — ~30s faster boot and one less failure class. Nothing
  in cloud mode needs it.
- **Deploy targets**: Vercel (`vercel.json`), Fly (`fly.toml`), Railway
  (`railway.json`), Render (`render.yaml`), Docker (`Dockerfile`,
  `Dockerfile.deploy`, `Containerfile`, `podman-compose.yml`); split
  frontend/API mode via `NEXT_PUBLIC_API_BASE_URL` (`api-base.ts`).
- **HTTP gatekeeper + cloud API forward**: `src/proxy.ts` — Edge JWT page auth,
  dynamic credentialed CORS, CSRF (content-type/XRW + origin checks),
  request-ID/timing headers, CSP. Every `/api/*` request is rewritten to the
  cloud backend (`ORPLEX_API_URL`, else `NEXT_PUBLIC_API_BASE_URL`) so the
  browser stays same-origin — first-party cookies, zero CORS.
  - `LOCAL_ONLY_API_ROUTES` opts machine-local diagnostics out (currently
    `/api/system/memory` — the cloud would report Vercel's RAM, not the user's).
  - `LOCAL_ONLY_API_PREFIXES` opts **all MCP connector routes** out
    (`/api/mcp/`, `/api/agent/mcp/`) because the OAuth token store and pending
    states live in the local process; forwarding them would split-brain state.
  - Auth-heartbeat forwards fail soft as JSON 503 instead of the plain-text
    500 that breaks the next-auth client; a cached HEAD probe (30s ok / 5s fail)
    gates the rewrite decision.

## 15. UI Surface (every panel & page)

**Pages** (`src/app/`): `/` (chat), `/manager`, `/history`, `/runs`,
`/settings`, `/plugins`, `/packages`, `/playbook`, `/admin`, `/admin/system`,
`/auth/signin`.

- **Chat page**: ChatInput (attachments, drag-drop, images, model picker),
  PromptBar (slash skill menu + model picker, chunked scroll-to-load menus),
  MessageList/MessageContent/MarkdownRenderer, ThinkingCard, ToolCallDisplay,
  ToolChain (vertical tool-call chain), ThoughtStream/ThoughtLine,
  QuestionCard, ClarificationCard, ApprovalDialog, TodoBar, QuotaIndicator,
  PromptMeterStrip, WelcomeSection, FirstRunExperience, Onboarding,
  VirtualList, LatticeLoader, ProgressBar, Skeletons.
- **RightPanel**: 6 tabs — **Queue · Changes · Files · Preview · Terminal ·
  Scratch**. Resizable grip, tab persistence, per-tab error boundary.
- **Manager**: RunBoard (batch, approvals, missions, provider badge),
  RunTimeline, RunLiveStatus, RunHealthStrip, QueueRunnerProvider,
  StepList, AgentProgress, AgentActivityLog.
- **Review**: ReviewStrip, BranchReviewPanel, ArtifactCard, ArtifactPanel,
  CommentInput, ConflictCard, BranchedMenu, ProjectBranchedMenu.
- **Shell**: AppLayout, AppProviders, Providers, Sidebar (+ProjectSidebarParts),
  Header, TopBar, CommandPalette, ThemeProvider/ThemeInit, Toast, Icons,
  ProviderIcons, StateViews, ScrollFadeManager, TipsDrawer, OfflineBanner,
  RecoverSessionPrompt, ProductivityOverlays, FileSystemProvider,
  HunkDecisionProvider, ConversationProvider, WorkspaceProvider,
  WorkspaceSwitcher, BugReportModal, AuthProvider, FilePreviewModal,
  MemoryPanel, ConnectorsPanel.
- **Updater**: UpdateToast (bottom-right download progress) + WhatIsNew
  (release notes, shown once per installed version).
- **Families**: `ui/` (9 — AgentStatus, AISuggestions, FileTree,
  KeyboardShortcuts, ModelSelector, OnboardingTour, QuickActions, SplitView,
  TaskProgress), `loader/` (3 — BootGate, BrandSpinner, GeometricLoader).

**Counts**: **90** components (`.tsx`, excluding tests), **14** hooks.

- **Hooks**: useChatSession, useBackgroundChat, useConversation, useMessages,
  useFileSystem, useFileProcessor, useHunkDecisions, useKeyboardShortcuts,
  useActiveRunCount, useBootProgress, useReducedMotion, useProjects,
  useScratchpad, **useAppUpdater**.
- **Version handshake**: `app-version.ts` + `update-state.ts` — the desktop
  identifies its build so the backend can answer **426** when below the
  supported floor, flipping the update card to mandatory.
- **Misc UX**: `navigation-events.ts` (sidebar→chat deep links), brand fonts
  self-hosted (`scripts/fetch-fonts.mjs`).

## 16. Auth & Multi-user

NextAuth (Google/GitHub) with Prisma adapter; Edge JWT checks in `proxy.ts`;
split-domain cookies (`AUTH_COOKIE_DOMAIN`); dev bypass (`/api/dev/session`,
`dev-seed.ts`, disabled in production); workspaces with owner/admin/member
roles; users' own API keys per provider; quotas per tier.

**Production env guards** (fail at boot, not mid-request):
- `prisma.ts` refuses to construct a client when `DATABASE_URL` points at
  localhost in production — laptop dev values leaking into the deployed env
  once made every OAuth callback die writing its session with no hint why.
- `auth.ts` refuses to boot when `NEXTAUTH_SECRET` is unset, or when
  `NEXTAUTH_URL` points at localhost (every OAuth callback goes to the wrong
  origin).
- Both are skipped during `next build` (`NEXT_PHASE`) — the running server
  enforces them.

**Security posture**:
- 7-day session maxAge with daily rotation (`updateAge: 24h`).
- `allowDangerousEmailAccountLinking` disabled — OAuth providers cannot
  auto-link to existing accounts by email.
- Desktop OAuth uses double-submit cookie binding (`orplex_desktop_flow`) to
  prevent login CSRF — only the browser that initiated the flow can arm the
  one-time code.
- Desktop auth routes are rate-limited by client IP (`clientIp()`:
  x-real-ip first, x-forwarded-for fallback).
- Admin surface fails closed: `ADMIN_USER_IDS` unset in production denies all
  admin access (loudly, so it reads as misconfiguration).
- MarkdownRenderer allows `http:`/`https:`/`mailto:` links, and images only
  as `https:` or `data:image/{png,jpg,jpeg,gif,webp};base64,` — **`svg` is
  deliberately excluded** because it executes script when opened as a
  document.
- Electron `setWindowOpenHandler` only allows `http(s):` URLs.
- Sync hub signatures use timing-safe double-hash comparison.

## 17. Quality Infrastructure

- **Hard verdicts + rubric recorder**: `rubric-recorder.ts` grades live runs
  against the master-prompt rubric into JSONL. Every finished run gets a
  binary PASS/FAIL verdict (done AND no failed lane — skipped lanes never
  fail); verdict-first trend reports catch prompt regressions.
- **CI sandboxed exec**: `ci-sandbox.ts` + `.github/workflows/agent-sandbox.yml`
  — when local exec is disabled (hosted), `run_command` dispatches to an
  ephemeral GitHub Actions runner and returns the artifact-embedded
  stdout/stderr/exit-code. Correlated by a run-name token; same exec-guard
  screening as local.
- **Benchmark report**: `src/lib/benchmark-report.ts` + `npm run bench:report` →
  `scripts/bench-report.mjs` — cost-adjusted aggregation over the `TaskRun`
  ledger: pass rate, hard-verdict mix, per-lane health, duration percentiles,
  modelled USD, and **per-hard-PASS cost** as the headline number, plus the
  recurring unresolved `TaskFailure` signatures ("what keeps breaking", not just
  "how often"). The script transpiles the TS core with the TypeScript compiler
  API and resolves its relative imports itself (plain node cannot import TS, and
  duplicating the math into the `.mjs` would mean two implementations that
  drift).
- **SWE-bench Lite harness**: `scripts/swe-bench/` +
  `.github/workflows/agent-swe-bench.yml` — fetches instances from the HF
  datasets-server, shards across matrix jobs, verifies FAIL_TO_PASS tests are
  red before any patch, then applies a gold patch (harness smoke test) or an
  agent command hook (`ORPLEX_SWE_AGENT_CMD`) and verifies green. Documented
  caveat: measures the dataset's own test commands on plain clones — not the
  official dockerized evaluation.
- **Tests**: **131 Jest suites / 1281 tests** under `src/**/__tests__`
  (1 skipped); Playwright E2E (`e2e/chat.spec.ts`, `e2e/seed.spec.ts`) using
  the mock-AI seam.
- **Custom ESLint rules**: `tools/eslint-rules/`; wiring auditor
  (`scripts/audit-wiring.mjs`).
- **Companion surfaces**: `cli/` (Orplex CLI), `vscode-extension/` (chat
  sidebar, code lens, inline chat, diagnostics, provider selector),
  `docs-site/` (Docusaurus), `logo/` (widget).

## 18. Removed subsystems (documented previously, no longer in the tree)

Recorded so nobody re-adds a reference to them:

| Removed | What replaced it |
|---|---|
| `eval/` harness (52 tasks, `eval/cli.ts`) | nothing — `virtual-fs.ts` survives with no eval consumer |
| `scripts/agent-ci-run.mjs` + `agent-ci.yml` (headless executor battery) | nothing; `AI_PROVIDER=ci-fixture` survives unused in `ai-providers.ts` |
| `benchmark-report.ts` | `scripts/bench-report.mjs` (its comment still pointed at the deleted module) |
| `storage-service.ts` (content-addressed blob store) | nothing — there is no blob store |
| `checkpoint-sync.ts` | nothing |
| `merge/crdt.ts` (line-level CRDT) | worktree merge preview/apply; conflicts surface as `ConflictCard` |
| `circuit-breaker-reset.ts` | in-module 5-minute expiry in `circuit-breaker.ts` |
| `rate-limit-store.ts`, `lazy-modules.ts`, `tool-handlers.ts`, `code-generators.ts` | consolidated / superseded |
| `plugins/server-middleware.ts` | nothing — plugins expose tools and hooks only |
| `CodeEditor` (Monaco) component | `DiffView` + `FilePreviewModal` |
| `MiniMax` as a registry provider | 12-entry registry; MiniMax survives only as a cost/pricing reference |
| built-in plugin "file-edit hooks" | `onFileEdit` is a hook type on the registry, not a plugin |

### Honesty notes for the insight store

These are deliberate degradations, not gaps:

- **Zero vector = "embedder unavailable".** `SonaTrajectory.embedding`,
  `SonaPattern.embedding` and `VectorMemoryEntry.embedding` are required JSON
  columns, but the ONNX encoder is an *optional* ~25 MB dependency. When it
  cannot load, rows are written with a zero vector instead of being dropped —
  the text (the valuable part) is preserved, and a zero vector scores 0 against
  every query so it never pollutes ranking.
- **Recall labels its fallback.** If nothing clears the semantic floor, recall
  falls back to a keyword match and marks every hit `match: "keyword"`. A
  caller must never mistake LIKE matching for semantic ranking.
- **A pattern needs evidence.** A tool sequence is promoted only after
  `PATTERN_MIN_SAMPLES` trajectories AND a ≥60% observed success rate, and
  `partial` counts as a non-success. Better no pattern than a bad one.

- **Agent insights** (`agent-insights.ts` + `/api/agent/insights`): a durable,
  queryable record of what the agent actually did — the per-task record and its
  tool-call audit trail (`Task`/`ToolCall`), per-stage run timing
  (`PipelineStep`), task dependency edges (`AgentTaskDependency`), full run
  trajectories (`SonaTrajectory`), **tool sequences learned from measured
  outcomes** (`SonaPattern`), and semantic recall of similar past work
  (`VectorMemoryEntry`, via `embeddings.ts`). The executor writes it on both
  the success and failure paths — a failed run is often the more interesting
  one. Every write is individually guarded: telemetry must never fail a run.
  Pattern mining is a batch step (`?learn=1`), never per-run.
  See §18 for the honesty notes (zero-vector fallback, keyword degradation).

---

# Module Map

## `src/lib/` — Core

| File | Purpose |
|---|---|
| `constants.ts` | All magic numbers, timeouts, limits, blocked commands |
| `types.ts` | Branded types, discriminated unions, type guards |
| `errors.ts` / `error-guidance.ts` | AppError hierarchy + shared failure-mode vocabulary |
| `validators.ts` | Zod schemas + sanitization + injection detection |
| `logger.ts` | Pino logging |
| `prisma.ts` | Prisma singleton (PgBouncer-aware, localhost guard) |
| `auth.ts` | NextAuth options, providers, cookies, production env guards |
| `desktop-auth.ts` | Desktop OAuth one-time codes + flow cookie binding |
| `admin-auth.ts` | Admin gate (fails closed in production when unset) |
| `graceful-shutdown.ts` | SIGTERM/SIGINT cleanup registry |
| `error-tracking.ts` | Bugsink/Sentry integration |
| `api-base.ts` | Same-origin/split API base resolution |
| `notify.ts` / `notify-client.ts` | Notify across DB row + toast + OS notification |
| `app-version.ts` / `update-state.ts` | Version handshake (426) + mandatory-update state |
| `navigation-events.ts` | Conversation deep-link events |
| `tool-text.ts` | Shared pure string/parse helpers |
| `message-content.ts` | Pure assistant-content segment parser (no React) |
| `message-retry.ts` | Retry flow on failed assistant messages |
| `ssrf-guard.ts` | Shared SSRF policy gate |
| `circuit-breaker.ts` | Provider resilience (threshold 3, 5-min open) |
| `hardware.ts` / `janitor.ts` | RAM watchdog / whitelist cleanup |

## `src/lib/` — Agent loop & prompts

| File | Purpose |
|---|---|
| `background-worker.ts` | The main client-side tool-calling loop |
| `background-chat.ts` | Global chat store (survives navigation/reload) |
| `agent-events.ts` | Status/activity/preview event emission |
| `stream-reader.ts` | SSE parsing: native tool_calls + XML, thinking |
| `master-prompt.ts` | Single source of truth for every system prompt + doctrines |
| `tool-definitions.ts` | OpenAI function schemas + provider compact/full tiering |
| `agent/native-tools.ts` | Tool dispatch via the shared contract (+ Electron IPC transport) |
| `agent/contract/` | THE shared contract: `tools` (arg rules), `risk`, `loop`, `scratchpad`, `browser` (client-safe op set + validation + formatting), `browser-server` (server-only Playwright backend), `results`, `index` barrel |
| `agent/file-ops.ts` | Audited write/edit path |
| `agent/serve-helpers.ts` | Server-command detection, port-conflict hints |
| `agent/runtime/*` | Run scheduler + service (claiming, sweeping) |
| `memory.ts` | Tiny memory API (all writes go through here — see §9) |
| `context-builder.ts` / `client-signatures.ts` | M3 context windows; signature extraction |
| `compaction.ts` / `compaction-memory.ts` | Transcript compaction; re-export shim |
| `failure-memory.ts` / `run-ledger.ts` | Adaptive failure doctrine; persistent ledger |
| `scratchpad.ts` | Agent private working memory, re-shown every turn |
| `loop-detect.ts` | Streak loop detection + `[LOOP BREAK]` directive |
| `memory-note.ts` | Low-memory failure annotation |
| `prompt-meter.ts` / `tpm-pacer.ts` | Token accounting / global TPM bucket |
| `queue-runner.ts` | Idle-tab claiming of scheduled runs |
| `risk-classifier.ts` / `plan-gate.ts` / `approval-store.ts` | Risk tiers, plan latch, approvals |
| `reflection-loop.ts` / `code-quality-checker.ts` | Self-correction, static quality scoring |
| `vision-preprocessor.ts` / `walkthrough.ts` | Vision prep, replayable walkthroughs |
| `rubric-recorder.ts` | Live-run rubric grading + trends |
| `board-format.ts` / `spend-format.ts` / `tool-chain.ts` | Pure UI presentation helpers |
| `ui-paths.ts` | UI-work detection, verify port, dev-command picker |
| `embeddings.ts` | Local MiniLM ONNX embeddings (optional dependency) |

## `src/lib/` — Reasoning & orchestration

| File | Purpose |
|---|---|
| `strategy-router.ts` | Deterministic strategy pick + all 5 strategies |
| `model-router.ts` | 3-tier task→model routing (advisory only) |
| `cost-estimator.ts` | Pre-run cost estimation |
| `semantic-cache.ts` | DEPRECATED — zero callers; kept only for tests |

## `src/lib/` — Providers & keys

| File | Purpose |
|---|---|
| `ai-providers.ts` | OpenAI-compatible adapters, per-model token params, auth styles |
| `provider-registry.ts` | Canonical 12-provider defs |
| `provider-models.ts` | BYOK full-catalogue listing + budget-guarded verify |
| `catalog-sync.ts` | Autonomous catalogue maintenance (add-key + 6h-stale repair) |
| `model-catalog.ts` | Platform model probing for the picker |
| `model-output-caps.ts` | Per-model output budgets + live 400-error cap learning |
| `byok-credentials.ts` | Resolves which API key a run should use |
| `provider-uptime.ts` | Per-provider reliability ledger |
| `retry.ts` | Transient-error retry helpers |
| `key-pool.ts` / `key-encryption.ts` | Key pooling + AES-256-GCM at rest |
| `chat-middleware.ts` | Composable chat API chain (auth, quota, provider ladder) |
| `mock-ai.ts` | Keyless mock stream (dev/E2E) |
| `skills.ts` / `user-skills.ts` | 100+ built-in skills + user SKILL.md |
| `free-tier/quota-manager.ts` / `rate-limiter.ts` | Tier quotas, fixed-window limits, `clientIp()` |

## `src/lib/` — Browser & verification

| File | Purpose |
|---|---|
| `agent-browser-session.ts` | Server-side Playwright browser_* sessions |
| `browser-verification/index.ts` | Dev-server boot + Playwright verify harness, URL policy |

## `src/lib/` — MCP (~22 files)

| File | Purpose |
|---|---|
| `mcp-client.ts` / `mcp-gateway.ts` | 361-line stdio client / thin auth shim |
| `mcp/{client,registry,dispatch,hub}.ts` | Connection registry, dispatch, remote-SDK hub |
| `mcp/{flow,store,pending,provider}.ts` | OAuth dynamic registration + verifier storage |
| `mcp/{gate,risk-db,risk-hint}.ts` | MCP enable gate + dual-lane risk (fails closed) |
| `mcp/ssrf-fetch.ts` | SSRF gate across the SDK network surface |
| `mcp/{tool-builder,tool-snapshot,roster-refresh}.ts` | Schema building, snapshots, roster refresh |
| `mcp/connection-view.ts` | Connection projection for the UI |
| `mcp-accounts.ts` / `mcp-auth.ts` / `mcp-catalog.ts` / `mcp-prompt.ts` | Accounts, auth, catalog, prompt injection |

## `src/lib/` — Files, history, checkpoints

| File | Purpose |
|---|---|
| `virtual-fs.ts` | In-memory FS |
| `file-history.ts` | Session undo snapshots (50 entries) |
| `file-adapter.ts` / `file-utils.ts` / `file-download.ts` | Compat barrel / helpers / markdown export |
| `diff-hunks.ts` | Unified diff → accept/reject hunks |
| `workspace-history.ts` | Durable JSONL change history (capped) |
| `checkpoints.ts` / `auto-checkpoint.ts` | Restorable snapshots + auto policy |
| `parallel-workspaces/index.ts` | Per-task worktrees/copies |
| `workspace-cwd.ts` | Real workspace path registry + validation |
| `workspace/workspace-manager.ts` | Workspace CRUD/queries |
| `workspace-memory.ts` / `workspace-memory-client.ts` | Learnings store + browser client |
| `project-memory.ts` | orplex.md injection |
| `project-{registry,sync,threads,menu,reopen}.ts` | Project CRUD, sync, threads, menus |

## `src/lib/` — Execution, servers, search

| File | Purpose |
|---|---|
| `server-executor/executor.ts` | Claims + executes Manager runs (full lane parity) |
| `server-executor/{review,verify-gate}.ts` | Review artifacts; verification gating + per-run ports |
| `server-executor/{worktree,worktree-helpers,executor-config}.ts` | Git worktree plumbing |
| `terminal-lane.ts` / `terminal-events.ts` | Electron-vs-API command lane selector; terminal events |
| `shell-session.ts` | Persistent per-user shells |
| `exec-guard.ts` | Command screening |
| `grep-search.ts` | Real code search (rg→grep→Node chain) |
| `tool-hooks.ts` / `user-hooks.ts` | Declarative + command hooks |
| `ci-sandbox.ts` | Hosted exec → ephemeral CI runner |

## `src/lib/` — Extensibility & infra

| File | Purpose |
|---|---|
| `plugins/*` (+25 builtins) | Plugin system |
| `plugin-library/` + `plugin-library-state.ts` / `plugin-bundles.ts` | 5 built-in bundles; per-workspace enable state; bundle install units |
| `hardware.ts` / `janitor.ts` | RAM watchdog / whitelist cleanup |
| `runtime-state.ts` / `runtime-log.ts` | Cross-bundle singletons + ring logs |
| `backup.ts` / `cron-reset.ts` | Backups / quota reset |
| `sync-transport.ts` | Signed peer-sync envelopes |
| `audit-bundle.ts` | Hash-chained flight recorder |
| `run-sync.ts` | Live→AgentRun mirroring |
| `dev-seed.ts` / `strategy-router.ts` | Dev data / orchestration |
| `storage` — **not present** | see §18 |

## `src/components/` (90)

Chat: `ChatInput`, `PromptBar`, `MessageList`, `MessageContent`,
`MarkdownRenderer`, `ThinkingCard`, `ThoughtStream`, `ThoughtLine`,
`ToolCallDisplay`, `QuestionCard`, `ClarificationCard`, `ApprovalDialog`,
`TodoBar`, `VirtualList`, `WelcomeSection`, `FirstRunExperience`,
`Onboarding`, `ModeSelector`, `QuotaIndicator`, `PromptMeterStrip`,
`FileUpload`, `DragDropZone`, `FilePreviewModal`.
Right panel: `RightPanel`, `DiffView`, `Terminal`, `MemoryPanel`.
Runs: `AgentManager`, `RunBoard`, `RunTimeline`, `RunLiveStatus`,
`RunHealthStrip`, `StepList`, `AgentProgress`, `AgentActivityLog`,
`ReviewStrip`, `BranchReviewPanel`, `ArtifactCard`, `ArtifactPanel`,
`CommentInput`, `ConflictCard`, `QueueRunnerProvider`, `ToolChain`.
Shell: `AppLayout`, `AppProviders`, `Providers`, `Sidebar`,
`ProjectSidebarParts`, `Header`, `TopBar`, `CommandPalette`,
`ThemeProvider`, `ThemeInit`, `Toast`, `Icons`, `ProviderIcons`,
`Skeleton`, `PanelSkeletons`, `ProgressBar`, `LatticeLoader`, `StateViews`,
`ScrollFadeManager`, `TipsDrawer`, `OfflineBanner`, `RecoverSessionPrompt`,
`ProductivityOverlays`, `BranchedMenu`, `ProjectBranchedMenu`,
`FileSystemProvider`, `HunkDecisionProvider`, `ConversationProvider`,
`WorkspaceProvider`, `WorkspaceSwitcher`, `ConnectorsPanel`,
`BugReportModal`, `AuthProvider`.
Updater: `UpdateToast`, `WhatIsNew`.
Families: `ui/` (9 — `AgentStatus`, `AISuggestions`, `FileTree`,
`KeyboardShortcuts`, `ModelSelector`, `OnboardingTour`, `QuickActions`,
`SplitView`, `TaskProgress`), `loader/` (3 — `BootGate`, `BrandSpinner`,
`GeometricLoader`).

## `src/hooks/` (14)

`useChatSession`, `useBackgroundChat`, `useConversation`, `useMessages`,
`useFileSystem`, `useFileProcessor`, `useHunkDecisions`,
`useKeyboardShortcuts`, `useActiveRunCount`, `useBootProgress`,
`useReducedMotion`, `useProjects`, `useScratchpad`, `useAppUpdater`.

## API Routes (100 handlers)

**Core**: `/api/chat` (+`/chat/fast`), `/api/conversations` (+`[id]`),
`/api/health`, `/api/auth/[...nextauth]`, `/api/debug/user`, `/api/dev/session`,
`/api/notifications`, `/api/bug-report`, `/api/open-external`,
`/api/localhost-probe`, `/api/system/memory`, `/api/session-search`,
`/api/cron/reset`.

**Auth (4)**: `/api/auth/desktop/start`, `/finish`, `/exchange`,
`/api/auth/[...nextauth]`.

**Models/keys/settings**: `/api/models/available`, `/api/models/warm`,
`/api/settings`, `/api/settings/keys` (+`/models`).

**Workspaces & projects (10)**: `/api/workspace` (+create/delete/invite/
update-member/members), `/api/workspaces/create|destroy|merge`,
`/api/workspace-file`, `/api/projects`.

**Agent (41)**: `approve`, `artifacts/[artifactId]` (+comments), `browser`,
`changes`, `checkpoints`, `context-budget`, `exec`, `grep`, `history`,
`mcp` (+`call`, `tools`), `memory` (+capture), `missions`, `notifications`
(+read), `orchestrate`, `plugin-library`, `plugins`, `preview`,
`provider-status`, `runs` (+batch, claim, `[id]`, `[id]/approve`,
`[id]/events`, `[id]/export` (+verify), `[id]/merge`), `screenshot`, `serve`,
`spend`, `terminal` (+session, stream), `uptime`, `verify`, `workspace-cwd`.

**MCP (9)**: `/api/mcp` (gateway), `servers`, `catalog`, `connections`,
`connections/[serverId]`, `connections/[serverId]/connect`, `oauth/callback`,
`oauth/complete`, `test-connection`.

**Admin (6)**: `backups`, `health`, `janitor`, `keys`, `system`, `usage`.
**Free tier**: `signup`, `usage`, `/api/user/quota`.
**Interop**: `/api/sync/push|pull`, `/api/search`, `/api/plugins`.
**Learning**: `/api/playbook` (+`[id]`, `capture`).

## Electron, CLI, Extension, Scripts, E2E

- `electron/` (13 files): `main.ts`, `preload.ts`, `tray.ts`, `updater.ts`,
  `auth-desktop.ts`, `terminal.ts`, `mcp-bridge.ts`, `app-config.json`,
  `tsconfig.json`, `assets/` (icon.icns, icon.ico, icon.png, icon32.png, tray.png).
- `cli/`: TypeScript CLI (`src/commands`: chat, config, conversations, doctor,
  status).
- `vscode-extension/`: chat sidebar, code lens, inline chat, diagnostics,
  provider selector, code actions.
- `scripts/` (23): fetch-fonts (+check-fonts-sync, font-targets), fetch-pgdump,
  local-db, orplex-mcp-server, restore-drill, audit-wiring, audit-mcp-catalog,
  clean, codemod-apibase, test-models (+test-chat-models, verify-freebuff-model),
  setup-codespace.sh, setup-env (Vercel vault sync), bench-report,
  **prepare-standalone** (finishes the standalone bundle for Electron),
  **stage-desktop-package** (minimal staging tree so electron-builder never
  scans the monorepo `node_modules`), **build-icons/make-icons**,
  `swe-bench/` (fetch-instances, run-shard, merge-results).
- `e2e/`: Playwright chat + seed specs + helpers (keyless via MOCK_AI + dev bypass).
- `tools/eslint-rules/`: custom lint rules.
- `.github/workflows/`: `ci`, `agent-sandbox`, `agent-swe-bench`, `release-app`,
  `release-drafter`, `publish-cli`, `publish-vscode`, `docs-preview`,
  `deploy-docs`.

---

# Packaging (desktop installer)

`npm run electron:dist` = `next build` → `tsc -p electron/tsconfig.json` →
`stage-desktop-package.mjs` → `electron-builder`.

- `output: "standalone"` makes Next emit a self-contained server bundle.
- `scripts/prepare-standalone.mjs` copies the two asset trees standalone
  deliberately omits (`.next/static`, `public/`) **into** the bundle, and hard-
  fails if either is missing — a missing tree is a silently broken installer
  (unstyled UI, 404s on every client chunk), not a build error.
- `scripts/stage-desktop-package.mjs` stages only what ships (`electron-dist/`,
  `electron/app-config.json`, `electron/assets/`, `.next/standalone/`) into a
  temp dir with a **dependencies-free** `package.json`. Without it,
  electron-builder scans the whole monorepo `node_modules` tree (hundreds of
  duplicate versions) for many minutes before copying anything.
- Packaged boot runs `resources/app/.next/standalone/server.js` via
  Electron's bundled Node (`ELECTRON_RUN_AS_NODE`) with `PORT`/`HOSTNAME`.
- `electron-builder.yml` equivalent lives in `package.json` → `build`.

---

# Data Flows

### Chat message (interactive)
```
ChatInput → useChatSession.sendMessage → POST /api/chat (SSE)
  → provider ladder (personal keys → key pool → env; lane-aware shaping)
  → per-model output budget + reasoning-aware params
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
  → resolveRunCredential (the run user's own key, else platform env)
  → same tool loop → approvals via ApprovalRequest table
  → artifacts + review chain → merge branch → export/verify bundle
```

### Verification
```
UI writes detected → pick dev command → free-port check (4310)
  → spawn server → Playwright load → console errors + screenshot + walkthrough
  → failures → 1 repair turn → re-verify → PASS/ISSUES verdict
```

### Auth (desktop OAuth)
```
Renderer → /api/auth/desktop/start (rate-limited by clientIp, arms
  orplex_desktop_flow cookie) → system browser → Google/GitHub
  → /api/auth/callback → /auth/desktop/finish → one-time code
  → renderer POSTs code to /api/auth/desktop/exchange (cookie must match)
  → JWT session established
```

---

# Key Patterns

- **Desktop owns the server**: Next.js is a child process; nothing user-facing
  points at it. All browser work is native Chromium.
- **Ship no secrets**: a packaged build carries `app-config.json` (backend
  origin + mode), never a `.env` — the database password must not ship.
- **Per-model parameters, never global defaults**: output budgets, token field
  names and temperature rules are resolved from the model actually selected,
  never from an effort tier, an env default, or another provider's shape.
- **Registry as the single source of truth**: providers, auth styles, model
  caps and free/paid classification all come from `provider-registry.ts`, and
  every consumer (chat lane, executor, listing, badge, quota) reads from it so
  they cannot disagree.
- **Know who is paying**: provider configs carry a `lane`
  (`personal` / `pool` / `platform`); free-tier shaping and quota waivers key
  off that and off the registry's `free` flag, never off the provider's name.
- **Learn from live rejections**: when a provider rejects a request, believe
  its stated limit and retry — but only ever downward.
- **Background singleton store**: chat/tool loop survives navigation;
  sessionStorage snapshots survive reloads.
- **Two loops, one contract**: interactive client worker and claimed server
  executor share `src/lib/agent/contract/` — no re-implemented tool logic on
  either side.
- **Honest failures**: every lane surfaces infrastructure failure distinctly
  from app failure; truncation, budget clamps and fallback substitutions are
  marked, never silent.
- **Same-origin API, cloud handlers**: the browser only ever calls `/api/*` on
  its own origin; `proxy.ts` forwards to the cloud backend (zero CORS) and
  opts machine-local routes out via `LOCAL_ONLY_API_ROUTES` /
  `LOCAL_ONLY_API_PREFIXES`.
- **Everything budgeted**: TPM pacer (global), compaction, prompt profiles,
  checkpoint caps, janitor — the 8GB/free-tier machine is the target.