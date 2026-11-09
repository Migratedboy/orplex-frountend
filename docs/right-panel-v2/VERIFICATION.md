# VERIFICATION — Right Panel v2

Per §11. Automated gates first (commands + outputs), then the manual Electron
run table. "Evidence or it didn't happen" (§2.10).

> Automated results are recorded live as each phase lands; the manual table is
> user-run in the dev Electron build (the window itself is not scriptable).
> Pending rows are honest — nothing claims pass without output.

## Automated gates (per phase)

| Phase | Gate | Result |
|---|---|---|
| P1 Shell | jest `panel-state.test.ts` 16/16 · `tsc --noEmit` (0) · `npm run lint` (0/0) | ✓ (commit `f9aacba`) |
| P2 Scratch/Queue/Terminal | jest 14/14 (scratch-blocks + terminal-format) · tsc (0) · lint (0/0) | ✓ (`e0e845a`) |
| P3 Files/Changes | jest 30/30 (git-changes, fs-ops-validate, proxy-origin-guard) · `tsc -p electron/` (0) · tsc (0) · lint (0/0) | ✓ (`156e04a`) |
| P4 Browser core | jest 23/23 (freeze + preview-logic incl. new localhost pin + navStateOf) · electron tsc (0) · tsc (0) · lint (0/0) | ✓ (`1bb5e65`) |
| P5 Menu + Import | jest 92/92 (all new suites incl. browser-data-import 9/9) · electron tsc (0) · tsc (0) · lint (0/0 after fixing 1 unused-disable) | ✓ (`0a6bdf8`) |
| P6 Purge | `rg` purge → only `<input placeholder>` + comments (no SEED_DEMO/fakes/iframes) · `audit-wiring.mjs` ✓ passed · dead `rp-*` legacy CSS deleted (−~250 rules) | ✓ (`2cedca4`) |
| P7 Hardening | bounds tick + Queue poll gated to visible/open; menu Esc; full `npm test` | in progress (`=== FULL TESTS IN BACKGROUND ===`) |
| P8 Docs | ARCHITECTURE.md: LOCAL_ONLY 9→13, §2 preview v2, §15 terminal, §18 counts (107 comps), module maps, 126 routes | ✓ (this commit with P7) |

## Runtime probes blockers to note

- Chromium cookie decryption uses `node:sqlite` + DPAPI (Windows). Whether
  the Electron 41 runtime exposes `node:sqlite` is detected at runtime
  (`sqliteAvailable()`, D6): if absent, both cookie paths degrade to the
  cookie-file flow with an honest notice — recorded per §5.5.
- Chrome 127+ App-Bound Encryption (v20) cookies are never attempted to be
  decrypted; the dialog reports them as skipped with the cookie-export
  extension instructions (§8).

## Manual Electron run table (user-run, `npm run dev`)

The dev session runs hot-reload + branded Electron; main-side IPC changes
require the relaunch already in place. Check each row, note failures.

### Shell & tabs
- [ ] Fresh install → empty launcher with 6 entries; click opens the tab
- [ ] Tab ✕ closes; "+" popover lists closed tabs; all-open shows "All tabs are open"
- [ ] Tab switch persists across reload (orplex.rightPanelTabs; legacy `preview` key migrates to Local browser)
- [ ] Ctrl+B toggle, Ctrl+T terminal, Ctrl+1…6 jumps; TopBar toggle aria-label intact (tour step)
- [ ] Resize grip drags; double-click resets to 620; keyboard arrows work
- [ ] Closing the Browser tab keeps the view (state kept); after 10 min idle it frees (Task Manager views count)

### Queue / Scratch / Terminal
- [ ] Queue: run a task → orange ▶ + animated dots; done → green ✓; error → red ✗; click row jumps to the conversation; Stop works
- [ ] Queue count badge on the tab bar during runs
- [ ] Scratch: run a task → headed blocks (Plan/Hypotheses/Findings/Next…), pulsing dot on the most recently updated block; no persistence after reload
- [ ] Terminal: real cwd prompt; type a command → runs in the workspace; Ctrl+C cancels; `clear`; scroll up stays scrolled; Up/Down history; server chips with stop

### Files
- [ ] Open a folder → lazy tree expands on click; `.git`/`node_modules`/`.next` hidden, other dotfiles shown
- [ ] Filter narrows; 3+ chars with no match → content search runs
- [ ] New file / New folder create on disk (see in Explorer); Windows reserved name rejected with reason
- [ ] Upload drills the native dialog; collision shows Replace/Keep both/Cancel
- [ ] Right-click: rename, delete (desktop → Recycle Bin; else `.orplex/trash`), reveal in Explorer, copy path
- [ ] Click image file → viewer; click .md → rendered; click code → raw
- [ ] Files created by upload land in Changes Uncommitted (git repo)

### Changes
- [ ] Git repo: Uncommitted lists working-tree changes incl. untracked; All adds branch commits
- [ ] Row expand → per-file DiffView; totals match; branch shown in the header
- [ ] Row hover Undo (when a snapshot exists), Checkpoint save, Restore picker (latest run)
- [ ] Non-git folder: honest empty state + history list with undo

### Browser (Local browser)
- [ ] Empty state: breathing globe + "Start browsing" + live port chips (click :3000 → dev server loads with working HMR)
- [ ] Omnibox: search → Google; `example.com` → https; `localhost:3000` → http (raw-input through main, D3)
- [ ] Back/Forward enable/disable from real history; URL text follows events (D15)
- [ ] Tab strip close + "+"; favicon + title per tab; `target=_blank` opens a new preview tab
- [ ] Agent mirror: ask the agent to browse → its tab appears; watch/takeover badge works
- [ ] Resize grip / switching tabs / menu open → native view never overlaps DOM, never flashes (snapshot freeze)
- [ ] Failure surface: type a bad host → DNS card + Retry + Open in Chrome
- [ ] Private tab: menu creates one; "Private" chip; cookies don't leak to the default profile; close destroys it
- [ ] Open DevTools → detached DevTools on the preview only; Hard reload bypasses cache
- [ ] Floating preview: undock → draggable always-on-top window; close → docks back
- [ ] Record: getDisplayMedia prompt (app window only) → stop → webm saved under `userData/recordings/`; "Reveal in folder" works (recording:reveal)
- [ ] Recent pages submenu shows real visited URLs; Clear works
- [ ] Profiles: create/rename/delete/switch (switch recreates tabs on the new partition)
- [ ] Browser data: sizes shown; Clear cache/cookies/site data/history work behind confirm
- [ ] Import dialog: detect lists real browsers; tick Cookies → import → counts shown; Firefox cookie import → signed-in site; Chrome → v20 rows report as "protected" with the cookie-export note
- [ ] Extensions dialog: real enumeration; tick → Load → per-extension loaded/failed status; Electron subset caveat shown

### Visual pass
- [ ] Light + dark compared against `_ref/freebuff-right-panel.html` (tokens bound to app theme)
- [ ] Open all 6 tabs → no runaway timers (Task Manager CPU flat); low-RAM per 8 GB target
