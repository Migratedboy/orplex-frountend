# Orplex Code — Complete UI Layout & Reference (A → Z)

> **Everything** the Orplex Code UI (web + desktop) can show and do, region by region, screen by screen.
> App: `orplex-code` v2.x — "the AI coding agent for your desktop and cloud."
> Source of truth: `src/app`, `src/components`, `src/components/right-panel`, `src/components/settings`, `src/lib`, `electron/`.

---

## Table of Contents

1. [Route map](#1-route-map)
2. [App shell (overall layout)](#2-app-shell)
3. [Left sidebar](#3-left-sidebar)
4. [Top bar](#4-top-bar)
5. [Right panel (6 tabs)](#5-right-panel)
6. [Chat experience (home)](#6-chat-experience)
7. [Prompt bar (composer) — every control](#7-prompt-bar)
8. [Slash commands (skills)](#8-slash-commands)
9. [@-mentions, attachments & drag-drop](#9-mentions-attachments-dragdrop)
10. [Quick actions & suggestion chips](#10-quick-actions)
11. [Message rendering & activity](#11-message-rendering)
12. [Tool calls & chain display](#12-tool-calls)
13. [Artifacts (10 kinds)](#13-artifacts)
14. [Diff view & changes review](#14-diff-view)
15. [Task plan (Todo bar)](#15-task-plan)
16. [File cards](#16-file-cards)
17. [Context compaction divider](#17-context-compaction)
18. [Command palette (Ctrl+K)](#18-command-palette)
19. [Connectors panel (MCP servers)](#19-connectors-mcp)
20. [Modals, dialogs & popups](#20-modals-dialogs)
21. [Onboarding, tour & first-run](#21-onboarding)
22. [Settings page — every tab & setting](#22-settings)
23. [Agent Manager](#23-agent-manager)
24. [Runs Board](#24-runs-board)
25. [Run timeline & health strip](#25-run-timeline)
26. [Memory page & memory panel](#26-memory)
27. [Plugins page](#27-plugins)
28. [Packages page](#28-packages)
29. [Admin pages](#29-admin)
30. [Auth, legal & error states](#30-auth-legal-errors)
31. [Embedded browser tab (desktop)](#31-embedded-browser)
32. [Desktop (Electron) exclusive UI](#32-desktop-electron)
33. [Keyboard shortcuts — full list](#33-keyboard-shortcuts)
34. [Theming & appearance](#34-theming)
35. [Toasts, banners & status surfaces](#35-toasts-banners)
36. [Loading, empty & error views](#36-loading-empty-error)
37. [Mobile behavior](#37-mobile)
38. [Persistence & app events](#38-persistence)
39. [The mascot](#39-mascot)

---

## 1. Route map

| Route | What it is |
|---|---|
| `/` | Main chat surface — welcome screen, message list, streaming answers, background-task handoff |
| `/settings` | 7-tab settings hub (Profile / Appearance / Cost / API keys / Database / About / Danger) |
| `/manager` | Agent Manager — spawn/kill background agents, inbox, health strip |
| `/runs` | Runs Board — kanban-style mission control for all agent runs |
| `/memory` | Memory / playbook editor (what the agent remembers & follows) |
| `/playbook` | Redirects to `/memory` (kept as a legacy alias) |
| `/history` | Redirects to `/` (chat history lives in the sidebar) |
| `/plugins` | Plugin / MCP manager |
| `/packages` | Package manager |
| `/compaction-demo` | Developer demo of the context-compaction divider in 6 states |
| `/auth/signin` | Sign-in page (renders outside the app shell) |
| `/legal/terms` · `/legal/privacy` | Legal pages |
| `/admin` · `/admin/system` | Admin dashboard & system status (keys, backups, hardware/memory/janitor/watchdog) |
| `not-found` / `error` / `global-error` / `loading` / `template` | Global 404, error boundary, and skeleton wrappers |

Root layout chain: `ThemeInit → Providers → BootGate → AppProviders → AppLayout` (`src/app/layout.tsx`). Auth routes are excluded from the shell.

---

## 2. App shell

`src/components/AppLayout.tsx` — everything on screen is composed of:

```
┌──────────────┬─────────────────────────────────┬────────────────┐
│              │            TOP BAR              │                │
│   SIDEBAR    ├─────────────────────────────────┤   RIGHT PANEL  │
│  (collapsible│                                 │   (6 tabs,     │
│   Ctrl+\)    │         MAIN CONTENT            │   resizable,   │
│              │   (chat / runs / settings / …)  │   Ctrl+B)      │
│              │                                 │                │
└──────────────┴─────────────────────────────────┴────────────────┘
   Global overlays: ApprovalDialog · CommandPalette · BugReportModal ·
   ShortcutsPanel · OnboardingTour · MemoryPanel · ArtifactPanel ·
   ProductivityOverlays (Tips, What's New, Recover prompt, Offline banner) ·
   UpdateCard · Toasts
```

- Sidebar and right panel are **independent** — both can be open at once.
- Main content gets `panel-open` (artifact panel) / `rp-open` (right panel) layout classes; while resizing the right panel, a `rp-resizing` class suppresses iframe/selection jank.
- Every page renders inside an `ErrorBoundary` with a one-click **Reload** fallback.
- Route title in the top bar comes from a map (`/` → "New Chat", `/packages` → "Packages", `/settings` → "Settings", otherwise "Orplex").

---

## 3. Left sidebar

`src/components/Sidebar.tsx` (+ `Sidebar.module.css` tokens; ported 1:1 from the design prototype `orplex-sidebar-react.html`).

**Head**
- Orplex mascot logo + "Orplex Code" wordmark.
- 🔍 **Search** toggle → inline "Search conversations…" filter input (`aria-label="Search conversations"`; Ctrl+K first opens the command palette instead).
- ◧ **Collapse** button (`Ctrl+\`) — collapses to a rail; a floating **expand FAB** appears over the content edge.

**Navigation rows**
- **New Chat** (`/`) — also aborts any running background task ("New Chat means stop working").
- **New project** — opens the native folder picker, attaches it as the workspace.
- **Plugins** (`/plugins`)
- **Memory** (`/memory`)
- Section label: **Agents**
  - **Agent Manager** (`/manager`) — badge with pending-approval count (`9+` capped).
  - **Runs Board** (`/runs`) — badge with active-run count (shown when ≥ 2).
- Live task row: while a background task runs, a `● <status detail>` row jumps back to the chat.
- **Projects** (collapsible) — project list; each project has a **"New chat in …"** button that silently attaches that project's folder.
- **Chats** (collapsible) — recent conversations; hover shows a tooltip card (chat title, and "Stored on this device" vs "Stored in the cloud"); right-click / kebab opens **Chat menu**: Rename, **Fork chat** (disabled outside desktop), plus delete/etc. actions.

**Foot**
- **Daily requests** quota meter — `used/limit` with a progress bar (`role="meter"`, refreshes on `orplex:chat-sent`).
- **Settings** row (`/settings`).
- **User card** — avatar (OAuth image or initial), name, email; "Not signed in — Sign in to sync" when logged out. Buttons: ☀/☾ **theme toggle**, **Log out**.

**Behaviors**
- Bottom **resize grip** to drag the sidebar width.
- Mobile: hamburger button opens the sidebar as an overlay drawer.
- Collapse state persists (`orplex.sidebarCollapsed`).

---

## 4. Top bar

`src/components/TopBar.tsx`:

- **Search trigger** (focus conversations search / palette).
- **Fork** action (desktop).
- **Notifications** bell.
- **Theme toggle** (dark ⇄ light).
- **Right-panel toggle** button (reflects open state).
- **Bug report** entry (opens `BugReportModal`).
- **Shortcuts** entry (`?` opens the same panel).

---

## 5. Right panel

`src/components/RightPanel.tsx` → `right-panel/RightPanelShell.tsx` + `TabBar.tsx` + `EmptyLauncher.tsx`.

- Six tabs, canonical order: **Queue · Changes · Browser (Preview) · Terminal · Files · Scratch**.
- **Ctrl+B** toggles the panel; **Ctrl+1…6** jumps straight to a tab; **Ctrl+T** opens Terminal.
- Default width **460 px**, draggable clamp **280–720 px**; if closed with no tab chosen, `EmptyLauncher` offers the tab list.
- State survives reloads (sessionStorage `orplex.rightPanel`, `orplex.rightPanelTab`, `orplex.rightPanelTabs`); tabs stay mounted (`display:none`) so terminal/browser keep state.
- Browser tab resources are freed after **10 min idle**.
- Each tab has a dedicated skeleton (`PanelSkeletons.tsx`).

### 5.1 Queue tab (`QueueTab.tsx`)
Background/queued tasks and messages: what's lined up, running, and done while you keep chatting.

### 5.2 Changes tab (`changes-tab.tsx`)
Every file edit the agent makes, as reviewable hunks (see §14): accept/reject per hunk, keep/undo all, conflict handling.

### 5.3 Browser tab (`BrowserTab.tsx`) — see §31
Real Chromium WebContentsView: multi-tab strip, omnibox, private tabs, agent-driving mode, recording.

### 5.4 Terminal tab (`terminal-tab.tsx`)
Interactive shell attached to the workspace (**Ctrl+T**, or Ctrl+/ per the shortcuts panel).

### 5.5 Files tab (`FilesTab.tsx`)
Workspace file tree; open files into the preview; reacts to `orplex:workspace-files-changed` and `orplex:file-history-updated`.

### 5.6 Scratch tab (`ScratchTab.tsx`)
Scratchpad for notes/plans (`useScratchpad` hook) — the "agent thinking plan" surface.

---

## 6. Chat experience

`src/app/page.tsx` — the home surface:

- **Welcome screen (empty state)**: greeting + **WorkspaceSwitcher** folder chip + composer + **WelcomeActions** toolbar + the walking mascot (§39).
- **Message list** (`MessageList.tsx`): streaming assistant answers, user bubbles, tool activity, artifacts, compaction dividers.
- **Fast-answer mode**: quick model path for short questions.
- **Retry** on failed turns; **message queueing** while the agent is busy.
- **Per-message actions** (copy, regenerate, etc.).
- **Escape / Stop** aborts generation (`abortCurrentTask`).
- **Background chat** (`useBackgroundChat`, `useActiveRunCount`): long tasks hand off to the Runs Board; the sidebar shows live status.
- Session state persisted via `useChatSession` / `useConversation` / `useMessages`; conversations can be **local-device** or **cloud**-stored (sidebar tooltip states which).

---

## 7. Prompt bar

`src/components/ChatInput.tsx` → `PromptBar.tsx`:

- Text composer — **Ctrl+Enter** (and Enter, per chat UI conventions) to send.
- **Model picker** — model menu (cold NVIDIA models stay hidden until warmed & verified; §22).
- **Mode selector** (`ModeSelector.tsx`) — **Ask / Plan / Code** chips, each with a one-line description.
- **Effort menu** — reasoning-effort level.
- **Permission menu** — **Manual** (approve each tool) vs **Auto**.
- **Plug (MCP) button** — opens the Connectors panel (§19).
- **Attach** files; paste-image support; **FilePreviewModal** before sending (§20).
- **Queue (Q)** — queue messages while busy.
- **@ file mention menu** — type `@` to pick workspace files.
- **`/` slash-command menu** — skills (§8).
- Menu positioning is portal-based (`prompt-menu-position.ts`) so menus never clip.
- Last-used model/mode/effort/permission persist per conversation (`orplex.promptBar.last`, `orplex.promptBar.perConvo` — 50-conversation cap).
- Whole composer is wrapped by the **DragDropZone** (drop files anywhere on it).

---

## 8. Slash commands

`src/lib/skills.ts` — ~100 slash-command skills in the `/` menu, grouped into **15 categories**:

| Category | Example skills |
|---|---|
| `reasoning` | chain-of-thought, tree-of-thought, self-reflection, first-principles, karpathy-rules, grill-me, superpowers-planning, handoff |
| `analysis` | code-review, security-audit, trail-of-bits-security, performance-profile, dependency-audit, complexity-estimate, merge-conflict-resolver |
| `generation` | test-generator, doc-generator, api-scaffold, graphql-scaffold, docker-setup, migration-script, grpc-scaffold, monorepo-scaffold, microservice-scaffold, cron-worker |
| `refactoring` | extract-function, simplify-code, add-types, error-handling, dead-code, circuit-breaker, graceful-shutdown, composition-patterns |
| `frontend` | frontend-design, react-best-practices, nextjs-app-router, wcag-accessibility, … |
| `security` | … | `quality` | … | `testing` | … |
| `devops` | … | `mobile` | … | `media` | … | `business` | … |
| `integrations` | … | `advanced` | idempotency, … |

---

## 9. Mentions, attachments, drag-drop

- **@-mentions**: file picker over the workspace tree.
- **Attachments**: files + pasted images, previewed in a modal pre-send (§20).
- **Drag & drop**: dropping files on the composer/`DragDropZone` attaches them (`useFileProcessor`, `useFileSystem`).
- **Workspace switcher chip** ("folder ⌄" above the composer, `WorkspaceSwitcher.tsx`): portal menu with **"Open project…"** and per-project **re-attach** rows — ghost projects (opened on another device) are marked.

---

## 10. Quick actions

`src/components/ui/QuickActions.tsx` — the chip bar under the composer **after** an answer:

- **AI-suggested chips** from `/api/chat/suggestions` (top 3) while skeleton pills pulse.
- Fallback suggestions, then static chips: **Fix bugs · Add tests · Optimize · Export .zip · Regenerate** (export + regenerate always enabled).
- Chips prefill the composer via the `orplex:prefill-prompt` event.
- Welcome toolbar chips (`WelcomeActions.tsx`): **Code / Write / Create** prefills, **"Open folder"** runs the picker, **"Map repo"** prefills a repo-mapping prompt.

---

## 11. Message rendering

`MessageList.tsx` / `MessageContent.tsx`:

- Assistant text with markdown, code blocks, and parsed **activity markers**.
- **ThinkingPill** (`ThinkingPill.tsx`) — collapsible "thinking…" indicator; **ThoughtLine / ThoughtThread** render reasoning threads.
- **ActivityGroup** — grouped tool activity blocks per turn.
- **Prompt meter strip** (`PromptMeterStrip.tsx`) — parses `Prompt meter:` transcript lines into chips (calls, full/compact, saved tokens %, actual tokens, counterfactual); falls back to plain italic text if unparseable.
- **ClarificationCard** — the agent asks a question with options instead of guessing.
- **CommentInput** — inline comment/answer input where follow-up input is requested.
- **SessionInsightsPopup** — per-session stats/insights popup.

---

## 12. Tool calls

- `ToolCallDisplay.tsx` — a **TOOL_REGISTRY** maps every agent tool to an icon + human verb; shows args, results, and state (running/success/error).
- `ToolChain.tsx` — chains of sequential tool calls rendered as a connected chain.
- `AgentActivityLog.tsx` — 6 entry types (**info / success / error / tool / file / thinking**) with icons and colors, auto-scroll that re-arms when you scroll back up.

---

## 13. Artifacts

`ArtifactCard.tsx` (inline cards) + `ArtifactPanel.tsx` (full panel, opened globally via `openArtifactPanel(runId)`).

**Ten artifact kinds**: `plan`, `diff`, `screenshot`, `console_check`, `code_output`, `research_output`, `test_output`, `learning`, `timeline`, `walkthrough`.

- **SandboxArtifact** renders `[ARTIFACT]` HTML/CSS/JS in a sandboxed iframe (`allow-scripts`, no same-origin) with a `window.orplex` bridge for controls.
- **ReviewStrip** — verdict chips on artifacts: **draft / reviewed / approved / rejected** + a note field → `PATCH /api/agent/artifacts/:id`.

---

## 14. Diff view

- `DiffView.tsx` — syntax-aware diff renderer (read-only mode reused by BranchReviewPanel).
- **ChangesBar** (`ChangesBar.tsx`) — the "All edits" bar: per-file pending/kept/undone state, inline diff rows (capped at 600 with a "show more"), **Keep all / Undo all**, shimmer while the agent edits, and a 409-conflict → confirm-overwrite dialog.
- **BranchReviewPanel** — pending approvals queue, **⬇ Export audit bundle**, branch **Merge / Discard** with a confirm step, and a DiffView patch preview.
- **ConflictCard** — explicit UI for merge/write conflicts.
- **useHunkDecisions** hook backs per-hunk accept/reject like a PR review.

---

## 15. Task plan

`TodoBar.tsx` — collapsible task-plan bar built from agent todo tool output: "Task plan 2/5", per-item done icons, live progress. Related primitives: `TaskProgress` (current/total counter) and `StepList` / `ProgressBar`.

---

## 16. File cards

`FileCard.tsx` — cards for files the agent staged via `create_file`, with three **honest states**:

- **Live** — **Download** / **Open as preview** buttons.
- **Expired** — 4-hour TTL notice.
- **Removed** — 2-file cap reached or server restart.
- State chased live via `/api/files/:id/status`.

---

## 17. Context compaction

`ContextCompactedDivider.tsx` — neutral gray system row (no avatar/bubble) when context was compacted:

- Expandable summary with ~-prefixed token estimates.
- Kebab menu: **Copy / View full / Undo** (undo when available).
- `/compaction-demo` shows all 6 states.

---

## 18. Command palette

`CommandPalette.tsx` — **Ctrl+K**. Fuzzy search across 5 sections (arrow keys + Enter, Esc closes):

- **Navigation**: New Chat · Runs Board · Plugins · Settings · System Status (`/admin/system`) · Admin Dashboard (`/admin`).
- **Capabilities** (the discovery layer, each with a one-line hint):
  - *Spawn an agent task* → Manager
  - *Review & approve file changes* → Changes panel
  - *Let the agent browse the web* → Browser panel
  - *See run health & recover* → Manager
  - *Connect MCP tools* → Plugins
  - *Agent memory* → opens Memory panel
  - *Schedule work for tonight* → Manager (02:00 queue)
  - *What's new* → changelog overlay
- **Panels**: Open Files / Changes / Preview / Terminal / Queue / Scratchpad.
- **Agent Runs**: last 10 runs (live-polled every 8 s), each jumping to its artifact panel.

---

## 19. Connectors (MCP)

`ConnectorsPanel.tsx` — opened from the prompt-bar plug button:

- Searchable catalog of **100+ MCP servers**.
- **13 category filters** (Databases, Dev tools, Cloud, Design, …).
- **Connect flow**: env-var fields (secrets encrypted server-side), `tools/list` connection test, connected-server management.
- Connection badges on SDK lanes: `connected` / `needs reauth` / `disconnected`.

---

## 20. Modals & dialogs

| Surface | What it does |
|---|---|
| **ApprovalDialog** | Global approval gate for tool use — risk tiers **low / medium / high**; **Reject / Always allow / Approve**; polls the local approval store every 500 ms + server fallback |
| **BugReportModal** | Report a bug with diagnostics |
| **FilePreviewModal** | Pre-send attachment preview: extension-colored badges (ts/js/py/html…), image thumbnails, 200-char text snippets, per-file remove |
| **SessionInsightsPopup** | Session stats & insights |
| **TipsDrawer** | Rotating tips (next-tip event) |
| **WhatIsNew** | Changelog overlay (also from the palette) |
| **UpdateCard** | Desktop updater card: check → download → **ready to install / install / defer / cancel** |
| **ShortcutsPanel** | Keyboard-shortcut cheat sheet (§33) |
| **OnboardingTour** | 17-step guided tour with spotlight anchors (§21) |
| **CommentInput** | Inline answer/comment composer |
| **ConflictCard** | Conflict resolution card |
| **ImportBrowserDataDialog** | Browser-data import (desktop browser tab) |
| **BrowserMenu** | Browser tab kebab: new/private tab, float, record, import data/extensions, profiles, clear data |
| **RecoverSessionPrompt** | Post-crash "Recover previous session?" strip → Manager (once per session) |
| **MemoryPanel** | Overlay: "What I remember about this workspace" (§26) |
| **Toast system** | Transient notifications (`useToast`) |

---

## 21. Onboarding

- **OnboardingTour** — 17 steps (`tutorial-steps.ts`) anchored to `data-tour-id` elements; auto-opens once on the first authenticated visit to `/` (persisted in `orplex.hasCompletedTutorial`), reopenable via the empty-state hero or `orplex:open-tutorial`.
- **FirstRunExperience** — first-run hero with an advanced row that can open right-panel tabs directly.
- **RecoverSessionPrompt** — after an Electron crash, offers session recovery.

---

## 22. Settings

`src/app/settings/page.tsx` — **7 tabs**:

### Profile
Account info, avatar, sign-in state, sign out.

### Appearance
Theme (dark default / light), persisted only when explicitly light (`orplex-theme`). Toggle mirrored in the sidebar and top bar; `Ctrl+.` is the display-listed dark-mode shortcut.

### Cost
`cost-tab.tsx` — spend/usage view: estimated cost labels, per-run cost, quota context.

### API keys
`api-keys-tab.tsx` — BYOK provider key management (add/remove/test provider keys).

### Database
`database-tab.tsx` — database/storage management surface.

### About
Live **app version** (from the Electron bridge, "dev" fallback) + desktop-only **Update check** row ("Check for updates" → results surface in the UpdateCard: *downloading v… / ready to install / error*).

### Danger (+ reset & recovery)
`reset-recovery-tab.tsx` — reset/recovery operations (wipe local state, recover from broken sessions).

### Warm models card
`warm-models-card.tsx` — NVIDIA cold-start **wake engine**: per-model rows in states *waking / woke / unreachable / no-answer*, "attempt N/3", **Warm models** force-probe (`POST /api/models/warm`), 5 s polling; unverified cold models are hidden from the model picker.

*(Other settings components: `reset-recovery-tab`, `database-tab`, `cost-tab`, `api-keys-tab`, `warm-models-card`.)*

---

## 23. Agent Manager

`AgentManager.tsx` (`/manager`):

- **Header** — free-tier / BYOK provider badge (`/api/agent/provider-status`).
- **Inbox** — agent notifications (`/api/agent/notifications`).
- **Filters** — All / Active / Done.
- **Agent card grid** — status bar, progress, first-4 task preview with role icons (ARCH/DEV/REV/VERIFY), **Kill** button.
- **SpawnDialog** — prompt textarea, **Ask/Plan/Code** chips, model choice (auto or custom BYOK), schedule **Now / Tonight 02:00**; **Ctrl/⌘+Enter** to spawn.
- Spawn / kill / merge APIs wired to the run lifecycle.
- **RunHealthStrip** — three expandable chips (§25).

---

## 24. Runs Board

`RunBoard.tsx` (`/runs`):

- **Swimlanes per run** grouped by mission (`parentRunId`).
- Status dots from `RUN_STATUS_META`: **pending · planning · executing · verifying · waiting_approval · completed · failed · cancelled**.
- **Task cards** with role labels **ARCH / DEV / REV / VERIFY**.
- **Live cells** (`RunLiveStatus`) — 3 s cursor-event poll + elapsed timer.
- **Inline Approve / Deny** on waiting cards (optimistic removal).
- Progress bar + `AgentProgress` per run; **AgentStatus** roster with role letters (C / P / `</>` / R / T).
- Filters **All / Active**; auto-refresh every 5 s.

---

## 25. Run timeline & health

- **RunTimeline** — mission-control event stream with cursor-disciplined `/events?after=` polling; **27 event types** styled with icons/tones (run_created, approval-*, branch-pushed, pr-opened, mcp-*, checkpoint-*, artifact-chain-approved, …); tail auto-pinned while active.
- **RunHealthStrip** — expandable chips:
  - **Stuck** (10+ min, zero progress) → *Cancel run*.
  - **Waiting for approval** → *Review now*.
  - **Verification failed** → *Open run*.

---

## 26. Memory

- **Memory page** (`/memory`) — full playbook/rules editor (what the agent should remember and follow). `/playbook` redirects here.
- **MemoryPanel overlay** (from the palette / slash commands) — "What I remember about this workspace": entries tagged **STACK / PATTERN / USER PREF / AVOID** with ×counts and per-entry optimistic **forget** (`DELETE /api/agent/memory`).

---

## 27. Plugins

`/plugins` — plugin/MCP manager: installed plugins, connectors, enable/disable, with loading & error states (own `loading.tsx` / `error.tsx`).

## 28. Packages

`/packages` — package manager for workspace dependencies.

## 29. Admin

- `/admin` — admin dashboard (keys, backups).
- `/admin/system` — system status: hardware, memory, janitor, pacer, watchdog.

---

## 30. Auth, legal & errors

- **Sign-in** (`/auth/signin`) — OAuth sign-in screen rendered outside the app shell.
- **Terms / Privacy** (`/legal/terms`, `/legal/privacy`).
- **404** (`not-found.tsx`), route **error** + **global-error** boundaries, route-level **loading** skeletons, `template.tsx` transition wrapper.
- **OfflineBanner** — honest offline detection (browser online/offline events + one `generate_204` authenticated-state cross-check).

---

## 31. Embedded browser (desktop)

`right-panel/BrowserTab.tsx` — a real Chromium **WebContentsView** (main-process owned, IPC-driven — not an iframe):

- **Tab strip**: favicon + title + close, **+** new tab; **private tabs** (mask chip, non-persistent partition).
- **Toolbar**: Back / Forward (real `did-navigate` state), Reload, **omnibox** with security shield (lock / warn / error), "Open in external browser", **kebab → BrowserMenu** (new/private tab, float, record, import data/extensions, profiles, clear data), Private chip.
- **New-tab page**: breathing globe, "Import browser data" button, **live dev-server port chips** (probes 3000/5173/8080/4200/3001/8000/5000/4000, 10 s poll while visible).
- **Agent integration**: `orplex:agent-browser-tab` adds a dedicated **Agent Browser** tab; **watch mode** ("agent is driving" / "watch only" toggle); `target=_blank` opens a new tab.
- Overlay freeze (screenshot snapshot behind DOM overlays), native bounds sync, per-error-code honest failure copy (timeout, offline, DNS, insecure, …).
- **Recording**: viewport-cropped MediaRecorder → webm → save + `POST /api/recordings`.

---

## 32. Desktop (Electron) exclusive

`electron/`:

- **System tray** (`tray.ts`) — menu (Open Orplex / Quit), 15 s poll of active runs, native notifications **only on transitions** (completed / failed / interrupted-memory-pressure), tooltip "N active run(s)".
- **Single-instance lock** + second-instance focus.
- **Preload bridge** `window.orplexDesktop`: `isElectron`, `openExternal`, native **folder/file pickers**, `getAppVersion`, **updates** (check/download/cancel/install/defer + status events), `revealPath`, **preview** (browser tab IPC), **previewExtras** (private tab, devtools, hard reload, float toggle, history, profiles CRUD, clearData, dataSizes, extensions), **browserData** (detect/import/cookie-file), **recording**, **agentBrowser**, **fsOps** (copy/trash), `lastSessionCrashed` (drives the recovery prompt).
- **Fork chat** is desktop-only (disabled in web with a tooltip).
- **Installer** customization (`nsis/installer.nsh`), icon repair, session crash-state markers.

---

## 33. Keyboard shortcuts

**Actually wired (document listeners):**

| Keys | Action |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+B` | Toggle right panel |
| `Ctrl+T` | Open Terminal tab |
| `Ctrl+1…6` | Queue / Changes / Files / Browser / Terminal / Scratch |
| `Ctrl+\` | Collapse / expand sidebar |
| `Ctrl+N` | New chat (also aborts current task) |
| `?` | Shortcuts panel (outside inputs) |
| `Esc` | Stop generation |
| `Ctrl+Enter` | Send message |
| `Ctrl/⌘+Enter` | Spawn agent (SpawnDialog) |
| `↑/↓ + Enter` | Navigate palette |

**Shown in the ShortcutsPanel** (display list): `Ctrl+Enter` send · `Ctrl+K` palette · `Ctrl+/` terminal · `Ctrl+B` sidebar · `Ctrl+P` preview · `Esc` stop · `Ctrl+N` new chat · `Ctrl+.` dark mode.

---

## 34. Theming

- **Dark by default** (set server-side on `<html>`); only an explicit **light** choice is persisted (`orplex-theme: "light"`).
- Toggle points: sidebar user card, top bar; `useTheme()` exposes `{ dark, toggle }` and flips the `.dark` class.
- Status tokens (`--st-*-fg/bg`) in `globals.css`; sidebar tokens in `Sidebar.module.css`; `prefers-reduced-motion` respected everywhere (mascot included).

---

## 35. Toasts & banners

- **Toast** system (`useToast`) — transient top-level notifications.
- **OfflineBanner** — offline state banner.
- **UpdateCard** — desktop update lifecycle card.
- **RecoverSessionPrompt** — crash-recovery strip.

---

## 36. Loading, empty & error views

- Shared `StateViews.tsx`: `LoadingView` (LatticeLoader), `EmptyView`, `ErrorView`, `ErrorInline` — all wired to `error-guidance.ts` recovery actions.
- `DotGridLoader` — animated dot-grid loading indicator.
- Per-tab right-panel skeletons (`PanelSkeletons.tsx`) with post-hydration shimmer.
- Route-level `loading.tsx` skeletons (runs, settings, plugins, packages).
- `Skeleton` component for placeholder blocks.

---

## 37. Mobile

- Sidebar becomes a **drawer** with a hamburger button.
- Responsive prompt bar & panels; nav rows close the drawer on navigate.

---

## 38. Persistence & events

**localStorage**: `orplex-theme` · `orplex.sidebarCollapsed` · `orplex.promptBar.last` · `orplex.promptBar.perConvo` · `orplex.hasCompletedTutorial` · `orp.*` (prototype).
**sessionStorage**: `orplex.rightPanel` · `orplex.rightPanelTab` · `orplex.rightPanelTabs` · `orplex.recoverPromptShown`.

**Window events** (cross-component wiring): `orplex:model-changed` · `orplex:prefill-prompt` · `orplex:new-chat` · `orplex:open-panel` · `orplex:open-tutorial` · `orplex:settings-tab` · `orplex:toggle-sidebar` · `orplex:whats-new` · `orplex:next-tip` · `orplex:file-history-updated` · `orplex:workspace-files-changed` · `orplex:chat-sent` · `orplex:agent-browser-tab`.

---

## 39. The mascot

`WalkingMascot.tsx` — a pixel-robot mascot (inlined SVG) that patrols the **prompt-bar border** with framer-motion: arc-length walking, corner sits (0.7–1.6 s), moonwalk lap edge, and a wave on spawn/sit. Honors `prefers-reduced-motion`. A second mascot logo lives in the sidebar head.

---

*Generated from the codebase — every item above maps to a real component in `src/` or `electron/`.*
