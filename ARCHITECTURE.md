# Architecture — Orplex Code

> **Accuracy contract**: every file path, count and claim below is verified
> against the working tree as of **v1.0.23** (2026-10-31). When a subsystem was
> removed, this document says so rather than describing it — see §21 *Removed
> subsystems* for the list of things that used to be documented here and no
> longer exist.

## Overview

Orplex Code is an AI coding agent built as an **Electron desktop app** around an
internal Next.js 16 + React 18 + PostgreSQL backend. The user never runs the
backend: `npm run dev` (or the packaged binary) launches Electron, which spawns
Next.js as an invisible child process, owns its lifecycle, and renders the UI
in a native window. The product surface is: streaming agent chat, a real
embedded Chromium browser (user-facing AND agent-driven), live workspace file
editing with undo/checkpoints, multi-provider AI routing, durable run
orchestration with a Manager board, workspace memory, plugins/skills/MCP,
sandboxed artifact execution, capability-gated subagents, a reliability
hardening subsystem, and a user-data story that is **local-first** —
conversations, playbook learnings, the workspace registry, images and staged
files all live on the device, not in a cloud database.

There is **no embedded Postgres any more**. The database is owned by the
backend (hosted Supabase); `ORPLEX_LIGHTWEIGHT` is now inert and kept only so
existing env files stay valid.

Stack: TypeScript everywhere, Next.js 16 App Router (`output: "standalone"`),
Prisma + PostgreSQL (the cloud backend), NextAuth + an Ed25519 **app session**
(the packaged app ships no `NEXTAUTH_SECRET`), Tailwind, Playwright
(verification + E2E), Electron 41.

## How It Runs (desktop-first)

```
npm run dev           # fetch fonts → tsc electron main → prepare-electron-deps
                       # → launch BRANDED dev electron (scripts/dev-branded-electron.mjs)
                       #   (ORPLEX_DEV=1 restores checkout semantics — the renamed
                       #    binary reports app.isPackaged === true)
                       # Electron: single-instance lock → crash-recovery marker
                       #           → read app-config.json → spawn `next dev` (port 5000)
                       #           → wait for HTTP (127.0.0.1, not localhost) → open window
npm start             # tsc main + electron . — not packaged, still runs next dev
npm run dev:ui        # bare `next dev -p 5000` (no Electron)
npm run electron:dist # build → prepare-standalone → tsc main → stage → electron-builder
npm run eval:reliability
                      # run the reliability eval harness (committed baseline)
```

- **Single instance**: a second launch focuses the existing window
  (`app.requestSingleInstanceLock`); two copies never fight over the port.
- **Two possible Next children**: port **5000** is always the UI (port
  override `ORPLEX_PORT`, default 5000). Port **5010** is spawned **only when
  no `ORPLEX_API_URL` is set** (local-API mode); in cloud mode there is
  exactly one child and the UI proxies to the hosted backend
  (`app-config.json` → `https://orplex-backend.vercel.app`).
- **Packaged mode does NOT run `next start`.** It runs the Next **standalone**
  bundle directly: `.next/standalone/server.js`, shipped inside the app
  directory as `resources/app/.next/standalone/server.js`. Standalone
  deliberately bundles no `next` CLI and has no top-level `.next/server`, so
  `next start` cannot work there. A missing `server.js` shows an explicit
  "install is incomplete" dialog and exits rather than failing silently. The
  child runs via Electron's own binary with `ELECTRON_RUN_AS_NODE=1` — no
  separate `node.exe` ships — plus `NODE_ENV=production`,
  `PORT=5000`, `HOSTNAME=127.0.0.1` (IPv4; Windows `localhost` resolves to
  `::1` first, which is why `electron/loopback.ts` pins the probe URLs), and
  the device-local file paths below.
- **Crash recovery**: a session-state file (`session-state.json` in userData)
  records whether the previous run ended cleanly; a launch without the marker
  offers "Recover previous session?" (`RecoverSessionPrompt`), and the run
  ledger still holds the runs.
- **Port safety**: only a stale Orplex server from a crashed run is taken over.
  The user's own processes are never killed.
- **Quit = teardown**: the Next child is killed with the app (Windows:
  `taskkill /T /F`).
- **Config resolution order** (highest first): real shell env → repo-root
  `.env` → `electron/app-config.json`. The packaged app ships **no `.env`**
  (it holds the database password), so `app-config.json` is what carries
  `apiUrl` + `sessionPublicKey` (the **public** Ed25519 key; the private key
  stays in the backend) into an installed build.
- **Device-local state** (`app.getPath("userData")`, i.e.
  `%APPDATA%\orplex-code\`): `conversations.json` (all chats),
  `workspaces.json` (workspace registry, `ORPLEX_WORKSPACES_FILE`),
  `playbook.json` (`ORPLEX_PLAYBOOK_FILE`) and the crash marker. Every store
  is atomic-write (tmp + rename), quarantined-not-deleted on corruption, and
  survives restarts.

## High-Level Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    Electron Shell (main process)               │
│  tray + notifications · WebContentsView preview tabs           │
│  agent browser view · updater · IPC bridge (preload)           │
│  conversations JSON store · single instance · device files     │
└──────────────────────────┬─────────────────────────────────────┘
                           │ loadURL(http://127.0.0.1:5000)
┌──────────────────────────┴─────────────────────────────────────┐
│                     Renderer (React UI)                        │
│  Chat page · RightPanel (queue/changes/files/preview/terminal/  │
│  scratch) · Manager board · Settings · History · Plugins ·     │
│  Admin · Playbook · Connectors · 18-step guided tour           │
│  Context providers → hooks → background chat worker (client)   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP / SSE (src/proxy.ts — auth + cloud forward)
┌──────────────────────────┴─────────────────────────────────────┐
│               Next.js API layer (115 route handlers)           │
│  /api/chat · /api/agent/* (46) · /api/mcp/* (9) ·              │
│  /api/admin/* (6) · auth · conversations · files · models ·    │
│  settings · workspaces · projects · sync                      │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  AI providers (12 registry entries, OpenAI-compatible)         │
│  Server executor (claims runs) · verification harness          │
│  Reliability gates · subagents · Vercel Sandbox artifacts      │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│  Data: cloud Postgres (backend-owned Prisma)                   │
│  Device-local: conversations.json · playbook.json ·            │
│  workspaces.json · attachments · .orplex/ history+checkpoints  │
└────────────────────────────────────────────────────────────────┘
```

---

# Major Features

## 1. Desktop Shell (Electron)

| Piece | File | What it does |
|---|---|---|
| Main process | `electron/main.ts` (1,949 lines) | Owns the Next child, single-instance lock, port takeover, device-local conversation IPC, preview + agent-browser + terminal + MCP IPC, tray wiring, updater registration, crash-recovery marker, graceful teardown. All `handleAppIpc` handlers reject senders from outside the app's own loopback origin |
| Preload bridge | `electron/preload.ts` | `window.orplexDesktop`: `preview.*`, `agentBrowser.*`, `terminal.*`, `conversations.*`, `auth.*`, `mcp.*`, `updates.*`, `openExternal`, `getPathForFile/Directory`, versions |
| Conversations store | `electron/conversations-store.ts` | Local-first chat storage: one JSON file in userData is the source of truth; caps 50k chars/message, 200 messages/save, 60-char titles; atomic writes behind a 250 ms debounce; corrupt file **quarantined** (`.corrupt-<ts>`), never deleted; `fork` appends one " (fork)"; `importAll` is additive/idempotent for the one-time cloud import |
| Dev-mode switch | `electron/dev-mode.ts` | `isDevRuntime()` — `ORPLEX_DEV=1` forces checkout semantics for the **branded dev electron** (`scripts/dev-branded-electron.mjs`), whose renamed binary would otherwise report `app.isPackaged === true` and fail to find a standalone bundle |
| Loopback helper | `electron/loopback.ts` | `http://127.0.0.1:<port>` probe URLs. Windows resolves `localhost` to `::1` first, so the readiness probe must target the IPv4 address the child binds |
| Tray | `electron/tray.ts` | Static template icon + native notifications; polls `/api/agent/runs` every 15 s and fires on status transitions only |
| Updater | `electron/updater.ts` | electron-updater against **`Migratedboy/orplex-frountend`** (from the electron-builder `build.publish` block that becomes `app-update.yml`); auto-download, auto-install 12 s after "downloaded", checks at boot + every 6 h + on resume; notes HTML-stripped and capped at 2,000 chars; wired at `main.ts:1911` and the Help menu |
| Desktop auth | `electron/auth-desktop.ts` | Opens the system browser for the desktop OAuth flow (`orplex://`) and waits for the deep-link one-time code |
| Terminal bridge | `electron/terminal.ts` | Runs commands on the **user's device** (see §15): argument-aware screening, Git Bash on Windows, secret-stripping `buildSafeEnv` (18 env-var names removed), 1–300 s timeouts, detached serve registry |
| MCP bridge | `electron/mcp-bridge.ts` | **Remote-server OAuth 2.1** (dynamic client registration, S256 PKCE, system-browser sign-in, RFC 8252 loopback on 127.0.0.1) + a Node-side HTTP passthrough (1 MB body cap, 30 s timeout) so the renderer's MCP JSON-RPC never fights CORS. SSRF-guarded, redirects re-screened per hop |
| Shipped config | `electron/app-config.json` | `apiUrl` + `sessionPublicKey` (public Ed25519 JWK) — the packaged app has no `.env`, so this is where the backend origin comes from |
| Window | `electron/main.ts` | 1440×900 (min 940×600), dark background, menu (View/Edit roles), `window.open` → OS browser (`setWindowOpenHandler` allows only `http(s):`); legal pages forced to the OS browser so a public page can't swap the auth screen for an unlocked shell |

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
Both execution modes import the **turn loop skeleton** from ONE place —
`src/lib/agent/loop-engine.ts` (`runTurnLoop`), which owns turn caps,
empty-response stop, native-vs-text parsing, truncation handling, the loop
breaker, dispatch, result assembly AND **parallel read dispatch**
(consecutive read-only calls in one turn run concurrently, capped by the
effort tier). The claimed server executor in `server-executor/executor.ts`
runs the identical engine. Truly lane-specific behaviour is supplied as hooks;
pure shared logic still lives in `src/lib/agent/contract/`.

- **Context building** (`context-builder.ts`, `client-signatures.ts`): M3-aware
  workspace context — disk-driven per-candidate reads, signature tiers for
  large repos, prompt budgets sized to the model's window.
- **Budgeting**: token estimation, `fitMessagesToBudget` (line-boundary caps
  with explicit cut markers), rolling-60s TPM pacing (`reserveTokenWindow`),
  **summarizing compaction** (`compaction.ts`), and a live **context meter**
  (`context-meter.ts`) — `readContextMeter` grades each pre-call transcript
  `ok / warn (0.7) / critical (0.85) / over` so compaction pressure escalates
  in steps instead of discovering the wall with a 429.
- **Effort budgeting** (`effort.ts`): complexity tiers `trivial / standard /
  elevated / critical` (deterministic prompt scoring — no ML, no network) map
  onto per-loop constants: turn caps, repair rounds, verify rounds,
  parallel-tool limit, subagent limit. A typo fix does not burn the free-tier
  TPM budget a fullstack app needs.
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
  - The plan gate (`plan-gate.ts`) covers **every** workspace-mutating tool —
    `write_file`, `write_file_chunk`, `edit_file`, `batch_edit`,
    `undo_last_change`, `run_command`, `move_file`, `delete_file`.
  - It also covers the **server-side strategy router**: SPARC/ToT planned
    writes are gated too.
- **Failure learning**: `failure-memory.ts` + persistent `run-ledger.ts`
  (Prisma TaskRun/TaskFailure, written through `/api/agent/ledger` — the
  ledger payloads used to be posted to the file-undo route, which 400'd every
  one of them, so cross-restart failure learning never worked) re-seed new
  tasks with what actually failed last time; `master-prompt.ts` renders the
  Adaptive Failure Doctrine.
- **Message retry**: `message-retry.ts` drives retry of a failed assistant
  turn instead of stranding the conversation.
- **Honest failure vocabulary**: `error-guidance.ts` gives every lane a shared
  failure taxonomy so infrastructure failure never reads as app failure.

## 5. Tool Belt (41 tools)

Tool schemas live in `tool-definitions.ts`; dispatch is
`agent/native-tools.ts`. Every result is explicit XML — unknown tools error
instead of hanging.

**File & code** (16): `read_file` (offset/limit paging; paged re-reads are
never short-circuited by the duplicate-read guard), `write_file` (+chunked),
`create_file` (stages a deliverable in app **memory** for a download card —
never disk, never Postgres, see §14), `edit_file`, `batch_edit`,
`extract_archive` (local extraction — the cloud tool loop can't see the
user's disk), `list_files`, `search_code`, `code_search`, `mcp_call`,
`spawn_subagent`, `web_search` (Google→Bing chain).

**Execution**: `run_command`, `run_in_sandbox`, `undo_last_change`. Serve
commands passed to `run_command` are auto-detected and detached — there is
no separate serve tool.

**Web & media**: `take_screenshot`, `preview_browser`, `verify_app`.

**Reasoning aids**: `todo_list`, `ask_question`, `ask_clarification`,
`playbook_search`, `session_search`, `scratchpad_update`, `skill_create`,
plus the full `browser_*` set (15 ops).

- **Provider tiering**: `COMPACT_TOOL_PROVIDERS` (groq, nvidia) receive the
  compact schema set because the full one exceeds their free-tier TPM cap;
  `FULL_TOOL_PROVIDERS` (11 entries) get everything; `usesCompactTools()`
  selects. One flat tool set is **not** always sent.
- **Exec security**: `exec-guard.ts` screens command text beyond the static
  blocklist in `constants.ts`; hosted deployments run `AGENT_EXEC_DISABLED=1`
  and `run_command`/`run_in_sandbox` dispatch to **Vercel Sandbox microVMs**
  instead (see §14).
- **Risk gating**: `risk-classifier.ts` → low auto-approved, medium approval
  dialog (`approval-store.ts` + `ApprovalDialog`), high forced review.
- **Reliability gates** (§12) additionally validate tool ARGUMENTS
  (`tool-args.ts`, Zod), jail write PATHS (`path-jail.ts`) and screen
  INJECTION in tool output (`injection-scanner.ts`) under feature flags.

## 6. Verification Lanes (prove it works)

- **Typecheck lane**: after UI-relevant writes the worker runs
  `npx tsc --noEmit` in the workspace and feeds failures to a repair turn.
- **Browser lane**: `browser-verification/index.ts` spawns the project's dev
  server (command picked by `ui-paths.ts`, free port 4310), loads the page in
  headless Chromium, captures console errors/warnings + screenshot +
  **replayable walkthrough** (`walkthrough.ts`). Failures trigger one model
  repair turn, then re-verify. URL policy: default private-host/metadata SSRF
  denylist + allow/denylists. Playwright is an **optional** dependency, so it
  is imported through a non-literal specifier — a literal makes the bundler
  fail to resolve a package that is legitimately absent.
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
  runs are swept by a ghost-run reaper (**30-min** window). `server-executor/batch.ts`
  owns the batch claim/execution path.
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
  serves the requested model, falling back to the platform env.

## 9. Memory (three permanent buckets + one ephemeral scratchpad)

All writes go through the tiny API in `memory.ts` (a barrel over the buckets'
modules).

| Bucket | File | Storage | Purpose |
|---|---|---|---|
| Project instructions | `project-memory.ts` | `orplex.md` files in the workspace | User-owned hierarchy injected into system prompts, token-disciplined |
| Workspace learnings | `workspace-memory.ts` (+ client) | Prisma WorkspaceMemory | Evidence-backed memories derived from completed runs; score-based retrieval (path overlap + recency + reinforcement — no embeddings needed at this scale); `/remember <fact>` pinning; forget API; eviction capture |
| Playbooks | `playbook.ts` + `/api/playbook` | **Device-local JSON file** (`ORPLEX_PLAYBOOK_FILE`, default `%APPDATA%\orplex-code\playbook.json`) | Evidence-gated learning from verified runs, merged on repetition (confidence +0.1, decay ×0.85, bounded [0.1, 1]), retrieval by cosine similarity over the local MiniLM embeddings (25 candidates); caps 250 entries/project, 500/1500 chars. The user can pin/edit/delete. Chromium-DB-free on purpose: the database being down must not blank the Playbook page; entries live on THIS device, local-first |
| Run / failure ledger | `run-ledger.ts` + `failure-memory.ts` | Prisma TaskRun/TaskFailure via `/api/agent/ledger` | What actually failed and why; survives restarts |
| Scratchpad (ephemeral) | `scratchpad.ts` | process memory | Current plan / hypotheses / findings / next — per-task only, never persisted |
| Tools & routes are LOCAL_ONLY (§17) | memory-file-store | — |see §14 |

- **Retrieval substrate**: `embeddings.ts` runs a local MiniLM ONNX encoder
  (384-dim cosine similarity); the ONNX dependency is **optional** and loaded
  behind a runtime import.
- The old Sona/vector tables remain in the schema but the orchestrator no
  longer treats them as a first-class store; `workspace-memory.ts` is the
  successor and says so in its header.

## 10. Models & Providers

- **Provider registry** (`provider-registry.ts`): single source of truth with
  **12 providers** — `groq`, `nvidia`, `openrouter`, `anthropic`, `gemini`,
  `mistral`, `deepseek`, `together`, `xai`, `cerebras`, `fireworks`, `openai`.
  All are OpenAI-compatible for chat; listing differs per provider via
  `authStyle` + `listPath` + `extraHeaders`. Per-provider knobs:
  `modelsCap`, `maxListPages`, `probeSpacingMs`, `keyPrefix`, `fallbackModel`,
  `free`.
- **Default models** (`default-models.ts` + shared by `ChatInput` and the
  `PromptBar` picker): a free-only curated list under a persistent "Default
  Models" group; ids verified against the **live OpenRouter catalogue** and
  deduped at merge; `jest` guards assert uniqueness, live presence and
  0-cost pricing so an id cannot rot silently into user-facing 404s. One prior
  revision shipped a bogus id from a pricing page — the test is the
  regression gate against that.
- **AI layer** (`ai-providers.ts`): OpenAI-compatible base adapter; `retry.ts`
  for transient errors (**408/429/5xx/522/524**); `circuit-breaker.ts`
  (threshold 3, 5-minute open window); `key-pool.ts` round-robin with quota
  tracking; `key-encryption.ts` at rest.
- **Per-model request budgets** (`model-output-caps.ts`): every request's
  output-token budget is resolved from the **model actually selected**,
  never from a global/effort-tier default. Reasoning families also get
  `max_completion_tokens` instead of `max_tokens` and **no** `temperature`.
  When a provider still rejects the budget, the retry ladder **learns its
  stated ceiling** from the 400 body across all providers and retries — and
  only ever accepts a ceiling *lower* than requested.
- **Model routing** (`model-router.ts`): 3-tier task routing (advisory only).
- **Live catalog** (`model-catalog.ts` + `/api/models/available`): probes
  every platform-provider model with a real completion; only answering models
  are listed; cold-start models tagged `cold`. The **long-lived local app**
  does the sweep and publishes the snapshot server-side via
  `catalog-ingest.ts` + `/api/models/ingest` (monotonic on `probedAt` — a
  newer list can never be rolled back by an older client). Serverless
  cold-starts serve the rescued snapshot; `/api/models/available?local=1` is
  the local-only escape hatch (§17).
- **BYOK listing** (`provider-models.ts`): fetches a provider's **entire**
  catalogue with the user's key; cap 2000 + per-provider `modelsCap`, applied
  **after** ranking free-first then largest-context. Responses report
  `listedTotal` / `truncated` / `pages`.
- **Fast side calls** (`fast-provider.ts`): one shared "fastest configured
  provider that answers for free" pick (Groq `gpt-oss-20b` first, then NVIDIA)
  used by `/api/chat/fast` and `/api/chat/suggestions` (follow-up chips — a
  dead provider degrades the feature, never the chat).
- **Autonomous catalogues** (`catalog-sync.ts`): adding a key populates it
  immediately; opening the picker repairs stale (>6h) catalogues.
- **Keys**: `UserApiKey` / `ApiKeyPool` encrypted at rest (AES-256-GCM via
  `ENCRYPTION_SECRET`); ownership scoped on read and write.
- **Free-tier discipline**: `free-tier/quota-manager.ts`, `rate-limiter.ts`
  (**fixed** 60s window), `tpm-pacer.ts` (process-wide token bucket shared by
  ALL callers), `prompt-meter.ts`, `cost-estimator.ts`, `spend-format.ts` +
  `/api/agent/spend`, `/api/free/*`. A user's own **paid** key lifts the
  platform quota; free-tier shaping applies by lane (`personal` / `pool` /
  `platform`), never by provider name.
- **Per-model vision gate** (`vision-models.ts`): the provider-level
  `supportsVision` flag cannot be trusted for a specific model id — a
  text-only id behind a vision-capable proxy answered with a silent fallback
  until the per-model gate existed.
- **Mock AI** (`mock-ai.ts`): `MOCK_AI=1` deterministic keyless stream for dev
  and E2E.
- **Skills catalog**: `skills.ts` — **117** built-in coding skills with
  frontmatter menus; `user-skills.ts` discovers `.orplex/skills/<name>/SKILL.md`.

## 11. Extensibility: Plugins, Hooks, MCP

- **Plugin system**: `plugins/{types,registry,initializer}` — tools and hooks.
  **25** built-ins under `plugins/builtin/` (API scaffold → UI components).
  (`onFileEdit` is a hook **type**, not a 26th plugin.)
- **Plugin bundles**: `plugin-bundles.ts` + `/api/agent/plugins` — install
  skills+hooks+MCP as one data-only `.orplex-plugin.json` unit.
- **Built-in plugin library**: `plugin-library.ts` + `plugin-library/` (5
  one-click bundles: quality, security, devops, domain, intelligence) +
  `plugin-library-state.ts` — materialized through the same `installPlugin()`
  path (existing user files always win), with content-based installed
  detection. Per-workspace enable/disable lives in `.orplex/bundles.json`.
- **These routes are LOCAL_ONLY now** (§17): plugins install into the
  workspace on this machine, so the cloud (no disk, no registered workspace)
  answered empty even with a folder open. `/api/agent/plugins` and
  `/api/agent/plugin-library` run on-device.
- **Declarative hooks**: `tool-hooks.ts` — `orplex.config.json` deny/notify
  rules for both agent loops.
- **Command hooks**: `user-hooks.ts` — `.orplex/hooks.json` commands run
  through exec-guard with timeouts, caps, and `ORPLEX_HOOK_*` env.
- **MCP is a 22-file subsystem** (`src/lib/mcp/` 12 files + 6 top-level
  `mcp-*.ts`):
  - `mcp/client.ts` — 194-line stdio wire-protocol client (low-spec budget)
  - `mcp/registry.ts`, `mcp/dispatch.ts`, `mcp/hub.ts` — remote-SDK connection
    hub with a status machine, backoff and `needs_reauth`
  - `mcp/flow.ts`, `mcp/store.ts`, `mcp/pending.ts`, `mcp/provider.ts` (plus
    `mcp-accounts.ts`/`mcp-auth.ts`) — OAuth dynamic-registration flow + token
    store (now **backend-owned**: `/api/mcp/*` is forwarded to the cloud, and
    the desktop keeps only the brief stdio/bridge lane in
    `electron/mcp-bridge.ts` for remote servers over the desktop lane)
  - `mcp/gate.ts`, `mcp/risk-db.ts` (server lane), `mcp/risk-hint.ts` (browser
    lane) — dual-lane risk classification, fails closed
  - `mcp/ssrf-fetch.ts` — SSRF guard across the whole SDK network surface
  - `mcp/tool-builder.ts`, `mcp/tool-snapshot.ts`, `mcp/connection-view.ts` +
    `roster-refresh` — schema building, snapshots, projections, refresh
  - **9 routes**: `/api/mcp` (gateway), `servers`, `catalog`, `connections`,
    `connections/[serverId]`, `connections/[serverId]/connect`,
    `oauth/callback`, `oauth/complete`, `test-connection`
  - `mcp-gateway.ts` — thin auth shim
  - Plus `scripts/orplex-mcp-server.mjs` stdio proxy — drive Orplex from any
    MCP host.

## 12. Reliability Hardening Subsystem (`src/lib/reliability/`, 28 modules)

Added in Phases 0–7 (see `docs/reliability/AUDIT.md`, `PHASE-0.md`,
`PHASE-1.md`, `PHASES-2-7.md`; harness + committed baseline in
`evals/reliability/`).

- **Gate pipeline** (`gates.ts`): `runGatePipeline` runs tiered lanes —
  `npx tsc --noEmit`, file-scoped eslint (only the files the task touched),
  `npx jest` — with **mandatory baseline diagnostics** (`captureBaseline`):
  without a pre-task snapshot a lane cannot distinguish a regression from a
  pre-existing failure, so it would block on errors the agent never caused.
  Every lane outcome is exit-code evidence; a lane that could not run is never
  scored as green; a red gate closes the task **FAILED**, not "done" (rubric
  verdict-first).
- **Edit lock** (`edit-lock.ts`): when the pipeline stays red after the repair
  rounds, the task is locked so further mutations are refused with
  `recordRefusedWrite` evidence.
- **Test-integrity** (`tamper-detector.ts` 11 signals, `flake-control.ts`
  classifies flaky outcomes to quarantine instead of repair,
  `protected-paths.ts` raises risk for protected test files).
- **Structured edits** (`edit-ops.ts` `apply_edit_ops` + `atomic-batch.ts`
  atomic multi-op rollback), **path jail** (`path-jail.ts` outside-workspace
  writes refused), **tool-arg validation** (`tool-args.ts` Zod schemas shared
  by both lanes).
- **Taint/provenance** (`provenance.ts` six call origins, `injection-scanner.ts`
  untrusted-content instruction detection, `scrubber.ts` output secret
  scrubbing, `egress-policy.ts`, `capability-policy.ts` prose-origin writes /
  egress / tainted-path approval ladder).
- **Loop/progress guard** (`progress-hash.ts` stall detection, budget
  tracking), **durable memory** (`failure-ledger.ts`, `flake-registry.ts`,
  `compaction-state.ts`), **roles + reviewer panel** (`roles.ts`,
  `reviewers.ts`, `risk-tiering.ts`), **acceptance** (`acceptance.ts` spec
  extraction from task text → `acceptance-gate.ts` evaluation,
  `verifyAcceptanceFirst`), **verification report** (`verification-report.ts`
  per-run audited verdict artefact).
- **Feature flags** (`flags.ts`): everything is behind
  `RELIABILITY_GATES=1` plus per-lane flags (`RELIABILITY_EDIT_LOCK`,
  `RELIABILITY_INJECTION_SCAN`, `RELIABILITY_CAPABILITY_POLICY`,
  `RELIABILITY_TAINT` (not `_PROVENANCE` — a doc used the wrong name once),
  `RELIABILITY_REPORT`, ...) so the shipped defaults stay unchanged.
- **Eval harness** (`evals/reliability/run.mjs`, `npm run eval:reliability`):
  real task fixtures (hallucinated import, test-deletion tamper, flaky-test
  misread, slow-gate timeout, prompt-injection README, weak-test regression)
  plus capability probes and trap checks; the **committed baseline** is
  `evals/reliability/baseline.json` (26/30 capability presence; the 4 gaps —
  shadow worktree for the browser lane, diff-coverage gate, import resolver,
  dependency tool — are real and tracked).
- **Honest wiring note** (the accuracy contract cuts both ways): the
  harness's capability probe is source-grepping, so it can credit a module
  that exists but is not fully engaged at runtime. A read-only code audit
  found the flagship guarantees **partially inert**: the edit lock is
  acquired only after the final repair round (so it rarely refuses),
  `clearLane` has no production caller (a green lane cannot release the
  lock), provenance is hardcoded `"user"` at the dispatch site (3 of 4
  capability-policy rules unreachable), `verdict.requiresApproval` is
  computed then ignored, `buildVerificationReport` is called without
  `gates`/`acceptanceSpec` (its failure rules cannot fire), and the Phase-5
  progress/intervention results are computed and discarded
  (`background-worker.ts` ~1963–2455). 5 of the 28 modules are dead-but-
  imported, 6 are orphaned. The tiered fix list lives in the audit; until it
  lands, treat §12 as "wired under flags, composition unverified" and the
  baseline's 26/30 as **present**, not **enforcing**.

## 13. Subagents + the Shared Loop Engine

- **`agent/loop-engine.ts`**: one turn-loop skeleton for both lanes — same
  ordering, same termination rules, same parsing dialect. Ends the era of two
  hand-copied loops that drifted (the server lane lacked the
  truncation-continue path; the two parsers disagreed). Owns **parallel read
  dispatch**: consecutive read-only calls in one turn run concurrently
  (`PARALLEL_SAFE_TOOLS`), limited by the effort tier.
- **`agent/subagent.ts` (`spawn_subagent`)**: every parallel research lane,
  budgeted and sandboxed — a mini `runTurnLoop` with a deliberately tiny
  READ-ONLY surface (`list_files`, `read_file`, `search_code`, `code_search`,
  `scratchpad_read`). Answers a focused question in prose (≤~300 words) the
  parent folds into its transcript. Can never write, run commands, or browse.
  Caps: **depth 1** (subagents cannot spawn subagents), **max 2 concurrent per
  lane** (the third waits up to 120 s), **15-turn base cap**, minimum answer
  discipline (a sub-too-short answer is retried once).

## 14. Interactive Artifacts + Sandboxed Execution

- **`[ARTIFACT]` blocks** in chat render as live sandboxes (`SandboxArtifact`,
  `FileCard`). `artifact-sandbox.ts` independently **re-validates server-side**
  everything the client parser showed: max **25 files**, **80k chars/file**,
  **200k total**, entry-name regex.
- **Run/serve backends** (`vercel-sandbox.ts` + `/api/agent/sandbox/artifact-run`
  and `artifact-serve`): execution on **Vercel Sandbox microVMs**. One **warm
  VM per user+family** (`exec` | `serve`, node|python) — named pool; auth
  rides the deployment's own Vercel OIDC identity (no stored keys);
  **no secrets are ever injected** (the VM's env is empty, so shell history
  cannot leak platform credentials); VMs are persistent (filesystem
  auto-snapshot on stop, `keepLastSnapshots: 2`) so installs/caches survive
  cold starts. Run budget **90 s**, serve-poll budget **60 s** @1 s, output
  capped at **32k**, exposed ports **3000/8000**.
- **Local staging for `create_file`** (`memory-file-store.ts` +
  local-only `/api/files*`): a deliverable produced outside the workspace is
  staged in the desktop process's heap — never disk, never a database, never
  (serverless) the cloud backend, whose memory does not survive a request
  boundary. **4 h TTL** per entry (dev-shortenable via
  `ORPLEX_MEMORY_FILE_TTL_MS`), **2 MB max per file**, **2 entries per scope**
  (third evicts the oldest, tombstoned so the UI can say what happened to it,
  200-tombstone cap), Windows-reserved filenames rejected, store evaporates
  on quit **by design** and the UI says "the model had it last week".

## 15. Terminal & Dev Servers

- **Persistent shell** (`shell-session.ts`, `/api/agent/terminal/session`):
  real shell **per user** — `cd`/env persist, servers keep running, SSE
  streaming to the RightPanel Terminal tab.
- **Two execution lanes** (`terminal-lane.ts`): the single selector for both
  user-typed and agent commands — **(1)** the Electron desktop bridge, which
  runs the command on the **user's own device** (with the in-main argument-
  aware cmd screening and Git Bash), and **(2)** the API lane
  (self-hosted/cloud). Output is capped at 4000 chars per chunk.
- **One-shot exec** (`/api/agent/exec`) and **serve lane** (`/api/agent/serve`):
  long-running servers detach (never burn exec timeouts), tracked in a
  registry, with port-conflict hints (`diagnosePortConflict`).
- **Workspace CWD** (`workspace-cwd.ts`): the renderer registers the user's
  real folder; every command lane executes there. The registry is now
  **DURABLE and DEVICE-LOCAL**: `ORPLEX_WORKSPACES_FILE`
  (`%APPDATA%\orplex-code\workspaces.json`) or `<cwd>/.orplex/workspaces.json`,
  atomic-write, seeded on every boot — the in-memory Map used to die with the
  process, so every restart forgot the open folder (Plugins page back to "no
  workspace open", terminal cwd lost). Keyed by userId (a hosted deployment
  never lets user A's registration redirect user B's exec cwd — that was a
  real cross-user exposure). Write side also validates paths per-OS
  (`MAX_PATH_LENGTH = 500`); the read window/10 MB LRU hot-set live in the
  renderer hook (`useFileSystem.ts`); search runs server-side via
  ripgrep/git-grep/node-scan (`grep-search.ts`).

## 16. Admin, Ops, Observability

- **Admin area** (`/api/admin/*`, `/admin` + `/admin/system` pages): backups
  (`backup.ts` pg_dump rotation — 7 daily / 4 weekly, Windows-safe, manual
  trigger), keys, usage, system snapshot (executor state, cron, TPM pacer,
  hardware, event ring), janitor control, health.
- **Runtime state** (`runtime-state.ts`/`runtime-log.ts`): globalThis
  singletons survive dev-bundle duplication; ring-buffer logs; runtime
  message events ride `/api/agent/messages` (`appendRuntimeEvent`,
  4000-char cap).
- **Hardware watchdog** (`hardware.ts`): RAM pressure ladder
  (**70 / 85 / 92%**) with hysteresis — pause claims, shed lanes, janitor
  sweep — before Windows OOM-kills; `/api/system/memory` is deliberately
  LOCAL_ONLY (the cloud would report Vercel's RAM, not the user's).
- **Janitor** (`janitor.ts`): whitelist-only deletion of re-creatable
  artifacts, scoped to `os.tmpdir()/orplex-worktrees`; **>24h** orphaned
  worktrees removed; protected paths refused.
- **Instrumentation** (`src/instrumentation.ts`): boots the hardware watchdog,
  executor, janitor sweep, backup schedule, **cron-reset**, graceful-shutdown
  registry and model warm-up at server start.
- **Cron**: `cron-reset.ts` (advisory-locked daily quota reset; serverless-safe
  via `Authorization: Bearer <CRON_SECRET>`).
- **Error tracking**: `error-tracking.ts` (Bugsink/Sentry SDK protocol).
- **Logging**: `logger.ts` (Pino + pretty in dev).
- **Audit bundle**: hash-chained per-run export (see §8).

## 17. Sync, Storage, Deployment — the local-first line

- **`src/proxy.ts` decides which routes stay on the device**. The local Next
  server is not just a proxy; these routes answer **locally** and are never
  forwarded to the cloud:
  - `LOCAL_ONLY_API_ROUTES` (9): `/api/system/memory`, `/api/attachments`,
    `/api/attachments/extract`, `/api/agent/workspace-cwd`, `/api/files`,
    `/api/conversations`, `/api/playbook`, `/api/agent/plugins`,
    `/api/agent/plugin-library`.
  - `LOCAL_ONLY_API_PREFIXES` (4): `/api/attachments/`, `/api/files/`,
    `/api/conversations/`, `/api/playbook/`.
  - Special case: `/api/models/available?local=1` (the picker's local-sweep
    escape hatch).
  - Everything else — including **all `/api/mcp/*`** — forwards to the cloud
    backend (`ORPLEX_API_URL` → `NEXT_PUBLIC_API_BASE_URL` → no forward).
- **Why those routes are local** (each has a comment block): machine-local
  diagnostics (RAM), the user's own disk (attachments, workspace registry,
  plugin install), stores the serverless backend cannot hold (files staging —
  module heap), data the desktop owns (conversations, playbook learnings —
  cloud copies would double-charge storage and split-brain state).
- **Peer sync**: `sync-transport.ts` + `/api/sync/{push,pull}` — signed gzip
  envelopes move files and history between machines via a hub. Signatures use
  timing-safe **double-hash** comparison; a **25 MB** decompressed / **5 MB**
  compressed gzip-bomb guard and a 500-entry pull cap.
- **Project sync**: `project-sync.ts` + `/api/projects` — per-project
  registration, reopen and thread state.
- **Deploy targets**: Vercel (`vercel.json`), Docker (`Dockerfile`,
  `Dockerfile.deploy`, `Containerfile`, `podman-compose.yml`), split
  frontend/API mode via `NEXT_PUBLIC_API_BASE_URL` (`api-base.ts`).
- **HTTP gatekeeper + cloud API forward** (`src/proxy.ts`, Edge):
  page-auth via `getToken` when `NEXTAUTH_SECRET` exists, else the
  **Ed25519 app-session cookie** (`app-session.ts`); CSP
  (`frame-ancestors 'none'`, prod/dev variants), request-ID/timing headers;
  auth-heartbeat cloud probes cached 30s-ok/5s-fail; offline
  `/api/auth/*`/`/api/dev/*` answers JSON **503** (`x-orplex-offline: 1`)
  instead of the plain-text 500 that breaks the next-auth client; a
  **version handshake** answers **426** with
  `{error, minVersion, updateRequired: true}` when
  `MIN_SUPPORTED_APP_VERSION` is set and the request lacks or fails
  `X-Orplex-App-Version` (browser-UA requests exempt) — the update card
  turns mandatory. The BACKEND owns CORS + CSRF **for forwarded routes**. The
  routes this process answers itself — the LOCAL_ONLY set in every mode, plus
  all of `/api/*` when no backend origin is configured — never reach that
  middleware, so they pass the same-origin gate in `same-origin.ts` (a
  cross-origin state-changing request is a **403**), and the app sets exactly
  one CSP, built in `csp.ts` (no static policy in `next.config.js`).

## 18. UI Surface (every panel & page)

**Pages** (`src/app/`, 14 + favicon route): `/` (chat), `/manager`, `/history`,
`/runs`, `/settings`, `/plugins`, `/packages`, `/playbook`, `/admin`,
`/admin/system`, `/auth/signin`, `/legal/privacy`, `/legal/terms` (no auth
gate; force-opened in the OS browser by the shell), `/compaction-demo`
(live preview of `ContextCompactedDivider`).

- **Chat page**: ChatInput (attachments, drag-drop, images, model picker),
  PromptBar (slash skill menu + model picker, chunked scroll-to-load menus),
  MessageList/MessageContent/MarkdownRenderer, ThinkingCard, ToolCallDisplay,
  ToolChain, ThoughtStream/ThoughtLine, QuestionCard, ClarificationCard,
  ApprovalDialog, TodoBar, QuotaIndicator, PromptMeterStrip, WelcomeSection,
  FirstRunExperience, Onboarding, VirtualList, LatticeLoader, ProgressBar,
  Skeletons, ContextCompactedDivider, SessionInsightsPopup.
- **RightPanel**: 6 tabs — **Queue · Changes · Files · Preview · Terminal ·
  Scratch**. Resizable grip, tab persistence, per-tab error boundary.
- **Manager**: RunBoard, RunTimeline, RunLiveStatus, RunHealthStrip,
  QueueRunnerProvider, StepList, AgentProgress, AgentActivityLog, AgentManager.
- **Review**: ReviewStrip, BranchReviewPanel, ArtifactCard, ArtifactPanel,
  CommentInput, ConflictCard, BranchedMenu, ProjectBranchedMenu.
- **Artifacts**: SandboxArtifact, FileCard.
- **Shell**: AppLayout, AppProviders, Providers, Sidebar (+ProjectSidebarParts),
  Header, TopBar, CommandPalette, ThemeProvider/ThemeInit, Toast, Icons,
  ProviderIcons, StateViews, ScrollFadeManager, TipsDrawer, OfflineBanner,
  RecoverSessionPrompt, ProductivityOverlays, FileSystemProvider,
  HunkDecisionProvider, ConversationProvider, WorkspaceProvider,
  WorkspaceSwitcher, BugReportModal, AuthProvider, FilePreviewModal, DiffView,
  MemoryPanel, ConnectorsPanel, ModeSelector, DragDropZone.
- **Updater**: UpdateToast (bottom-right download progress) + WhatIsNew
  (release notes shown once per installed version; the notes shown are the
  ones of the RUNNING build).
- **Guided tour** (`src/components/tutorial/tutorial-steps.ts` + `ui/OnboardingTour.tsx`):
  **18 coach-mark steps** (prompt bar → attach → MCP → modes → model → effort
  → right panel → topbar → sidebar → agents → manager → plugins → playbook →
  settings → projects → account → done), replayable from TipsDrawer/settings.
- **Families**: `ui/` (5 — AgentStatus, KeyboardShortcuts, OnboardingTour,
  QuickActions, TaskProgress), `loader/` (3 — BootGate, BrandSpinner,
  GeometricLoader).

**Counts**: **83** components (`.tsx`, excluding tests; 85 files including
`tutorial-steps.ts` and the `ui` barrel), **14** hooks.

- **Hooks**: useChatSession, useBackgroundChat, useConversation, useMessages,
  useFileSystem, useFileProcessor, useHunkDecisions, useKeyboardShortcuts,
  useActiveRunCount, useBootProgress, useReducedMotion, useProjects,
  useScratchpad, **useAppUpdater**.
- **Version handshake**: `app-version.ts` + `update-state.ts` — the desktop
  identifies its build so the backend can answer **426** when below the
  supported floor (§17), flipping the update card to mandatory.
- **Misc UX**: `navigation-events.ts` (sidebar→chat deep links), brand fonts
  self-hosted (`scripts/fetch-fonts.mjs`).

## 19. Auth & Multi-user

NextAuth (Google/GitHub, Prisma adapter) on the **backend**, plus a
**desktop-only second credential**:

- **App session** (`app-session.ts`): the packaged app ships NO
  `NEXTAUTH_SECRET` (a symmetric signing key must not live in a client
  binary), so it could not verify the backend's cookie and every signed-in
  user bounced back to signin. The backend therefore issues an **Ed25519-signed
  token** in cookie `orplex-app-session` (maxAge **7d**); the app ships only
  the PUBLIC key (`ORPLEX_SESSION_PUBLIC_KEY` via `app-config.json`) and
  verifies locally — it can check the session, nobody else can mint one.
- `server-session.ts` — local route handlers use `getToken` with the
  scheme-aware JWT-only options (plain vs `__Secure-` cookie names).
- Dev bypass (`/api/dev/session`, `dev-seed.ts`, disabled in production);
  workspaces with owner/admin/member roles; users' own API keys per provider;
  quotas per tier.

**Production env guards** (fail at boot, not mid-request):
- `prisma.ts` refuses to construct a client when `DATABASE_URL` points at
  localhost in production; `auth.ts` refuses to boot when `NEXTAUTH_SECRET` is
  unset on the shared `NEXTAUTH_URL` contract. Both are skipped during
  `next build` (`NEXT_PHASE`).

**Security posture**:
- 7-day session maxAge with daily rotation (`updateAge: 24h`).
- `allowDangerousEmailAccountLinking` disabled.
- Desktop OAuth uses double-submit cookie binding (`orplex_desktop_flow`) to
  prevent login CSRF; desktop auth rates are rate-limited by client IP.
- Admin surface fails closed: `ADMIN_USER_IDS` unset in production denies all
  admin access (loudly, so it reads as misconfiguration).
- MarkdownRenderer allows `http:`/`https:`/`mailto:` links, and images only as
  `https:` or `data:image/{png,jpg,jpeg,gif,webp};base64,` — **`svg` is
  deliberately excluded** because it executes script when opened as a document.
- Electron `setWindowOpenHandler` only allows `http(s):` URLs; legal pages go
  to the OS browser.
- Sync hub signatures use timing-safe double-hash comparison.
- Attachment bytes are SHA-256 content-addressed on the USER'S disk
  (`.orplex/attachments/`), never in Postgres; the message body carries only
  an `attachment:<id><ext>` reference.

## 20. Quality Infrastructure

- **Tests**: **201 Jest test files** (198 under `src/**/__tests__`, 3 under
  `electron/__tests__` — main-process modules, so the desktop store and the
  updater feed check are under real tests). Last full run: 2,141+ tests passed,
  1 skipped. Playwright E2E (`e2e/chat.spec.ts`, `e2e/seed.spec.ts`) using the
  mock-AI seam; `scripts/e2e/prompt-suite.mjs` for prompt regressions.
- **Reliability eval harness**: `evals/reliability/run.mjs`
  (`npm run eval:reliability`) with a committed baseline
  (`evals/reliability/baseline.json`) and task fixtures; the output is a
  deterministic PASS/FAIL-able capability score (see §12 for the harness's
  honest limitation).
- **Hard verdicts + rubric recorder**: `rubric-recorder.ts` grades live runs
  against the master-prompt rubric into JSONL; every finished run gets a
  binary PASS/FAIL verdict (done AND no failed lane — skipped lanes never
  fail); verdict-first trend reports catch prompt regressions.
- **Benchmark report**: `src/lib/benchmark-report.ts` + `npm run bench:report`
  → `scripts/bench-report.mjs` — cost-adjusted aggregation over the TaskRun
  ledger, with per-hard-PASS cost as the headline number plus recurring
  TaskFailure signatures. The script transpiles the TS core with the
  TypeScript compiler API (plain node cannot import TS).
- **SWE-bench Lite harness**: `scripts/swe-bench/` +
  `.github/workflows/agent-swe-bench.yml`; documented caveat: measures the
  dataset's own test commands on plain clones.
- **CI sandboxed exec**: `ci-sandbox.ts` + `.github/workflows/agent-sandbox.yml`
  — when local exec is disabled (hosted), `run_command` dispatches to an
  ephemeral GitHub Actions runner (correlated by a run-name token).
- **Custom ESLint rules**: `tools/eslint-rules/`; wiring auditor
  (`scripts/audit-wiring.mjs`).
- **Updater feed check**: `scripts/check-updater-feed.mjs` — walks the exact
  chain the in-app updater walks (releases/latest → channel yml → installer
  asset → blockmap) and fails loudly on incoherence; no `gh` CLI needed.
- **Companion surfaces**: `cli/` (Orplex CLI), `vscode-extension/` (chat
  sidebar, code lens, inline chat, diagnostics, provider selector),
  `docs-site/` (Docusaurus), `logo/` (widget).

## 21. Removed subsystems (documented previously, no longer in the tree)

Recorded so nobody re-adds a reference to them:

| Removed | What replaced it |
|---|---|
| **Embedded local Postgres** (`electron` bootstrap via `scripts/local-db.mjs`, port 5433) | nothing — the backend owns the database; `ORPLEX_LIGHTWEIGHT` is inert (kept for env-file compat); the script survives and is referenced only by `scripts/e2e/prompt-suite.mjs` |
| Every eval harness in `eval/` (52 tasks) | `evals/reliability/` (Phases 0–7) |
| `benchmark-report.ts` | restored + under test (it had been deleted while `bench-report.mjs` kept reading it) |
| `storage-service.ts` (content-addressed blob store) | nothing — attachment bytes go to the user's disk |
| `checkpoint-sync.ts` | nothing |
| `merge/crdt.ts` (line-level CRDT) | worktree merge preview/apply; conflicts surface as `ConflictCard` |
| `circuit-breaker-reset.ts` | in-module 5-minute expiry in `circuit-breaker.ts` |
| `rate-limit-store.ts`, `lazy-modules.ts`, `tool-handlers.ts`, `code-generators.ts` | consolidated / superseded |
| `plugins/server-middleware.ts` | nothing — plugins expose tools and hooks only |
| `CodeEditor` (Monaco) component | `DiffView` + `FilePreviewModal` |
| `MiniMax` as a registry provider | 12-entry registry; MiniMax survives only as a cost-pricing reference |
| built-in plugin "file-edit hooks" | `onFileEdit` is a hook type on the registry, not a plugin |
| UI family members previously listed as `ui/` components (`AISuggestions`, `FileTree`, `ModelSelector`, `SplitView`) | never/longer present — `ui/` is now 5 components + a barrel |
| remote MCP token store in the local process | `/api/mcp/*` forwards to the cloud; the desktop keeps only `electron/mcp-bridge.ts` for remote servers |

### Honesty notes for the insight store

These are deliberate degradations, not gaps:

- **Zero vector = "embedder unavailable".** `SonaTrajectory.embedding`,
  `SonaPattern.embedding` and `VectorMemoryEntry.embedding` are required JSON
  columns, but the ONNX encoder is an *optional* ~25 MB dependency. When it
  cannot load, rows are written with a zero vector instead of being dropped —
  the text (the valuable part) is preserved, and a zero vector scores 0 against
  every query so it never pollutes ranking.
- **Recall labels its fallback.** If nothing clears the semantic floor, recall
  falls back to a keyword match and marks every hit `match: "keyword"`.
- **A pattern needs evidence.** A tool sequence is promoted only after
  `PATTERN_MIN_SAMPLES` trajectories AND a ≥60% observed success rate, and
  `partial` counts as a non-success. Better no pattern than a bad one.

- **Agent insights** (`agent-insights.ts` + `/api/agent/insights`): a durable,
  queryable record of what the agent actually did — `Task`/`ToolCall` audit
  trail, per-stage timing (`PipelineStep`), dependency edges, trajectories
  (`SonaTrajectory`), **tool sequences learned from measured outcomes**
  (`SonaPattern`), semantic recall (`VectorMemoryEntry`). Written on both the
  success and failure paths; pattern mining is a batch step (`?learn=1`).
  The store-side debt (reliability §12) is tracked in `docs/reliability/` and
  the harness gate report, and every write is individually guarded:
  telemetry must never fail a run.

---

# Module Map

## `src/lib/` — Core (139 root files)

| File | Purpose |
|---|---|
| `constants.ts` | All magic numbers, timeouts, limits, blocked commands |
| `types.ts` | Branded types, discriminated unions, type guards |
| `errors.ts` / `error-guidance.ts` | AppError hierarchy + shared failure-mode vocabulary |
| `validators.ts` | Zod schemas + sanitization + injection detection |
| `logger.ts` | Pino logging |
| `prisma.ts` | Prisma singleton (localhost guard) |
| `auth.ts` / `desktop-auth.ts` / `app-session.ts` / `server-session.ts` | NextAuth options; OAuth; Ed25519 app session; scheme-aware local `getToken` |
| `admin-auth.ts` | Admin gate (fails closed in production when unset) |
| `graceful-shutdown.ts` | SIGTERM/SIGINT cleanup registry |
| `error-tracking.ts` | Bugsink/Sentry integration |
| `api-base.ts` / `conversations-transport.ts` | Same-origin/split base resolution; conversation CRUD over the `conversations.*` Electron bridge or the cloud lane |
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
| `tool-definitions.ts` | 41 OpenAI function schemas + provider compact/full tiering |
| `agent/native-tools.ts` | Tool dispatch via the shared contract (+ Electron IPC transport) |
| `agent/loop-engine.ts` | THE shared turn-loop skeleton (both lanes): caps, parsing, truncation, loop breaker, parallel read dispatch |
| `agent/subagent.ts` | `spawn_subagent`: depth-1, 2-per-lane, 15-turn read-only research subagents |
| `agent/contract/` | Pure shared contract: `tools` (arg rules), `risk`, `loop` (detection), `scratchpad`, `browser`/`browser-server`, `results`, `index` barrel |
| `agent/file-ops.ts` / `agent/serve-helpers.ts` / `agent/archive-extract.ts` | Audited writes; serve detection; local archive extraction |
| `agent/runtime/*` | Run scheduler + service (claiming, sweeping) |
| `memory.ts` | Memory barrel (see §9) |
| `context-builder.ts` / `client-signatures.ts` | Disk-driven context windows; signature extraction |
| `compaction.ts` / `context-meter.ts` | Compaction + live pre-call context gauge |
| `effort.ts` | Complexity-tier budgets (turns, repairs, verifies, parallelism, subagents) |
| `failure-memory.ts` / `run-ledger.ts` | Adaptive failure doctrine; persistent ledger (+ `/api/agent/ledger`) |
| `scratchpad.ts` | Agent private working memory, re-shown every turn |
| `loop-detect.ts` | Streak loop detection + `[LOOP BREAK]` directive |
| `memory-note.ts` | Low-memory failure annotation |
| `prompt-meter.ts` / `tpm-pacer.ts` | Token accounting / global TPM bucket |
| `queue-runner.ts` | Idle-tab claiming of scheduled runs |
| `risk-classifier.ts` / `plan-gate.ts` / `approval-store.ts` | Risk tiers, plan latch, approvals |
| `reflection-loop.ts` / `code-quality-checker.ts` | Self-correction, static quality scoring |
| `vision-preprocessor.ts` / `vision-models.ts` / `walkthrough.ts` | Vision prep, per-model vision gate, replayable walkthroughs |
| `rubric-recorder.ts` | Live-run rubric grading + trends |
| `board-format.ts` / `spend-format.ts` / `tool-chain.ts` / `format-tokens.ts` | Pure UI presentation helpers |
| `ui-paths.ts` | UI-work detection, verify port, dev-command picker |
| `embeddings.ts` | Local MiniLM ONNX embeddings (optional dependency) |

## `src/lib/` — Reasoning & orchestration

| File | Purpose |
|---|---|
| `strategy-router.ts` | Deterministic strategy pick + all 5 strategies |
| `model-router.ts` | 3-tier task→model routing (advisory only) |
| `cost-estimator.ts` | Pre-run cost estimation |
| `semantic-cache.ts` | DEPRECATED — kept only for tests |

## `src/lib/` — Providers & keys

| File | Purpose |
|---|---|
| `ai-providers.ts` | OpenAI-compatible adapters, per-model token params, auth styles |
| `provider-registry.ts` | Canonical 12-provider defs |
| `provider-models.ts` | BYOK full-catalogue listing + budget-guarded verify |
| `catalog-sync.ts` / `catalog-ingest.ts` | Autonomous catalogue maintenance; server-side store for rescue-published sweeps |
| `model-catalog.ts` | Platform/local model probing for the picker |
| `default-models.ts` | The free-only curated default list (unique, live-verified, tested) |
| `fast-provider.ts` | The fastest free side-call provider (chat/fast, suggestions) |
| `model-output-caps.ts` | Per-model output budgets + live 400-error cap learning |
| `byok-credentials.ts` | Resolves which API key a run should use |
| `provider-uptime.ts` | Per-provider reliability ledger |
| `retry.ts` | Transient-error retry helpers |
| `key-pool.ts` / `key-encryption.ts` | Key pooling + AES-256-GCM at rest |
| `chat-middleware.ts` | Composable chat API chain (auth, quota, provider ladder) |
| `mock-ai.ts` | Keyless mock stream (dev/E2E) |
| `skills.ts` / `user-skills.ts` | 117 built-in skills + user SKILL.md |
| `free-tier/quota-manager.ts` / `rate-limiter.ts` | Tier quotas, fixed-window limits, `clientIp()` |

## `src/lib/` — Browser, artifacts, verification

| File | Purpose |
|---|---|
| `agent-browser-session.ts` | Server-side Playwright browser_* sessions |
| `browser-verification/index.ts` | Dev-server boot + Playwright verify harness, URL policy |
| `vercel-sandbox.ts` | Vercel Sandbox microVM pool (run + serve lanes) |
| `artifact-sandbox.ts` | Independent server-side [ARTIFACT] validation |
| `memory-file-store.ts` | `create_file` staging store (memory-only, TTL'd) |

## `src/lib/` — Reliability (28 files)

See §12. `gates`, `edit-lock`, `edit-ops`+`atomic-batch`, `path-jail`,
`tool-args`(+`zod-errors`), `tamper-detector`, `protected-paths`,
`provenance`, `injection-scanner`, `scrubber`, `egress-policy`,
`capability-policy`, `progress-hash`, `verification-report`,
`acceptance`+`acceptance-gate`, `flake-control`+`flake-registry`,
`failure-ledger`, `compaction-state`, `roles`, `reviewers`, `risk-tiering`,
`hash`, `types`, `flags` — all behind `RELIABILITY_*` flags.

## `src/lib/` — MCP (22 files)

| File | Purpose |
|---|---|
| `mcp-client.ts` / `mcp-gateway.ts` | stdio client / thin auth shim |
| `mcp/{client,registry,dispatch,hub}.ts` | Connection registry, dispatch, remote-SDK hub |
| `mcp/{flow,store,pending,provider}.ts` | OAuth dynamic registration + token store |
| `mcp/{gate,risk-db,risk-hint}.ts` | MCP enable gate + dual-lane risk (fails closed) |
| `mcp/ssrf-fetch.ts` | SSRF gate across the SDK network surface |
| `mcp/{tool-builder,tool-snapshot,connection-view}.ts` | Schema building, snapshots, UI projection |
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
| `workspace-cwd.ts` | Durable device-local workspace registry (userId-keyed) |
| `workspace/workspace-manager.ts` | Workspace CRUD/queries |
| `workspace-memory.ts` / `workspace-memory-client.ts` | Learnings store + browser client |
| `project-memory.ts` | orplex.md injection |
| `attachment-store.ts` / `client-attachments.ts` | Local content-addressed attachment store + its client half |
| `project-{registry,sync,threads,menu,reopen}.ts` | Project CRUD, sync, threads, menus |

## `src/lib/` — Execution, servers, search

| File | Purpose |
|---|---|
| `server-executor/{executor,batch}.ts` | Claims + executes Manager runs (full lane parity); batch claim/execution |
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
| `plugins/*` (3 core + **25 builtins**) | Plugin system |
| `plugin-library/` + `plugin-library-state.ts` / `plugin-bundles.ts` | 5 built-in bundles; per-workspace enable state; bundle install units |
| `runtime-state.ts` / `runtime-log.ts` | Cross-bundle singletons + ring logs |
| `backup.ts` / `cron-reset.ts` | Backups / quota reset |
| `sync-transport.ts` | Signed peer-sync envelopes |
| `audit-bundle.ts` | Hash-chained flight recorder |
| `run-sync.ts` | Live→AgentRun mirroring |
| `dev-seed.ts` / `strategy-router.ts` | Dev data / orchestration |
| `agent-insights.ts` | Insights summary / pattern learning (`/api/agent/insights`) |
| `storage` — **not present** | see §21 |

## `src/components/` (83 .tsx)

Chat: `ChatInput`, `PromptBar`, `MessageList`, `MessageContent`,
`MarkdownRenderer`, `ThinkingCard`, `ThoughtStream`, `ThoughtLine`,
`ToolCallDisplay`, `QuestionCard`, `ClarificationCard`, `ApprovalDialog`,
`TodoBar`, `VirtualList`, `WelcomeSection`, `FirstRunExperience`,
`Onboarding`, `ModeSelector`, `QuotaIndicator`, `PromptMeterStrip`,
`DragDropZone`, `FilePreviewModal`, `ContextCompactedDivider`,
`SessionInsightsPopup`.
Artifacts: `SandboxArtifact`, `FileCard`.
Right panel: `RightPanel`, `DiffView`, `MemoryPanel`.
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
Families: `ui/` (5 — `AgentStatus`, `KeyboardShortcuts`, `OnboardingTour`,
`QuickActions`, `TaskProgress`) + `tutorial/tutorial-steps.ts`,
`loader/` (3 — `BootGate`, `BrandSpinner`, `GeometricLoader`).

## `src/hooks/` (14)

`useChatSession`, `useBackgroundChat`, `useConversation`, `useMessages`,
`useFileSystem`, `useFileProcessor`, `useHunkDecisions`,
`useKeyboardShortcuts`, `useActiveRunCount`, `useBootProgress`,
`useReducedMotion`, `useProjects`, `useScratchpad`, `useAppUpdater`.

## API Routes (115 handlers)

**Core (13)**: `/api/chat` (+`/chat/fast`, `/chat/suggestions`),
`/api/conversations` (+`[id]`, `/migrate-from-cloud`),
`/api/health`, `/api/auth/[...nextauth]`, `/api/debug/user`,
`/api/dev/session`, `/api/notifications`, `/api/bug-report`,
`/api/open-external`, `/api/localhost-probe`, `/api/system/memory`,
`/api/session-search`, `/api/cron/reset`.

**Auth (3 + nextauth)**: `/api/auth/desktop/{start,finish,exchange}`.

**Files & attachments (7)**: `/api/files` (+`[id]`, `[id]/status`, `demo`),
`/api/attachments` (+`[id]`, `extract`).

**Models/keys/settings (7)**: `/api/models/{available,ingest,warm}`,
`/api/settings` (+`/keys`), `/api/settings/keys/models`.

**Workspaces & projects (10)**: `/api/workspace` (+create/delete/invite/
members/update-member), `/api/workspaces/{create,destroy,merge}`,
`/api/workspace-file`, `/api/projects`.

**Agent (46)**: `approve`, `artifacts/[artifactId]` (+comments), `browser`,
`changes`, `checkpoints`, `context-budget`, `exec`, `grep`, `history`,
`insights`, `ledger`, `memory` (+capture), `messages`, `missions`,
`mcp` (+`call`, `tools`), `notifications` (+`[id]/read`), `orchestrate`,
`plugin-library`, `plugins`, `preview`, `provider-status`, `runs`
(+batch, claim, `[id]`, `[id]/approve`, `[id]/events`,
`[id]/export` (+`verify`), `[id]/merge`), `sandbox/{artifact-run,artifact-serve}`,
`screenshot`, `serve`, `spend`, `terminal` (+session, stream), `uptime`,
`verify`, `workspace-cwd`.

**MCP (9)**: `/api/mcp` (gateway), `servers`, `catalog`, `connections`,
`connections/[serverId]`, `connections/[serverId]/connect`,
`oauth/callback`, `oauth/complete`, `test-connection`.

**Playbook (3, local-only)**: `/api/playbook` (+`[id]`, `capture`).

**Admin (6)**: `backups`, `health`, `janitor`, `keys`, `system`, `usage`.
**Free tier (2)**: `signup`, `usage`; + `/api/user/quota`.
**Interop**: `/api/sync/{push,pull}`, `/api/search`, `/api/plugins`.

## Electron, CLI, Extension, Scripts, E2E

- `electron/` (15 files): `main.ts`, `preload.ts`, `tray.ts`, `updater.ts`,
  `auth-desktop.ts`, `terminal.ts`, `mcp-bridge.ts`,
  `conversations-store.ts`, `dev-mode.ts`, `loopback.ts`, `app-config.json`,
  `tsconfig.json`, `__tests__/` (updater, loopback, conversations-store),
  `assets/` (icon.icns, icon.ico, icon.png, icon32.png, tray.png).
- `cli/`: TypeScript CLI (`src/commands`: chat, config, conversations, doctor,
  status).
- `vscode-extension/`: chat sidebar, code lens, inline chat, diagnostics,
  provider selector, code actions.
- `scripts/` (24): fetch-fonts (+check-fonts-sync, font-targets), fetch-pgdump,
  local-db (survives, unused by the shell), orplex-mcp-server, restore-drill,
  audit-wiring, audit-mcp-catalog, clean, codemod-apibase, test-models
  (+test-chat-models, verify-freebuff-model), setup-codespace.sh, setup-env,
  bench-report, **prepare-standalone**, **stage-desktop-package**,
  **prepare-electron-deps**, **dev-branded-electron**,
  **check-updater-feed**, build-icons/make-icons,
  `e2e/prompt-suite.mjs`, `swe-bench/` (fetch-instances, run-shard, merge-results).
- `e2e/`: Playwright chat + seed specs + helpers (keyless via MOCK_AI + dev bypass).
- `tools/eslint-rules/`: custom lint rules.
- `evals/reliability/`: eval harness + fixtures + committed baseline.
- `.github/workflows/` (9): `ci`, `agent-sandbox`, `agent-swe-bench`,
  `release-app`, `release-drafter`, `publish-cli`, `publish-vscode`,
  `docs-preview`, `deploy-docs`.

---

# Packaging (desktop installer)

`npm run electron:dist` = `npm run build` → `tsc -p electron/tsconfig.json` +
`prepare-electron-deps` → `stage-desktop-package` → `electron-builder
--projectDir .desktop-package`.

- `output: "standalone"` makes Next emit a self-contained server bundle.
- `scripts/prepare-standalone.mjs` copies the two asset trees standalone
  deliberately omits (`.next/static`, `public/`) **into** the bundle, and
  hard-fails if either is missing — a missing tree is a silently broken
  installer (unstyled UI, 404s on every client chunk), not a build error.
- `scripts/stage-desktop-package.mjs` stages only what ships (`electron-dist/`,
  `electron/app-config.json`, `electron/assets/`, `.next/standalone/`) into
  `.desktop-package/` with a **dependencies-free** `package.json` (plus the
  electron-updater runtime deps). Without it, electron-builder scans the whole
  monorepo `node_modules` tree for many minutes. Windows launcher config
  (`electron-builder.yml` equivalent) lives in `package.json` → `build`
  (`asar: false`, `appId: tech.orplex.app`, product **Orplex Code**,
  publisher orplex.techlimited, NSIS/dmg/AppImage targets, GitHub publish
  block).
- Packaged boot runs `resources/app/.next/standalone/server.js` via
  Electron's bundled runtime (`ELECTRON_RUN_AS_NODE=1`) with
  `NODE_ENV=production`, `PORT`, `HOSTNAME=127.0.0.1` and the device-local
  file paths (§How It Runs).
- The update feed is the GitHub release channel of **Migratedboy/orplex-frountend**
  (`app-update.yml` generated from `build.publish`); verify it with
  `node scripts/check-updater-feed.mjs`.

---

# Data Flows

### Chat message (interactive)
```
ChatInput → useChatSession.sendMessage → POST /api/chat (SSE)
  → provider ladder (personal keys → key pool → env; lane-aware shaping)
  → per-model output budget + reasoning-aware params
  → stream-reader parses tool_calls/thinking → loop-engine turn loop
  → dispatch via native-tools (risk gate → approval? → reliability gates)
  → parallel read dispatch for consecutive read-only calls
  → tool results feed next model turn (effort-tier caps, context-meter,
    compaction between turns)
  → subagents answer focused questions in parallel when spawned
  → self-review pass → auto typecheck/browser verify (UI work) → done
  → run ledger + workspace-memory capture → board mirrors via run-sync
```

### File write (audited)
```
write_file → risk classify → approval (if needed) → reliability tool-args +
  path-jail → recordChange(prev) → File System Access write → hooks/plugins
  → durable history append → auto-checkpoint (pre-write snapshot)
  → Changes tab diff
```

### Claimed run (Manager/morning queue)
```
POST /api/agent/runs (or /batch schedules) → pending row
  → executor/tab claims (CAS) → worktree → hooks/project-memory context
  → resolveRunCredential (the run user's own key, else platform env)
  → same loop-engine turn loop → approvals via ApprovalRequest table
  → artifacts + review chain → merge branch → export/verify bundle
```

### Verification
```
UI writes detected → pick dev command → free-port check (4310)
  → spawn server → Playwright load → console errors + screenshot + walkthrough
  → failures → 1 repair turn → re-verify → PASS/ISSUES verdict
  → (if reliability gates on) SQL lanes change the rubric verdict, and a
    still-red pipeline locks the task's edits
```

### Auth (desktop OAuth + app session)
```
Renderer → orplex:auth-start → system browser → backend /api/auth/desktop/start
  → Google/GitHub → orplex://auth?code=<one-time-code> (five-min expiry)
  → renderer POSTs code to /api/auth/desktop/exchange (cookie binding checked)
  → BOTH the next-auth session cookie AND the Ed25519 orplex-app-session
    cookie are issued; the desktop verifies the latter locally from then on
```

### Local-first user data (desktop)
```
Chat send → conversations.save → Electron IPC → userData/conversations.json
  (atomic write, debounce; cloud rows stop receiving writes after the
  one-time migrate-from-cloud import)
Learnings → /api/playbook (LOCAL_ONLY) → ORPLEX_PLAYBOOK_FILE
Images → /api/attachments (LOCAL_ONLY) → <workspace>/.orplex/attachments
create_file deliverable → /api/files (LOCAL_ONLY) → app heap (4h TTL)
```

---

# Key Patterns

- **Desktop owns the server**: Next.js is a child process; nothing user-facing
  points at it. All browser work is native Chromium.
- **Ship no secrets**: a packaged build carries `app-config.json` (backend
  origin + public key), never a `.env` — and it its session credential is
  Ed25519 so the signing key never ships either.
- **User data is local-first**: conversations, playbook learnings, the
  workspace registry, attachments and staged files live on the device;
  `LOCAL_ONLY` routes make this hold on the wire, not just in intent.
- **Per-model parameters, never global defaults**: output budgets, token field
  names and temperature rules are resolved from the model actually selected,
  never from an effort tier, an env default, or another provider's shape.
- **Registry as the single source of truth**: providers, auth styles, model
  caps and free/paid classification all come from `provider-registry.ts`.
- **Know who is paying**: provider configs carry a `lane`
  (`personal` / `pool` / `platform`); free-tier shaping and quota waivers key
  off that and off the registry's `free` flag, never off the provider's name.
- **Learn from live rejections**: when a provider rejects a request, believe
  its stated limit and retry — but only ever downward.
- **Two lanes, one engine**: interactive client worker and claimed server
  executor share `agent/loop-engine.ts` + `agent/contract/` — no re-implemented
  turn logic on either side.
- **Honest failures**: every lane surfaces infrastructure failure distinctly
  from app failure; truncation, budget clamps, quarantines and fallback
  substitutions are marked, never silent.
- **Same-origin API, cloud handlers**: the browser only ever calls `/api/*` on
  its own origin; `proxy.ts` forwards to the cloud backend (zero CORS) and
  opts machine-local routes out so the local process answers them.
- **Everything budgeted**: TPM pacer (global), effort tiers, context meter,
  compaction, prompt profiles, checkpoint caps, janitor — the 8GB/free-tier
  machine is the target.
- **Feature-flag the hardening**: the reliability subsystem ships inert and
  turns on lane by lane (`RELIABILITY_GATES=1` + per-lane flags), so the
  shipped defaults stay unchanged while each guarantee is proven.
