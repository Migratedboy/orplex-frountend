# Regression Strategy — Operation Zero Failure

## Principles

1. Every bug fix ships with a regression test that **fails on the old code** (BUG-004 and BUG-002 did; BUG-005/006 are structural DB-level guarantees documented as such).
2. Invariants are enforced by tests and by construction (generated rosters, conditional DB updates), not by documentation or grep.
3. Targeted tests after each fix; full suite at milestones (baseline: 210 suites / 2,337 tests).

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

## Automated checks (status)

1. ~~Roster-count assertion~~ — **DONE**: `src/lib/__tests__/tool-roster.test.ts` pins that the prompt roster renders every registry name, the headline count matches, the compact tier is a strict subset, and provider classification matches the lists.
2. ~~Approval-route decision race~~ — **DONE**: `src/app/api/agent/runs/[id]/approve/__tests__/approve-route.test.ts` pins the conditional update, concurrent-loss 409, ownership 404, and auth 401.
3. Packaged-startup smoke check in CI (Mission 15) — still manual; recommended follow-up.
4. Live-provider tool-call probe — **DONE** as a manual script: `scripts/audit-live-tools.mjs` (groq + openrouter verified 2026-11-04); wire into a scheduled CI job if keys become available there.

## What a future change must never do

- Bypass `requireAuth`/`requireAdmin` on a route.
- Replace a real implementation with a mock in production paths.
- Weaken a test to make a fix pass.
- Hand-write a tool list in the prompt instead of generating it from the registry.
