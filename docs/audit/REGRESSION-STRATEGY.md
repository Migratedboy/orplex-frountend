# Regression Strategy — Operation Zero Failure

## Principles

1. Every bug fix ships with a regression test that **fails on the old code** (BUG-004, BUG-002, BUG-008 and BUG-009 did; BUG-005/006 are structural DB-level guarantees documented as such).
2. Invariants are enforced by tests and by construction (generated rosters, conditional DB updates), not by documentation or grep.
3. Targeted tests after each fix; full suite at milestones (baseline: 210 suites / 2,337 tests → final: 214 suites / 2,369 tests).
4. **A test must assert the behaviour, not the host it happens to run on.** A test that only passes on Windows (or only on Linux) is a broken gate, not a passing test — BUG-009 was exactly this, and it left the repository's CI red on `main` for an entire release cycle.

## Per-subsystem invariants, failure conditions, and required tests

### Tool registry ↔ prompt ↔ schema consistency
- **Invariant**: the system-prompt roster is *generated from* `M3_TOOL_DEFINITIONS`; schema count rendered in the identity line matches the registry.
- **Failure it prevents**: a tool added to the registry but invisible to the model (silent capability loss), or a stale hand-written count.
- **Required test**: any change to `tool-definitions.ts` must keep `master-prompt.ts` compiling against it (TS already enforces the import); a roster-count assertion test would harden this further — recommended follow-up.

### Run lifecycle (server lane)
- **Invariant**: every claimed run reaches a terminal status (`completed`/`failed`) with `completedAt`, no matter where it throws.
- **Failure it prevents**: ghost runs stuck in `executing` forever (BUG-004).
- **Required test**: `src/lib/server-executor/__tests__/run-failure.test.ts` — pins `markRunFailed` shape, message cap, and DB-failure resilience.

### API error contracts
- **Invariant**: client errors are 4xx, server errors are 5xx; malformed bodies never consume quota.
- **Failure it prevents**: 500-for-400 misattribution (BUG-002).
- **Required test**: `parseJsonRequest` cases in `chat-middleware.test.ts`.

### Approval integrity
- **Invariant**: exactly one decision wins per approval; timed-out approvals become `expired`, never decided late; no DB ⇒ fail-closed denial.
- **Failure it prevents**: TOCTOU double-decision (BUG-005), stale pending rows + posthumous decisions (BUG-006).
- **Required test**: structural (conditional `updateMany`); an integration test with a real DB would be the ideal hardening — recommended follow-up.

### Security boundaries (must never regress)
- Electron IPC origin validation (`handleAppIpc`) — covered by `electron/__tests__`.
- Path containment (`path-jail` `assertSafeWrite`) — `reliability.test.ts`.
- SSRF policy (`checkUrlPolicy`, MCP `ssrf-fetch`) — `browser-url-policy.test.ts`, `mcp-ssrf-fetch.test.ts`.
- Command screening (`exec-guard`) — existing exec-guard suites.
- Dev bypass gate — must stay `NODE_ENV`-gated; any relaxation is a P0.
- **Monitoring signal**: any PR touching `electron/main.ts`, `ssrf-guard.ts`, `exec-guard.ts`, `path-jail.ts`, or `proxy.ts` should require the corresponding suite in CI.

### Local-first data safety
- **Invariant**: atomic writes (temp+rename), corruption quarantined (never deleted), restore records inverse history before mutating.
- **Required test**: existing conversations-store and checkpoints suites; fault-injection cases (crash-during-write, corrupted JSON) belong to the desktop suite.

### Resource limits
- **Invariant**: watchdog thresholds 70/85/92 % with `CRITICAL_STREAK = 3` hysteresis; subagent budgets enforced in both lanes; loop breakers in both lanes.
- **Required test**: `hardware.test.ts`, executor/worker suites.

### Windows taskbar identity
- **Invariant**: the shell resolves the taskbar button through the app's own AppUserModelID, never through a shortcut that points at the stock `electron.exe`.
- **Failure it prevents**: the taskbar shows the Electron logo and the name "Electron" (BUG-008), even when the branded binary, `BrowserWindow.icon` and `setAppDetails` are all correct.
- **Required test**: `electron/__tests__/icon-poison.test.ts` — pins which shortcut targets count as poison, that the sweep runs in both lanes, and that it never deletes a legitimate shortcut.

### CI gate integrity (host-independent tests)
- **Invariant**: every test passes on Linux CI **and** on a Windows dev box; platform-dependent behaviour is pinned explicitly (`process.platform` is stubbed and restored) instead of inherited from the runner.
- **Failure it prevents**: a green local run hiding a red repository gate (BUG-009).
- **Required test**: `electron/__tests__/next-children.test.ts` — both branches pinned (`taskkill` on win32, `SIGTERM` elsewhere). Any new test touching `process.platform`, path separators, or OS-specific binaries must stub the platform explicitly.

### Installer payload (what may ship)
- **Invariant**: the packaged app contains the server it runs and the dependencies that server loads — **never** an env file, a previous release artifact, a duplicate runtime or the source tree. The staged tree is exactly: `server.js`, `package.json`, `.next`, `public`, `node_modules`, `prisma`.
- **Failure it prevents**: shipping the repo's `.env` (database password + provider API keys) to every user, and a payload large enough to break the 32-bit NSIS packer (BUG-010, BUG-011).
- **Required test**: `electron/__tests__/package-allowlist.test.ts` pins the allowlist, the `node_modules` exclusions, the orphaned-Prisma-temp rule and the leak detection. In addition, `scripts/stage-desktop-package.mjs` runs a **hard guard**: if any `.env*` / secret-shaped file reaches the staged tree, the release build fails. That guard is the enforcement point — the unit tests pin the rules, the guard enforces them.

## Automated checks (status)

1. ~~Roster-count assertion~~ — **DONE**: `src/lib/__tests__/tool-roster.test.ts` pins that the prompt roster renders every registry name, the headline count matches, the compact tier is a strict subset, and provider classification matches the lists.
2. ~~Approval-route decision race~~ — **DONE**: `src/app/api/agent/runs/[id]/approve/__tests__/approve-route.test.ts` pins the conditional update, concurrent-loss 409, ownership 404, and auth 401.
3. ~~Taskbar icon-poison sweep~~ — **DONE**: `electron/__tests__/icon-poison.test.ts` (15 tests) pins the detection and the sweep.
4. ~~Host-independent kill lane~~ — **DONE**: `electron/__tests__/next-children.test.ts` pins both the Windows `taskkill` and the POSIX `SIGTERM` branch.
5. ~~Taskbar icon-poison sweep~~ — **DONE**: `electron/__tests__/icon-poison.test.ts` (15 tests) pins the detection and the sweep.
6. ~~Host-independent kill lane~~ — **DONE**: `electron/__tests__/next-children.test.ts` pins both the Windows `taskkill` and the POSIX `SIGTERM` branch.
7. ~~Installer payload allowlist~~ — **DONE**: `electron/__tests__/package-allowlist.test.ts` (22 tests) pins what may ship; the staging script enforces it with a hard guard that fails the build on a secret file.
8. Packaged-startup smoke check in CI (Mission 15) — still manual; recommended follow-up. A packaged launch was performed manually for v1.0.30 (see FINAL-STABILIZATION-REPORT §18.9), but it is not yet an automated CI gate.
9. Live-provider tool-call probe — **DONE** as a manual script: `scripts/audit-live-tools.mjs` (groq + openrouter verified 2026-11-04); wire into a scheduled CI job if keys become available there.
10. **Repository CI must be green on `main`** — it was red before this audit (BUG-009). Any future commit that lands with a red `Tests` check re-opens that defect; the PR gate is the enforcement point.

## What a future change must never do

- Bypass `requireAuth`/`requireAdmin` on a route.
- Replace a real implementation with a mock in production paths.
- Weaken a test to make a fix pass.
- Hand-write a tool list in the prompt instead of generating it from the registry.
