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
- **Regression test**: none added — the race is a DB-level concurrency property; the conditional update is the structural guarantee. Honest status: fixed by construction, not by test.

### BUG-006 — Approval timeout leaves requests "pending" forever — P3, CONFIRMED (by inspection), FIXED
- **Subsystem**: `executor.ts` `requestUserApproval`
- **Reproduction**: wait loop times out after `APPROVAL_WAIT_TIMEOUT_MS` and returns `false` (action denied), but the `ApprovalRequest` row is never marked `expired`.
- **Expected**: terminal state on timeout. **Actual**: stale `pending` rows accumulate; a late user decision writes approved/rejected on a decision nothing will ever consume.
- **Fix**: on timeout, `updateMany({ where: { id, status: "pending" }, data: { status: "expired" } })`, best-effort (`.catch`); the denial stands either way. The approve route already 409s non-pending rows, so late decisions now fail cleanly.
- **Regression test**: none added (same reasoning as BUG-005; structural fix).

## Verified not-bugs (investigated, no defect)

- **LOCAL_ONLY routing boundary** (`src/proxy.ts`): device-local routes are deliberately never forwarded to the cloud; documented in-code with the terminal-cwd rationale.
- **Dev session bypass**: cannot activate in production (`NODE_ENV` gate first, `DEV_AUTH_BYPASS` override).
- **Electron IPC**: all handlers go through `handleAppIpc` origin validation; sandboxed views have no bridge.
- **`/api/debug/user`**: requires a real session; returns only the caller's own fields.
- **Provider parameter handling**: reasoning families correctly use `max_completion_tokens` and skip `temperature`.
- **run-sync double-writes**: `trackTaskEnd` is idempotent via the `settled` flag and awaits the create promise.

## Suspected risks (not reproduced, tracked)

- **SUS-01 — DNS rebinding** in browser/MCP fetch targets: documented out of scope in `ssrf-guard.ts`. A hostile domain resolving to a private IP after the initial check could bypass the guard. Mitigation would require pinning resolved IPs per request. Severity if real: P2.
- **SUS-02 — Packaged-app startup**: readiness checks must target the same loopback address the child binds to (Windows IPv4/IPv6 loopback divergence). Not exercised this session (no packaged run). Severity if real: P1.
- **SUS-03 — Real-provider tool-schema compatibility**: compact/full tool paths verified against mocked fixtures only; live-provider drift (e.g. a provider rejecting a schema) would surface as provider-side errors, not silent capability loss. Severity if real: P3.

## Statistics

| Category | Count |
|---|---|
| Bugs confirmed | 4 (BUG-002, BUG-004, BUG-005, BUG-006) |
| Bugs reproduced at runtime | 2 (BUG-002, BUG-004) |
| Bugs fixed | 4 |
| Bugs verified fixed by test | 2 (BUG-002, BUG-004) |
| Bugs fixed by structural change (no dedicated test) | 2 (BUG-005, BUG-006) |
| Bugs remaining open | 0 |
| Suspected risks tracked | 3 (SUS-01..03) |
| Blocked investigations | 0 |
