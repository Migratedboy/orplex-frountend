# Orplex Code — System Inventory (Operation Zero Failure)

Audit date: 2026-11-04 · Baseline commit: `572e64d` (main, post v1.0.29) · Tree was clean at baseline.

## 1. Top-level architecture

| Layer | Location | Notes |
|---|---|---|
| Electron main | `electron/main.ts` (43k), `preload.ts`, `terminal.ts`, `auth-desktop.ts`, `conversations-store.ts`, `loopback.ts`, `updater.ts`, `tray.ts` | Owns both Next.js child processes (UI :5000, API :5010, env-overridable) |
| Renderer / React | `src/components`, `src/hooks` | Main window holds the preload bridge; preview/agent views are sandboxed with **no** preload |
| Next.js App Router | `src/app/api/**` route handlers | Served by the API child process; desktop proxy in `src/proxy.ts` |
| Prisma + hosted PostgreSQL | `prisma/schema.prisma` | Backend-owned; no embedded DB (removed architecture, intentionally not reintroduced) |
| Agent engine (client lane) | `src/lib/background-worker.ts`, `loop-engine.ts`, `agent/native-tools.ts` | In-browser worker |
| Agent engine (server lane) | `src/lib/server-executor/executor.ts` | Leases `AgentRun` rows with `executionTarget="server"` |
| Shared contracts | `src/lib/tool-definitions.ts`, `src/lib/agent/contract/`, `src/lib/master-prompt.ts` | Tool schemas, prompt assembly |
| Reliability subsystem | `src/lib/reliability/*` (edit-lock, path-jail, verification-report, acceptance, flags, injection-scanner, egress/capability policy) | Wired into `background-worker.ts` and `executor.ts` |
| Local-first storage | `conversations.json`, `workspaces.json`, `playbook.json` via `electron/conversations-store.ts` | Atomic temp+rename writes, corruption quarantine |
| Memory watchdog | `src/lib/hardware.ts`, started unconditionally from `src/instrumentation.ts` | Thresholds 70/85/92 %, `CRITICAL_STREAK = 3` hysteresis |
| Packaging / CI | `release-app.yml` builds on `v*` tags; `scripts/check-updater-feed.mjs` verifies feed consistency | |

## 2. Execution lanes and their entry points

- **Interactive chat**: `POST /api/chat` → `requireAuth` → burst limit → body validation → daily quota → provider stream.
- **Background tasks (client)**: `background-worker.ts` loop, tool dispatch through `agent/native-tools.ts`.
- **Server runs**: `executor.ts` poll loop → `leaseOneRun()` (claims `pending` → `executing`) → `executeRun()` → terminal status write.
- **Subagents**: `spawn_subagent` handled specially in both lanes; depth is structurally 1 (subagent dispatch only allows discovery tools).

## 3. Security surfaces (verified this audit)

| Surface | File | Verification |
|---|---|---|
| IPC sender validation | `electron/main.ts` `handleAppIpc` (all handlers) | Origin-checked; sandboxed views have no preload bridge |
| Navigation guards | `electron/main.ts` `setWindowOpenHandler`, `will-navigate`, in-page redirect guard | External URLs go to `shell.openExternal` |
| Local-first store | `electron/conversations-store.ts` | Atomic temp+rename; corrupted store renamed aside (`.corrupt-<ts>`), never deleted |
| Admin routes | `src/app/api/admin/*` | All call `requireAdmin()`; 401/403 mapped explicitly |
| Dev session bypass | `src/app/api/dev/session/route.ts` | Hard-gated on `NODE_ENV !== "production"`, `DEV_AUTH_BYPASS` kill switch |
| LOCAL_ONLY routing | `src/proxy.ts` (`LOCAL_ONLY_API_ROUTES`, `LOCAL_ONLY_API_PREFIXES`) | Device-local filesystem ops never forwarded to the cloud backend; deliberate and documented |
| Write containment | `src/lib/reliability/path-jail.ts` `assertSafeWrite` | realpath containment first, then denylist inside the workspace |
| SSRF | `src/lib/ssrf-guard.ts` + `checkUrlPolicy` (browser, MCP `ssrf-fetch`) | Blocks non-http(s), private/loopback/link-local/metadata hosts; DNS rebinding documented out of scope; unit-tested |
| Command screening | `src/lib/exec-guard.ts` `isCommandAllowed` | Length cap 4000, multi-line refusal, blocklist; used by `exec` and `serve` routes |
| Provider params | `src/lib/ai-providers.ts` | Reasoning families get `max_completion_tokens` and no custom `temperature`; legacy `max_tokens` otherwise |
| Approval gate (server lane) | `executor.ts` `requestUserApproval` | Fail-closed: DB write failure ⇒ denial; expiry now recorded (BUG-006) |

## 4. Findings that changed code this audit

See `BUG-REGISTER.md` for full records: BUG-004 (ghost runs), BUG-002 (chat 400/500), BUG-005 (approval TOCTOU), BUG-006 (approval expiry). All four fixed; BUG-004 and BUG-002 have regression tests.

## 5. Verified-good behaviors (evidence-based)

- Baseline suite: **210 suites / 2,337 tests passed (1 skipped)** at `572e64d`.
- `JSON.parse` call sites in `ai-providers.ts` and `stream-reader.ts` are try/catch-guarded; malformed tool-call arguments degrade to a readable per-arg error, not a crash.
- Loop breakers (`createLoopStreaks`) present in both lanes (executor line ~1430; worker parity).
- `spawn_subagent` budget enforced at dispatch in both lanes (`effortBudget.subagentLimit`); refusals are honest tool results, not silent failures.
- Checkpoint restore records an inverse snapshot **before** mutating the tree, so restore is itself undoable; overlay deletion handles files created after the checkpoint.
- Run sync is idempotent (first terminal write wins); project sync merges rosters with newer-`lastOpenedAt`-wins conflict resolution.
- The system-prompt tool roster is **generated from `M3_TOOL_DEFINITIONS`** (cannot drift from the registry).

## 6. Known limitations / out of scope

- DNS rebinding protection (documented in `ssrf-guard.ts` as out of scope).
- Packaged-app (installer) startup was not exercised in this session — dev-mode and build-level verification only. See FINAL-STABILIZATION-REPORT §18.6.
- Real-provider tool-call integration tests were not run against live API keys this session; provider behavior is covered by mocked fixtures plus the per-family parameter logic.
