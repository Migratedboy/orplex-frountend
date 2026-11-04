# Bug Register — Operation Zero Failure

Audit date: 2026-11-04 · Baseline `572e64d`. Statuses: CONFIRMED (reproduced/observed), FIXED (code changed), SUSPECTED (credible risk, not reproduced).

## Fixed this audit

### BUG-004 — Ghost runs: crashed server runs stay "executing" forever — P2, CONFIRMED, FIXED, regression-tested
- **Subsystem**: server-executor (`src/lib/server-executor/executor.ts`)
- **Reproduction**: a run whose `executeRun` throws before the internal try (e.g. `resolveRunCredential` or `resolveWorkspaceCwd` rejecting) lands in the poll loop's outer `.catch`, which only incremented a counter and logged.
- **Expected**: the `AgentRun` row reaches a terminal status. **Actual**: the row stayed `status: "executing"` with no `completedAt` — the UI showed an active run forever and the lease loop never revisited it.
- **Root cause**: the outer `.catch` (executor.ts ~line 2711) had no DB write.
- **Fix**: new exported `markRunFailed(runId, message)` writes terminal `status: "failed"`, a `result.summary` (`Run crashed before completion: …`, message capped at 500 chars) and `completedAt`; DB failure is logged, never thrown (the poll loop must keep leasing). Wired into the outer `.catch` with the error message included in the runtime log.
- **Regression test**: `src/lib/server-executor/__tests__/run-failure.test.ts` (3 tests: terminal write shape, message cap, DB-failure resilience). Result: server-executor suites **35/35 green**.

### BUG-002 — Malformed JSON body to /api/chat returns 500 instead of 400 — P3, CONFIRMED, FIXED, regression-tested
- **Subsystem**: chat API (`src/app/api/chat/route.ts`, `src/lib/chat-middleware.ts`)
- **Reproduction**: `POST /api/chat` with body `{not valid json` → `request.json()` throws → generic catch → 500 "An unexpected error occurred."
- **Expected**: 400 client-error. **Actual**: 500, misattributing a client bug to the server.
- **Root cause**: unguarded `await request.json()` at route line 68; the generic catch at line 458 maps everything to 500. (Sibling routes `fast`/`suggestions` already used `.catch(() => null)`.)
- **Fix**: new `parseJsonRequest(request)` in `src/lib/chat-middleware.ts` returning `{ok:true,data}` or `{ok:false,response}` with an explicit 400 "body is not valid JSON"; route now uses it before `validateRequestBody`. Malformed bodies still never consume daily quota (validation precedes `enforceDailyQuota`).
- **Regression test**: 3 new tests in `src/lib/__tests__/chat-middleware.test.ts` (valid JSON, malformed → 400, empty body → 400). Result: **23/23 green**.

### BUG-005 — Approval decision TOCTOU race — P3, CONFIRMED (by inspection), FIXED
- **Subsystem**: `src/app/api/agent/runs/[id]/approve/route.ts`
- **Reproduction**: two concurrent POSTs (double-click, two tabs) both read `status: "pending"` (line 32–41), both pass the check, then both write unconditionally — last write wins. An approve can be overwritten by a racing reject while the executor polls; both callers get `success: true`.
- **Expected**: exactly one decision wins; the loser gets 409. **Actual**: both succeed, `decidedBy`/`decidedAt` silently overwritten.
- **Root cause**: check-then-update without a status condition.
- **Fix**: `prisma.approvalRequest.updateMany({ where: { id, status: "pending" }, … })`; `count === 0` ⇒ 409 "Already decided". Ownership scoping (`run.userId`) was already correct and is unchanged.
- **Regression test**: `src/app/api/agent/runs/[id]/approve/__tests__/approve-route.test.ts` (5 tests: conditional-update shape, concurrent-loss 409, non-pending 409, ownership 404, unauthenticated 401). Result: green.

### BUG-006 — Approval timeout leaves requests "pending" forever — P3, CONFIRMED (by inspection), FIXED
- **Subsystem**: `executor.ts` `requestUserApproval`
- **Reproduction**: wait loop times out after `APPROVAL_WAIT_TIMEOUT_MS` and returns `false` (action denied), but the `ApprovalRequest` row is never marked `expired`.
- **Expected**: terminal state on timeout. **Actual**: stale `pending` rows accumulate; a late user decision writes approved/rejected on a decision nothing will ever consume.
- **Fix**: on timeout, `updateMany({ where: { id, status: "pending" }, data: { status: "expired" } })`, best-effort (`.catch`); the denial stands either way. The approve route already 409s non-pending rows, so late decisions now fail cleanly.
- **Regression test**: none added (same reasoning as BUG-005; structural fix).

### BUG-008 — Dev taskbar shows the generic Electron logo instead of Orplex Code — P3, CONFIRMED (reproduced live), FIXED, regression-tested
- **Subsystem**: Electron identity (`electron/main.ts`, `electron/icon-poison.ts`)
- **Reproduction (live, verified via UI Automation + pixel capture)**: the taskbar button read **"Electron - 1 running window"** and drew the stock Electron atom, even though (a) the branded dev binary `orplex-dev.exe` carried the correct Orplex icon and PE identity (FileDescription/ProductName "Orplex Code"), (b) `BrowserWindow.icon` was set from the multi-size `.ico`, and (c) `mainWindow.setAppDetails({ appId, appIconPath })` was called.
- **Expected**: the dev taskbar button shows the Orplex logo and the name "Orplex Code". **Actual**: generic Electron logo + name "Electron".
- **Root cause**: Electron's Windows toast-notification path self-installs a Start Menu shortcut `Electron.lnk` that carries the CURRENT app's AUMID. In dev that AUMID is `tech.orplex.app.dev` — the same one our window declares — and the shortcut targets the **stock** `node_modules/electron/dist/electron.exe` with `IconLocation = ,0`. Windows therefore resolved the taskbar button through that shortcut, which shadowed the branded binary entirely. The self-healing sweep in `main.ts` was gated on `if (!isDev)` — packaged-only — so the dev lane never cleaned it up (the gate was exactly backwards for this defect).
- **Fix**: new pure module `electron/icon-poison.ts` (no electron import, unit-testable) holding the target detection + the sweep; `main.ts` now runs the sweep in **both** lanes (module scope and again after `app.whenReady()`, because Electron creates the shortcut during toast init) and judges candidates by **TARGET**, not by file name (Electron may name it after the app). An installed `Orplex Code.exe` shortcut is never touched.
- **Regression test**: `electron/__tests__/icon-poison.test.ts` (15 tests: detection of the stock electron.exe, rejection of the branded dev binary / installed product / unrelated apps, sweep deletes only poison, survives a failing read, keeps sweeping after one failure).
- **Verification**: after the fix, the live taskbar button reads **"Orplex Code - 1 running window"** (same correct AUMID `tech.orplex.app.dev`) and the captured button pixels are identical to `electron/assets/icon.ico`; the poison shortcut is gone and only the legitimate `Orplex Code.lnk` (installed product) remains.

### BUG-009 — Repository CI was RED on main (modularization regression) — P2, CONFIRMED (reproduced from CI logs), FIXED
- **Subsystem**: test infrastructure (`electron/__tests__/next-children.test.ts`, extracted by the modularity pass `eae90c2`)
- **Reproduction**: `CI` on `main` at `572e64d` fails: `FAIL electron/__tests__/next-children.test.ts` — "swallows a missing pid rather than aborting the second child" expected `taskkill` to be spawned 2×, got 0. The previous commit's CI was green, so the regression was introduced by the kill-lane extraction.
- **Expected**: the suite is green on every runner. **Actual**: green on Windows dev machines, red on the Linux CI runner — the repo's own gate was broken before this audit started.
- **Root cause**: the extracted test asserted the Windows `taskkill` branch without pinning `process.platform` (its two sibling tests did pin it). On Linux/macOS `killNextChildren` takes the POSIX branch (`child.kill("SIGTERM")`) and never spawns `taskkill`.
- **Fix**: pin `process.platform` to `"win32"` in that case (restoring the original in a `finally`), and add a case pinning the POSIX branch (`kill("SIGTERM")`, no `taskkill`) so both documented platform paths are covered and the test is host-independent.
- **Regression test**: the file's own suite — now 5/5 green and platform-independent by construction.

### BUG-010 — The installer shipped the repo's `.env` (database password + provider API keys) — P1, CRITICAL, CONFIRMED (found in the built artifact), FIXED
- **Subsystem**: desktop packaging (`scripts/stage-desktop-package.mjs`, `electron/package-allowlist.ts`, `package.json` `build.files`)
- **Reproduction (inspected the built artifact)**: `release\win-unpacked\resources\app\.next\standalone\.env` existed in the shipped app — a **real 3,940-byte copy of the repo root `.env`** (not a symlink), plus `nexus_core_super_secret_change_in_production_k8x2m9p4q7w1`. The packaged payload was **2.9 GB**.
- **Expected**: the shipped app contains the server it runs and its dependencies — never an env file. `electron/main.ts` states the intent explicitly: *"A PACKAGED app has no .env beside it (electron-builder deliberately never ships one — it holds the database password)"*. **Actual**: the `.env` was shipped, contradicting the code's own documented contract.
- **Root cause**: Next.js 16's Turbopack build prints *"Dynamic filesystem access causes tracing of the whole project"* (18 times — `archive-extract.ts`, `backup.ts`, `janitor.ts`, `executor.ts`, `playbook.ts`, `workspace-cwd.ts`, `parallel-workspaces`, `user-skills.ts`). Dynamic filesystem paths in route handlers make the tracer copy the **entire project root** into `.next/standalone`. The staging step then copied that tree **verbatim**, so the package contained:
  | Shipped by accident | Size |
  |---|---|
  | `release/` — the previous 1 GB installer + a 550 MB `.7z` | 1,937 MB |
  | `node_modules/electron/` — a duplicate Electron runtime **including the stock `electron.exe`** (the very binary the taskbar icon poison installs) | 556 MB |
  | `node_modules/.prisma/client/*.tmp<pid>` — 14 orphaned `prisma generate` temp files | 257 MB |
  | `coverage/`, `docs-site/`, `src/`, `scripts/`, local logs, `.env`, secret markers | ~50 MB |
- **Fix**: a new pure module `electron/package-allowlist.ts` (unit-tested) defines an explicit **allowlist** of what may ship (`server.js`, `package.json`, `.next`, `public`, `node_modules`, `prisma`), the `node_modules` exclusions (`electron`), and the orphaned-Prisma-temp rule. `scripts/stage-desktop-package.mjs` now prunes the standalone tree to that allowlist before copying it, and a **hard guard** fails the build if any secret-shaped file (`.env*`, `super_secret`, `.pem`/`.p12`/`.pfx`/`.key`, `id_rsa`) reaches the staged tree. `package.json`'s `build.files` gained matching negations as a second layer.
- **Regression test**: `electron/__tests__/package-allowlist.test.ts` — 22 tests pinning the allowlist, the exclusions, the temp-file rule, the leak detection and the fact that a legitimate compiled `secret-scanner-plugin` chunk is **not** a false positive.

### BUG-011 — The release build itself failed: the 2 GB app archive breaks NSIS — P1, CONFIRMED (build failure), FIXED
- **Subsystem**: desktop packaging (`electron-builder` / NSIS)
- **Reproduction**: `npm run electron:dist` for **1.0.30** failed at the final NSIS step: `Error: failed creating mmap of "D:\orplex\release\orplex-code-1.0.30-x64.nsis.7z"` → `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` → `Orplex-Code-Setup-1.0.30.exe` was left as a **0.2 MB stub**. The app archive had reached **2,082 MB** (`APP_64_UNPACKED_SIZE=3346233` KB ≈ 3.3 GB).
- **Expected**: the installer builds. **Actual**: the release build fails outright.
- **Root cause**: `makensis.exe` is a **32-bit** process and cannot memory-map a file larger than 2 GB. The payload crossed that line because of BUG-010: the app contained the previous release's 1 GB installer plus a duplicate Electron runtime. The 1.0.29 build (1,042 MB installer) was the last one that fit — the packaging was one release away from a hard failure.
- **Fix**: the BUG-010 prune removes the junk, so the payload returns to a fraction of its size and the NSIS step has ample headroom. The hard guard also prevents a payload like this from ever reaching the packer again.
- **Regression test**: covered by the BUG-010 allowlist tests plus the build itself (the installer now builds and the installed app is launched and verified — see FINAL-STABILIZATION-REPORT §18.9).

## Verified not-bugs (investigated, no defect)

- **LOCAL_ONLY routing boundary** (`src/proxy.ts`): device-local routes are deliberately never forwarded to the cloud; documented in-code with the terminal-cwd rationale.
- **Dev session bypass**: cannot activate in production (`NODE_ENV` gate first, `DEV_AUTH_BYPASS` override).
- **Electron IPC**: all handlers go through `handleAppIpc` origin validation; sandboxed views have no bridge.
- **`/api/debug/user`**: requires a real session; returns only the caller's own fields.
- **Provider parameter handling**: reasoning families correctly use `max_completion_tokens` and skip `temperature`.
- **run-sync double-writes**: `trackTaskEnd` is idempotent via the `settled` flag and awaits the create promise.

## Suspected risks (not reproduced, tracked)

- **SUS-01 — DNS rebinding** in browser/MCP fetch targets: documented out of scope in `ssrf-guard.ts`. A hostile domain resolving to a private IP after the initial check could bypass the guard. Mitigation would require pinning resolved IPs per request. Severity if real: P2.
- **SUS-02 — Packaged-app startup**: RESOLVED for the BUILD side — `npm run electron:dist` ran the complete pipeline (Next build → standalone → Electron main compile → staging → NSIS installer → blockmap) and the updater feed verifies for windows/mac/linux. The INSTALLED app was not launched, so runtime startup of the installed binary remains unexercised (recorded in FINAL-STABILIZATION-REPORT §18.9).
- **SUS-03 — Real-provider tool-schema compatibility**: RESOLVED 2026-11-04 — `scripts/audit-live-tools.mjs` verified live tool-calling against real APIs: **groq (compact tier, qwen/qwen3.8-27b) PASS** and **openrouter (full tier, recursive/flint-v1.0:free) PASS** — both returned a well-formed `read_file` tool call with valid JSON args. Observed provider behavior worth knowing: one Groq model emitted a malformed tool call and Groq's server-side validation hard-failed the whole request with 400 (the app's client-side per-arg error handling never runs in that case); a different Groq model behaved correctly. Mitigation is the existing provider failover. OpenRouter paid models were untestable (402 Insufficient credits — account limitation, not a code issue); a `:free` model was verified instead.

## Statistics

| Category | Count |
|---|---|
| Bugs confirmed | 8 (BUG-002, BUG-004, BUG-005, BUG-006, BUG-008, BUG-009, BUG-010, BUG-011) |
| Bugs reproduced at runtime / from CI logs / from the built artifact | 6 (BUG-002, BUG-004, BUG-008 live; BUG-009 from the CI job log; BUG-010 from the built artifact; BUG-011 from the build failure) |
| Bugs fixed | 8 |
| Bugs verified fixed by regression test | 6 (BUG-002, BUG-004, BUG-005, BUG-008, BUG-009, BUG-010) |
| Bugs fixed by structural change (no dedicated test) | 2 (BUG-006, BUG-011 — the latter verified by the build succeeding again) |
| Bugs remaining open | 0 |
| Security vulnerabilities fixed | 1 critical dependency (next/og RCE) + 1 critical app-level (the `.env` shipped in the installer) |
| Suspected risks tracked | 3 (SUS-01..03; SUS-03 resolved) |
| Blocked investigations | 0 |
| CI on `main` before → after the fix | red → **green** (PR #22, merge commit `7ed15c6`) |
| Installer payload before → after the packaging fix | 2,926 MB → 124 MB |
