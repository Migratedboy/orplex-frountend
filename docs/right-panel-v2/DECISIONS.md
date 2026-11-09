# DECISIONS — Right Panel v2

Decision log. The master prompt says: don't ask, decide, write it down, keep
going. Each decision: context → choice → rationale → consequences.

## D1 — Supersedes: single `openRightPanelTab` helper (P1)

All programmatic opens (Ctrl+B/T/1-6, `orplex:open-panel`, `onOpenPanel`)
route through one helper in AppLayout. The `orplex:open-panel` event stays as
an adapter so existing emitters (FirstRunExperience, recovery) don't change.

## D2 — Persistence keys (P1)

- Keep `sessionStorage["orplex.rightPanel"]` (open bool) and
  `["orplex.rightPanelTab"]` (retained for reset-recovery-tab compat).
- New key `orplex.rightPanelTabs` — the open-tab list (TabId[]).
- Migrate: stored tab value `preview` → `browser`; a single stored tab becomes
  a 1-element open list; unknown values → default `["browser"]`.
- `src/components/settings/reset-recovery-tab.tsx` clears the new key too.
- Panel default width stays **620** (D12).

## D3 — Omnibox normalization is main-side only (P4)

Renderer `toNavigateUrl` (preview-tab.tsx:68) is deleted; the renderer sends
raw input to `preview:navigate`, and the main process applies the existing
Chrome-style rules (search → Google, bare host → https, localhost → http).
Rationale: spec §5.4 + single source of truth; ARCHITECTURE §2 already
describes the main-side behaviour.

## D4 — Scratch never persists (P2) — behaviour change stated aloud

`useScratchpad` persists per-task text in localStorage
(`orplex:scratchpad:*`) and shows a stale "Last session — read-only snapshot"
badge. The regression contract and §5.7 both say **never persisted (by
design)**. V2 removes the localStorage mirror: live task text only, empty
copy when no task is running. The stale-snapshot nicety is dropped per spec;
`scratchpad.test.ts` expectations updated deliberately (never deleted).

## D5 — All new IPC is Zod-validated (P4/P5)

`handleAppIpc` today only checks sender origin — args are `any`. New channels
get `zod` schemas (already a dependency, `^3.23.0`) for every argument before
use. Existing channels are untouched (pre-existing risk, not introduced here).

## D6 — Cookie decryption via `node:sqlite`; runtime-probed (P5)

Chromium cookie DBs + Firefox `cookies.sqlite` are read with `node:sqlite`
(Electron 41.7.1 main process). No new dependency (wasm SQLite would be
unavoidable only if `node:sqlite` is missing — probe `process.versions` and
record evidence in VERIFICATION.md). If unavailable: Firefox/Chromium direct
decrypt degrades to **disabled-with-reason** and the cookie-file import path
(§5.5) becomes the primary route — honest UI notice, never a stub. Cookie
values are never logged (§2.6): all IPC payloads pass `src/lib/scrubber.ts`
before any logging.

## D7 — Files writes: LOCAL_ONLY route + desktop IPC (P3)

User-facing create/mkdir/rename/upload/delete need disk writes the existing
`/api/files` staging store doesn't provide (it's agent in-memory staging).
Choice: new **`POST /api/agent/fs`** route (LOCAL_ONLY, same-origin gated,
`safeJoinWorkspace` jail, `MAX_PATH_LENGTH`, Windows reserved-name validation)
for create/mkdir/rename/upload-copy; **desktop-only IPC** (`fs-ops:*`) for
Recycle Bin (`shell.trashItem`) and native file picker copy (>2 MB via main,
`getPathForFile`). Each write goes through `recordChange` → `workspace-history`
so user-created items show in Changes and are undoable (F9).

## D8 — Changes git shape: extend + LOCAL_ONLY (P3)

`GET /api/agent/changes` today serves in-memory file-history (forwardable).
The git working-tree shape (§5.2) runs `git` on the user's disk, so it is
**LOCAL_ONLY**: extend to `?scope=unc|all` on a new
`GET /api/agent/changes-git` (LOCAL_ONLY, next to `changes/route.ts`) using
spawned `git` (`status --porcelain=v1 -z` + `diff --numstat HEAD` + untracked
line counts) in the workspace-cwd registry dir; `.orplex/history.jsonl`
(workspace-history) fallback for non-git folders (C7). Untracked counting must
not shell out per file without bound — single `git status -z` + `git diff
--numstat` pass; huge repos truncated to a cap with honest copy if exceeded.

## D9 — Recording: renderer MediaRecorder, main only saves (P5)

Record via `getDisplayMedia` scoped to the app's own window, crop to preview
bounds via canvas stream, `MediaRecorder` → webm; the renderer sends the blob
to the main process (`recording:save`) which writes under
`userData/recordings/` and returns the path for the "Reveal in folder" toast.
Main does no capture work; display-media handler stays scoped per §9.

## D10 — Floating preview: frameless BrowserWindow in preview-extras (P5)

`preview:float-toggle` moves the active `WebContentsView` into a small
frameless always-on-top `BrowserWindow` (bounds persisted to
`userData/preview-float.json`, drag + resize); closing the window returns the
view to the panel. Panel shows a "floating" ping; toggling again docks.

## D11 — No new dependencies; icons via Icons.tsx; themes via .orplex-rp (P1)

- Icons: Material Symbols through `src/components/Icons.tsx` (add missing:
  branch, laptop, puzzle, mask, pip, video, globe, cookie, profile/shape
  equivalents). No inline-SVG copies of reference icons.
- Theme: reference palettes become CSS variables under a scoped `.orplex-rp`
  root bound to app tokens (`--canvas/surface/border/text-*`, brand =
  `--brand-vivid` #ff6b00; semantic greens/reds stay); light/dark follows the
  app's `.dark` class only. Reference theme button + `prefers-color-scheme`
  script + Google Sans stack are **not** ported (§3).

## D12 — Panel default width stays 620 (P1)

The reference is fixed at 460px, but the current 620 default is a deliberate
choice ("a real browser width for the preview", RightPanel.tsx:230) and the
Preview is the panel's heaviest consumer. Keep 620; the resizable grip,
280–720 clamp, and non-persistence stay exactly as-is.

## D13 — Browser tab close hides, doesn't destroy (P1) — S3/N-min rule

Closing the Browser tab hides its native view (`preview:show-tab(null)`);
view state (history, scroll) is kept. "Closing again after N min idle may
free it" (§4): implement as destroy-after-10-minute-idle via the existing
`visiblePreviewTabs`/`destroyPreviewTab` path; configurable constant, no
timers while visible (budget §2.8).

## D14 — Overlay freeze via existing screenshot channel (P4) — B20

DOM overlays (browser menu, import dialog, popover) render under the native
view. On open: `preview:screenshot` → capturePage dataURL → render snapshot
img in the viewport slot while `show-tab(null)` hides the view; restore on
close. No new channel needed (screenshot exists). The snapshot is
session-local only (never logged/persisted — §2.6/§9).

## D15 — Nav state from events, not polling (P4) — B1/B4

Back/forward disabled state + omnibox URL text come from real `preview:event`
`navigated` payloads; main adds `canGoBack`/`canGoForward`/`favicon` to the
navigated emit (small additive change to preview-views.ts) instead of a new
polling channel. Renderer `navigate` echoes are not trusted for URL text.
