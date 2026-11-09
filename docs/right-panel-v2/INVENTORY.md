# P0 — INVENTORY (Right Panel v2)

**Date:** 2026-11-09 · **Branch:** `feat/right-panel-v2` · **Phase:** P0 recon (no code edits yet)
**Refs read:** `_ref/freebuff-right-panel.html` (607 lines, light+dark palettes, 6 tabs),
`ARCHITECTURE.md` v1.0.23 (sections 1, 2, 15, 17, 18, module map), current
`src/components/RightPanel.tsx` (355 lines) + `src/components/right-panel/*`.

## 1. Placeholder / stub audit of shipped panel code (purge baseline)

Ran the §10 purge regex over `src/components/RightPanel.tsx`,
`src/components/right-panel/`, `electron/`, `src/lib/`:

- **No demo data, no stubs, no fakes.** Matches are only: input `placeholder=`
  attributes (3, legitimate), the word "placeholder" in 4 *comments* describing
  the native viewport div, and live-code matches in `agent-browser-session.ts`
  (`el.placeholder` — DOM attribute, unrelated).
- `SEED_DEMO`, `window.fb`, `fb-browser`, `fb-import`, `hook this up`, fake
  terminal/tree lists exist **only** in `_ref/freebuff-right-panel.html`
  (throwaway prototype, never shipped). Baseline is clean; P6 must keep it so.

## 2. Current implementation map (what exists, all verified by reading code)

| Area | Code | Verified behaviour |
|---|---|---|
| Shell | `src/components/RightPanel.tsx` | Fixed aside (`top:64, right:0`), default width **620** (session-only, never persisted; reload → 620), resize grip 280–720 clamp, double-click reset, arrow-key resize, `rp-open` margin on main content. Lazy (`dynamic`, ssr:false) via **AppLayout** |
| Tabs | `Tab = queue\|changes\|files\|preview\|terminal\|scratch` | `activeTab` state, restored from `sessionStorage["orplex.rightPanelTab"]`, Open state under `orplex.rightPanel`; per-tab `TabErrorBoundary` |
| Queue | inline `QueueTab` | `useBackgroundChat()` store (background-chat.ts); status dot + message + statusDetail; skeleton first-paint |
| Changes | `right-panel/changes-tab.tsx` (121) | Polls **GET /api/agent/changes** every 3s → history-based card list + `DiffView` expand + `window.applyHunkDecisions` rollback |
| Files | inline `FilesTab`/`FileNodeItem` | `useFileSystemContext`: **full-recursive** tree scan on open (`useFileSystem.ts`); filter input; click file → `readFile`; folders collapse |
| Preview | `right-panel/preview-tab.tsx` (630) | Native `WebContentsView` tabs over `preview:*` IPC; renderer-side `toNavigateUrl` omnibox normalization, `ResizeObserver` → `setBounds` (rAF-throttled), port chips (10 s poll of /api/localhost-probe), failure surfaces, Agent Browser mirror (id 999999), `mountedBrowserRef` export (only RightPanel consumes) |
| Terminal | `right-panel/terminal-tab.tsx` (233) | SSE via `/api/agent/terminal/stream` + session route; `terminal-events` bus (agent commands mirrored); Up/Down history; abortRef; 200-line DOM cap; servers list with stop |
| Scratch | inline `ScratchTab` | `useScratchpad()` → task store `scratchpad` text; parses `plan/hypotheses/findings/next:` blocks; **persists per-task in localStorage** (`orplex:scratchpad:<taskId>` + `orplex:scratchpad:last`) as read-only stale snapshot |

## 3. Regression contract — must survive (with files)

- **Queue** (background-chat store, green/red/orange dots) — `RightPanel.tsx:46-70`
- **Changes** — `DiffView`, `HunkDecisionProvider` (`window.applyHunkDecisions` shim),
  `file-history` → `workspace-history` → `checkpoints` (undo/checkpoint restore) —
  `src/lib/file-history.ts`, `workspace-history.ts`, `checkpoints.ts`
- **Files** — `useFileSystem` (`readFile`/`writeFile`/`editFile`/`refreshPaths`),
  `FileSystemProvider`, workspace-cwd registry (`workspace-cwd.ts`, durable,
  `%APPDATA%\orplex-code\workspaces.json`)
- **Preview** — native view over `preview:*` IPC (never iframe), mounted across
  tab switches (`show-tab` hide/show), orange live-dot, breathing empty globe,
  port chips, failure surfaces, Agent mirror, `preview:diag`
- **Terminal** — `shell-session.ts`, `/api/agent/terminal/{session,stream}`,
  `terminal-lane.ts` (Electron bridge + API lane), 4000-char chunk cap; routes
  verified present: `src/app/api/agent/terminal/{route.ts,session/route.ts,stream/route.ts}`
- **Scratch** — live mirror (see decision D4 on persistence)
- **Shell** — resize grip, tab persistence, error boundary, `mountedBrowserRef`,
  props `{open, onClose, defaultTab, onResizingChange}`, exports `default RightPanel`
- **Selectors**: no jest test references `RightPanel`/`rp-*` classes (grep clean);
  e2e (`e2e/chat.spec.ts`, `seed.spec.ts`, `helpers.ts`) has no panel selectors.
  Tour step `right-panel` resolves `button[aria-label="Toggle right panel"]`
  (**TopBar**, not the panel — preserved as-is). No `data-tour` attrs exist on
  panel internals. `reset-recovery-tab.tsx` clears `orplex.rightPanel` /
  `orplex.rightPanelTab` (new key must be added there in P1).

## 4. Consumers / programmatic opens (all must keep working)

- **AppLayout.tsx**: `dynamic(() => import("./RightPanel"))`; owns
  `rightPanelOpen` + `rightPanelTab` state; sessionStorage keys
  `orplex.rightPanel` / `orplex.rightPanelTab`; **Ctrl+B** toggle, **Ctrl+T**
  terminal, **Ctrl+1..6** direct tab; listens `orplex:open-panel` event
  (`detail.tab`); `onOpenPanel(tab)` prop (used by FirstRunExperience etc.);
  renders `<RightPanel open onClose defaultTab onResizingChange>`.
- **page.tsx / StateViews.tsx / SessionInsightsPopup.tsx / HunkDecisionProvider.tsx**:
  comments only (no imports). `ChangesBar` is a separate component (not the panel).
- **preview-tab.tsx** exports `mountedBrowserRef` (RightPanel-only consumer).

## 5. IPC inventory (existing — reuse, all via `handleAppIpc`)

`handleAppIpc` (`electron/main.ts:112`): sender-origin gate against loopback —
**no Zod validation today** (all args typed `any`); new channels get Zod per §2.4.

| Channel | Purpose |
|---|---|
| `preview:create-tab` → tabId | create native view |
| `preview:navigate` (tabId, url) | main-side Chrome-style omnibox normalization |
| `preview:set-bounds` | position native view |
| `preview:show-tab` (tabId\|null) | show one, hide others |
| `preview:close-tab` | destroy view |
| `preview:go-back` / `preview:go-forward` | `navigationHistory` |
| `preview:reload` / `preview:stop` | webContents ops |
| `preview:screenshot` → dataURL | `capturePage()` (overlay freeze + agent) |
| `preview:diag` | children/bounds/visible/URL dump |
| event `preview:event` | `window-open(url)`, `navigated{url,inPage}`, `title-updated{title}`, `loading{loading}`, console/did-finish-load/render-process-gone diagnostics |

**Missing for V2 (to build, P4/P5):** `preview:open-devtools`,
`preview:hard-reload`, private-tab creation (partition), nav state
(canGoBack/canGoForward/favicon — post navigated events or a
`preview:nav-state` channel), floating-window toggle + bounds persistence,
history store (userData JSON), profiles store, data-clear + sizes, extension
load/unload, browser-data detect/import, recording save.

## 6. Routes inventory (verified present)

- `/api/localhost-probe` (8 probed ports), `/api/agent/changes` (history-based,
  3 s poll), `/api/agent/runs` (+`useActiveRunCount` badge), `/api/agent/terminal/*`,
  `/api/agent/{checkpoints,history,memory,grep,workspace-cwd,exec,serve}` all exist.
- **LOCAL_ONLY** (`src/proxy.ts:71`): 12 routes incl. `/api/agent/workspace-cwd`,
  `/api/files`, `/api/db`; prefixes 4. **Note:** ARCHITECTURE §17 says 9/4 — the
  doc is stale (db + session/clear added); re-verified count is **12**.
- Session cookie for routes: `getServerSession(jwtOnlyOptions)` everywhere.

## 7. Hook / lib API surface (verified)

- `useBackgroundChat() → {task}` + `subscribeBackgroundChat`, `getCurrentTask`,
  `deriveRunPhase`, `runPhaseLabel` (background-chat.ts)
- `useScratchpad() → {text, taskId, live}` (localStorage-persisting — decision D4)
- `useActiveRunCount() → {activeRuns, pendingApprovals}` (10 s poll)
- `useFileSystem() → {directoryHandle, directoryName, fileTree, activeFilePath,
  setActiveFilePath, fileContents, openFolder, openFolderHandle, reopenProject,
  readFile, writeFile, editFile, refreshPaths}` — **no create/delete/rename/mkdir/upload**
- `useHunkDecisions()` → `window.applyHunkDecisions` shim; `DiffView` default export;
  `FilePreviewModal` is **attachment-oriented** (`{files,onRemove,onClose}`, not a
  file viewer — P3 design point)
- `VirtualList` exists; `Icons.tsx` = Material Symbols ligatures (`<Ms name=>`),
  6 missing glyphs will be added there (`branch`, `laptop`, `puzzle`, `mask`,
  `pip`, `video` equivalents); `scrubber.ts` exists in `src/lib` (log scrubbing
  for new IPC paths)
- **zod `^3.23.0` is a dependency** (package.json:64) → usable in main process
- Electron **41.7.1** (node:sqlite availability → runtime probe in P5, D6)

## 8. Design tokens (verified)

App tokens live in `globals.css` `:root` + `.dark` overrides: `--canvas`,
`--surface`, `--well`, `--border`, `--text-primary/secondary/tertiary/dim`,
`--brand` (#a04100 light / #ffb693 dark), `--brand-vivid` #ff6b00, and semantic
`--st-*` run-status tokens + `--success`/`--danger`. Reference palettes map onto
these under a scoped `.orplex-rp` root; `--brand-vivid` is the orange accent;
app theme follows the **app's** `.dark` class (never OS), per §3.

## 9. Deviations from prompt assumptions (decided, see DECISIONS.md)

1. D4 — `useScratchpad` *does* persist (localStorage) today, but §1/§5.7 say
   "never persisted (by design)": V2 drops the localStorage mirror.
2. D3 — omnibox normalization currently lives **renderer-side** in
   `preview-tab.tsx:68` (`toNavigateUrl`); ARCHITECTURE §2 claims main-side.
   V2 routes raw input to `preview:navigate` (main normalizes) and deletes the
   renderer copy.
3. No `data-tour` attributes exist on panel internals; the tour resolves the
   TopBar `aria-label` instead (kept, untouched).
4. Panel default width stays **620** (needs real browser width), not the
   reference's fixed 460 — DECISIONS D12.

---

## 10. CONTROL MATRIX (P0 checklist — 100% at end)

Status key: `R` = reuse existing, `W` = rewire existing to new UI, `B` = build new.
Every row must end with a test or a recorded manual run in VERIFICATION.md.

### Shell & tab bar

| # | Control | Handler (file) | Data source | Test | St |
|---|---|---|---|---|---|
| S1 | Tab click → switch | `RightPanelShell.tsx` | `openTabs: TabId[]` state | jest: click switches + ARIA | B |
| S2 | Tab ✕ close | shell state `closeTab(id)` | — | jest: close + focus moves | B |
| S3 | Browser ✕ close → hide view, keep state | `BrowserTab` → `preview:show-tab(null)` + hide actually happens via `visiblePreviewTabs` | native view | jest (bounds/hide mocked) + manual | B |
| S4 | "+" popover lists closed tabs | `TabBar` | `ALL_TABS − openTabs` | jest incl. all-open state | B |
| S5 | Popover item → add + activate | shell | — | jest | B |
| S6 | Empty launcher 6 buttons | `EmptyLauncher` (fresh install, no open tabs) | — | jest + e2e | B |
| S7 | Resize grip (drag/double-click/keys) | existing grip logic moved into shell | `--rp-w` | jest (clamp 280–720) + manual | R |
| S8 | Badges: browser orange dot (dev server live) | `TabBar` | `/api/localhost-probe` | jest (mock fetch) | W |
| S9 | Badges: Queue running count | `TabBar` | `useActiveRunCount` | jest (mock fetch) | W |
| S10 | Tab persistence + migration (`preview`→`browser`, old value → open list) | `panel-state.ts` pure helpers | sessionStorage | jest: migration matrix | B |
| S11 | Programmatic opens: Ctrl+B/T/1-6, `orplex:open-panel`, `onOpenPanel` | single `openRightPanelTab(id)` helper in AppLayout | AppLayout state | jest (existing suite) + manual | W |
| S12 | Per-tab error boundary, a11y (tablist, arrow keys, focus trap, Esc) | shell | — | jest | B |

### Changes

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| C1 | Uncommitted pill (working tree vs HEAD incl. untracked) | `ChangesTab` + new `GET /api/agent/changes?scope=unc` (LOCAL_ONLY) | git status/numstat in workspace cwd | jest: parser + route | B |
| C2 | All pill (+ commits since merge-base) | same | git + merge-base | jest | B |
| C3 | Rows: status icon, dim dir + bright file, `+N −M`, totals in header | `ChangesTab` | C1/C2 | jest (fixtures) | B |
| C4 | Row click → `DiffView` | existing | route diff | jest + manual | W |
| C5 | Row hover actions: undo + checkpoint restore | existing paths (`file-history` → `workspace-history` → `checkpoints`) | same | jest + manual | W |
| C6 | Live refresh on agent write events + focus, debounce | `orplex:file-history-updated` + focus | C1 source | jest (event wiring) | B |
| C7 | Non-git folder: honest empty + `.orplex/history.jsonl` fallback (current `/api/agent/changes`) | `ChangesTab` | file-history | jest | B |

### Files

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| F1 | Tree (lazy children, hide `.git`/`node_modules`/`.next`, show `.github`/`.orplex`) | `FilesTab` (new lazy loader over `readFile`-style dir reads) | workspace fs | jest | B |
| F2 | Filter box (instant name) | `FilesTab` | tree | jest | B |
| F3 | Content-search fallback (≥3 chars, no results) → `/api/agent/grep` | `FilesTab` | grep-search | jest | B |
| F4 | New file / New folder (inline input, Windows reserved names, `MAX_PATH_LENGTH`, path-jail) | new `POST /api/agent/fs` (LOCAL_ONLY) | disk | jest route + jail tests | B |
| F5 | Upload (native picker → copy, collision prompt, 2 MB+ via main) | `getPathForFile` + main copy IPC | disk | jest (mock bridge) + manual | B |
| F6 | File click → viewer (images/markdown) | `FilePreviewModal` adapter or new `FileViewer` | `readFile` | jest | B |
| F7 | Right-click: rename / delete (Recycle Bin) / reveal / copy path | `/api/agent/fs` + main `shell.trashItem` IPC | disk | jest + manual | B |
| F8 | No folder → "No folder opened — use Open in the sidebar" | existing copy | `directoryName` | jest | R |
| F9 | Writes recorded in history (appear in Changes, undoable) | `recordChange` → `workspace-history` | file-history | jest round-trip | B |

### Browser (Local browser)

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| B1 | Toolbar: back / forward (disabled state real) | `BrowserTab` → `preview:go-back/forward` + `preview:event navigated` | native `navigationHistory` | jest (mock bridge events) | W |
| B2 | Toolbar: reload | `preview:reload` | native | jest | W |
| B3 | Omnibox Enter (main-side normalization, no renderer impl) | `preview:navigate` | main Chrome-style rules | jest (normalize cases) + manual | W |
| B4 | Omnibox live URL text | `navigated` events | native | jest | W |
| B5 | Open in OS browser | `openExternal` | — | jest | W |
| B6 | Empty state: breathing globe | CSS (already added `rp-breathe`) | — | manual visual | R |
| B7 | Empty state: port chips (8 ports, poll while visible only) | `/api/localhost-probe` | TCP connect | jest (mock fetch) + manual | W |
| B8 | Empty state: "Import browser data" button | opens Import dialog | — | jest | B |
| B9 | Menu: New browser page | `preview:create-tab` | native | jest + manual | B |
| B10 | Menu: Private tab (non-persistent partition, "Private" badge, no history) | `preview:create-private-tab` (new) | `session.fromPartition` | jest + manual | B |
| B11 | Menu: Open DevTools (preview view only) | `preview:open-devtools` (new) | `webContents.openDevTools({detach})` | manual | B |
| B12 | Menu: Hard reload | `preview:hard-reload` (new) | `reloadIgnoringCache()` | manual | B |
| B13 | Menu: Toggle floating preview (undock to frameless always-on-top, drag/resize, close → dock) | `preview:float-toggle` (new) | new BrowserWindow | jest + manual | B |
| B14 | Menu: Record browser (start/stop, red dot, save under `userData/recordings/`, "Reveal in folder" toast) | renderer `MediaRecorder` + `recording:save` (new) | `getDisplayMedia` scoped to app window | jest + manual (playable webm) | B |
| B15 | Menu: Import browser data… | dialog (§5.5) | — | jest | B |
| B16 | Menu: Extensions… | dialog Extensions tab | `userData/extensions` | jest + manual | B |
| B17 | Menu: Recent pages ▾ (real history store, cap 200, click → navigate, Clear) | `preview:history-*` (new) | userData JSON | jest + manual | B |
| B18 | Menu: Profiles ▾ (create/rename/delete/switch, per-profile partitions) | `preview:profiles-*` (new) | userData JSON | jest + manual | B |
| B19 | Menu: Browser data ▾ (clear cache/cookies/site data/history, real sizes) | `preview:clear-data` (new) | `session.clearCache` etc. | jest + manual | B |
| B20 | Overlay freeze: menu/popover/dialog open over native view → snapshot hide | `useOverlayFreeze` (screenshot) | `preview:screenshot` | jest + manual | B |
| B21 | `target=_blank` → new preview tab; per-tab history; favicons; Agent mirror tab | existing | native events | jest + manual | R |
| B22 | Failure surfaces (DNS/refused/timeout/offline/SSL, Retry + Open in Chrome) | existing | `did-fail-load` | jest | R |
| B23 | Bounds sync (ResizeObserver + grip + window resize, rAF-throttled) | `useNativeViewBounds` | `preview:set-bounds` | jest + manual | W |

### Import browser data dialog (5.5)

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| I1 | Segment: Import \| Extensions | dialog state | — | jest | B |
| I2 | Browser select dropdown (detect installed) | `browser-data:detect` (new, main) | `%LOCALAPPDATA%`, `%APPDATA%`, mac/linux paths; Local State info_cache | jest (fixture roots) | B |
| I3 | Cookies & sign-ins checkbox | dialog state | — | jest | B |
| I4 | Extensions expandable row + per-extension checkboxes | dialog state | enumeration (`Extensions/*/manifest.json`, `_locales` names) | jest (fixture dir) | B |
| I5 | Import cookie file… (Netscape txt + Cookie-Editor JSON) | `browser-data:import-file` (new) | dialog | jest (fixtures both formats) | B |
| I6 | Import confirm: cookie decrypt (Firefox `cookies.sqlite`; Chromium SQLite copy + DPAPI `ProtectedData.Unprotect` + AES-256-GCM v10/v11) | `browser-data:import` (new) | `node:sqlite` (runtime probe; degrade to file path if missing) | jest (fixtures) + manual Firefox→signed-in | B |
| I7 | Chrome v20 (App-Bound Encryption) honest notice + skipped count | same | detection | jest + manual | B |
| I8 | Extensions import (copy + `session.loadExtension`, per-ext status) | same | userData/extensions | jest + manual | B |
| I9 | Consent copy, summary counts (imported/skipped/failed), progress, Esc/backdrop/✕ close, focus return | dialog | — | jest | B |

### Terminal

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| T1 | Enter → run real command (real cwd/shell prompt) | existing + reskin | session route | existing tests + manual | R |
| T2 | Up/Down history | existing | history state | existing | R |
| T3 | Ctrl+C cancel | **verify abort plumbing** (abortRef exists — if dead, build it) | SSE abort | jest | ? |
| T4 | `clear`, click-to-focus, scroll-lock, agent lines, 4000-char cap | existing | — | existing | R |
| T5 | ANSI color render or safe strip | reskin task (verify current behaviour) | SSE | manual | W |

### Queue

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| Q1 | Row: status dot + message + live status text, animated dots while running | `QueueTab` | background-chat store | jest | W |
| Q2 | Row click → jump to conversation | `navigation-events.ts` | store | jest | B |
| Q3 | Stop button on running row (existing abort path) | `abortCurrentTask` | store | jest | B |

### Scratch

| # | Control | Handler | Data source | Test | St |
|---|---|---|---|---|---|
| SC1 | Headed blocks (Plan/Hypotheses/Findings/Next/…) + live pulse on most-recently-updated block | `ScratchTab` (parser exists; add change tracking) | task store | jest (fixtures) | W |
| SC2 | Never persisted; empty → existing empty copy | remove localStorage mirror | — | jest | B |
