# MODULARIZATION-REPORT.md — Operation Modularity

## 1. Initial repository condition

Measured across `src/`, `electron/`, `scripts/`, `cli/src/`, `vscode-extension/src/`, `docs-site/docs/`, `evals/`: **766 source files, ~130,505 lines**. Buckets: 130 files at 200–400 lines, 36 at 400–700, 9 at 700–1,000, **11 over 1,000 lines**. Full assessment with responsibility maps, line ranges and duplication findings: `MODULARIZATION-AUDIT.md`.

Baseline at audit time (verified by execution): `npm run lint` ✅ · `npm run typecheck` ✅ · `npm test` → **201 suites / 2160 tests passed, 1 skipped**. No source was modified during the audit phase.

## 2. Files investigated

Top oversized files with line counts are in `MODULARIZATION-AUDIT.md` §1/§3: `background-worker.ts` (3,502), `server-executor/executor.ts` (2,727), `agent/native-tools.ts` (2,141), `electron/main.ts` (1,962), `RightPanel.tsx` (1,301), `model-catalog.ts` (1,202), `PromptBar.tsx` (1,180), `skills.ts` (1,132), `ChatInput.tsx` (1,128), `settings/page.tsx` (1,089), `useChatSession.ts` (1,043), plus the routes `api/chat` (465), `api/agent/ledger` (276), `api/agent/serve` (275), `api/agent/exec` (207).

**Tool-registry reconciliation:** the canonical registry (`M3_TOOL_DEFINITIONS`, `src/lib/tool-definitions.ts:7`) holds **42 tools**, not the documented 41. All 42 are represented in the system-prompt roster (`buildToolRoster`, `master-prompt.ts:108–132`) and reach both lanes' dispatchers. 42 is the source of truth; no tool was removed, renamed, or disabled.

## 3. Files refactored (old structure → new structure)

| Old | New | Type of change |
|---|---|---|
| `electron/main.ts` — two verbatim-twin child-kill loops (`will-quit` at ~1795, `shutdownMain` at ~1944) + dead `node:net` import | Killing logic moves to `electron/next-children.ts` (`killNextChildren`); `main.ts` calls it from both paths; dead import removed. `main.ts` keeps child-ownership and shutdown ordering. | pure extraction + dead-code removal |
| `src/app/api/agent/ledger/route.ts` (276 lines: normalization + Prisma transaction + HTTP in one file) | Business core extracted to `src/lib/task-ledger.ts` (`normalizeLedgerPayload`, `persistRunOutcome`, `listOpenFailures`, `workspaceKeyFrom`); route is now a thin coordinator: auth → normalize → persist → HTTP error mapping. Route went 276 → 96 lines. | service extraction |
| `src/app/api/chat/route.ts` — inline failure regexes, message ternary, and model-id/ctx-window helpers | `src/lib/provider-failure-policy.ts` (`isPayloadTooLargeError`, `isPermanentRejection`, `providerFailureMessage`) + `src/lib/model-context-windows.ts` (`bareModelId`, `loadContextWindows`, `contextWindowForModel`). Route keeps the retry loop; policy is now tested in isolation (17 tests). The TPM regex behavior was pinned as-is (a 429 naming the TPM cap IS the lean-retry trigger). | policy/service extraction |
| `src/app/api/agent/serve/route.ts` — inline `detectPort`/`waitUntilListening`/`treeKill` | `src/lib/serve-process.ts`, identical implementations; the serve registry, auth and spawn orchestration stay in the route. Spawn options deliberately NOT centralized (they are per-attempt business rules). | helper extraction |

## 4. Responsibilities extracted

1. **Platform child-process kill (electron)** — was duplicated verbatim in two teardown paths; now one implementation. Startup/shutdown ordering is unchanged: `will-quit` still writes the clean session mark *before* children die; `shutdownMain` still kills terminal children first, then Next children, then writes the mark.
2. **Ledger payload definition + persistence (server)** — the "what is a ledger payload" rules (dual-shape normalization, fail-closed caps, `passedLanes → resolveKinds`, sha256 `detailHash` upsert identity, one-transaction write) live in one module testable without HTTP.

## 5. Public contract preservation

- Ledger route: same endpoint, same status codes (401/400/500/200), same response bodies (`{error}`/`{ok, error}`/`{ok, failures:[…]}`), same auth behavior. Regression net: the pre-existing route test (`src/app/api/agent/ledger/__tests__/route.test.ts`, 10 cases) passes unchanged — it exercises POST/GET against a mocked `@/lib/prisma`, which now binds to the service module instead.
- Electron: no IPC channel, no startup order, no shutdown order, no platform behavior changed (`taskkill /pid X /T /F` on win32, SIGTERM elsewhere); identical skip conditions for killed/null children.

## 6. Dependency improvements

- Dead import removed: `electron/main.ts` no longer imports `node:net` (verified unused: only occurrence was the import line).
- Coupling reduced: the ledger route no longer owns Prisma-op assembly; `electron` teardown logic has one copy instead of two.
- Divergent copies deliberately NOT merged (behavior decisions, flagged to the owner in `MODULARIZATION-RULES.md` M6): the diverged `diagnosePortConflict` copies (`background-worker.ts` vs `agent/serve-helpers.ts`) and the two same-named `validateToolArgs` validators (`reliability/tool-args` vs `agent/contract/tools`).

## 7. AI-usability improvements

- `docs/architecture/MODULE-MAP.md` answers "where does X live" without repo-wide search; `MODULARIZATION-RULES.md` states the hard boundaries (`electron/`↔`src/` walls, lane-parity rules) so an agent stops copying shared functions into the wrong lane.
- `/api/agent/ledger` is now explainable on one screen: HTTP surface in the route, semantics in `src/lib/task-ledger.ts`.

## 8. Testing evidence (exact commands, real results)

Command run | Result
--- | ---
`npx jest src/lib/__tests__/task-ledger.test.ts electron/__tests__/next-children.test.ts src/app/api/agent/ledger --forceExit` | **3 suites passed, 34 tests passed** (16 new tests added this phase)
`npm run lint` | pass
`npm run typecheck` | pass (both tsconfigs)
`npm test -- --silent` (full suite) | **203 suites passed (1 skipped), 2176 tests passed, 2177 total** — up from the 201/2160 baseline, i.e. existing behavior intact plus 16 new regression tests

Second modularization pass (provider-failure policy + context-window helpers + serve process helpers) added 25 more tests:

Command run | Result
--- | ---
`npx jest src/lib/__tests__/provider-failure-policy.test.ts src/lib/__tests__/model-context-windows.test.ts --forceExit` | **17 tests passed**
`npx jest src/lib/__tests__/serve-process.test.ts --forceExit` | **8 tests passed** (incl. a real TCP bind for `waitUntilListening`)
`npm run typecheck` / `npm run lint` | pass
`npm test -- --silent` (full suite) | **206 suites passed (1 skipped), 2201 tests passed, 2202 total**

New regression tests:
- `src/lib/__tests__/task-ledger.test.ts` — pins fail-closed rejection, dual-shape normalization, field caps, `resolveKinds` mapping/dedupe, sha256 upsert identity, one-transaction persistence, GET row shaping (incl. non-array `files` survival).
- `electron/__tests__/next-children.test.ts` — pins win32 taskkill (`/T /F`), skip-killed, both-attempt swallow behavior.
- `src/lib/__tests__/provider-failure-policy.test.ts` — pins lean-retry trigger regex, permanent-rejection class (incl. 413, and NOT 429/5xx), and the exact shipping user copy.
- `src/lib/__tests__/model-context-windows.test.ts` — pins bare-id fallback, never-throw catalog contract, cap/skip rules.
- `src/lib/__tests__/serve-process.test.ts` — pins port-declaration detection, real-TCP readiness probe, win32/POSIX treeKill split (incl. group-kill fallback and already-dead pid survival).

Third modularization pass (native preview/agent browser + UI catalog hook + behavior-decision items) added 33 more tests:

Command run | Result
--- | ---
`npx jest electron/__tests__/preview-logic.test.ts --forceExit` | **20 tests passed** (URL normalization, bounds clamping, ref resolution, console formatting, find filtering, wait clamps)
`npx jest src/lib/agent/contract src/lib/__tests__/tool-args.test.ts src/lib/__tests__/serve-lane.test.ts --forceExit` | **61 tests passed** (incl. the new lane-parity identity check and the permission-denied wrong-hint fix)
`npx jest src/lib/agent/contract/__tests__/results.test.ts --forceExit` | **9 tests passed** (envelope bytes + lane dialect delta map)
`npx jest src/hooks/__tests__/useModelCatalog.test.tsx --forceExit` | **5 tests passed** (defaults-always-listed, upgrade-in-place, BYOK dedupe, cold-hide + wake un-hide, spinner reality)
`npm run typecheck` / `npm run lint` | pass
`npm test -- --silent` (full suite) | **209 suites passed (1 skipped), 2239 tests passed, 2240 total**

Extractions in this pass:
- `electron/preview-logic.ts` — pure decision helpers of the preview/agent browser (verbatim moves; 20 tests pin them). Pinned-as-is quirks: scheme-less localhost input can never reach the inline `http://localhost` branch (dead code in the original) and bare `localhost` becomes a Google search.
- `electron/preview-views.ts` — all view state (view map, console/network rings, agent tab bookkeeping) + all 28 `preview:*`/`agent-browser:*` IPC handlers, registered via `registerPreviewBrowser({ handleAppIpc, getMainWindow })` at the original module scope (registration order unchanged); `preparePreviewPartition()` replaces the inline session call in startup. `electron/main.ts`: **1,942 → 1,016 lines**; keeps window ownership, the origin guard, and the `orplex:` workspace handlers.
- `src/lib/port-conflict.ts` — THE shared `diagnosePortConflict` (see behavior change below); both lanes re-export the same function.
- `src/hooks/useModelCatalog.ts` — the verified-model catalog engine (retry loop, P1 coalescing, StrictMode cancellation, serverless rescue, BYOK merge, wake promotions, recents, curated-defaults merge) moved verbatim out of `ChatInput.tsx` (**1,128 → 606 lines**). ChatInput keeps picker state and the composer; its own `toastRef` stays for paste/attachment errors.
- `src/components/right-panel/{changes-tab,preview-tab,terminal-tab}.tsx` — the three self-contained tabs moved verbatim out of `RightPanel.tsx` (**1,301 → 356 lines**); `mountedBrowserRef` is exported from the preview module because the panel shell reads it while routing tabs.

Deliberate behavior changes (signed off under "do it all"):
1. **Worker lane adopts the serve lane's port-conflict fix** (`src/lib/port-conflict.ts`): bare "permission denied" output no longer produces the wrong "port is taken" hint (it is usually a file-system/npm-cache problem). `listen EACCES` still matches. Pinned by `serve-lane.test.ts` in both lanes + an identity check that the two lanes share ONE implementation.
2. **`validateToolArgs` collision resolved (behavior-free)**: `agent/contract/tools.ts`'s required-arg gate is now `validateRequiredArgs`; the zod validator in `reliability/tool-args.ts` keeps the `validateToolArgs` name. All consumers updated.

New regression tests (this pass):
- `electron/__tests__/preview-logic.test.ts` — address-bar semantics, bounds clamping, find-ref staleness/unknown errors, console line formatting, find filter pipeline, wait clamps.
- `src/lib/agent/contract/__tests__/results.test.ts` — `formatToolResult`/`formatToolError` exact bytes + the lane dialect delta map (client `\n`-wraps bodies; executor omits the trailing newline; error prefix `": "` vs `" - "`). This is the safety net for per-call-site adoption of the shared envelope.
- `src/hooks/__tests__/useModelCatalog.test.tsx` — picker contract via `renderHook` + mocked `apiFetch`.

### Pass 4 evidence (background-worker contract extraction + executor envelope adoption + dispatch surface)

Extractions (all verbatim-cut with marker-asserted scripts, cut in descending line order):
- `src/lib/token-budget.ts` (186 lines) — `CHARS_PER_TOKEN`/`TPM_LIMIT`/`TPM_SAFETY`/`FALLBACK_CONTEXT_TOKENS`/`COMPACTION_TRIGGER_RATIO`/`SYSTEM_PROMPT_TOKENS`/`OUTPUT_RESERVE`, `contextWindowForModel`, `msgBudgetFor`, `SENT_LOG`, `estimateTokens`, `fitMessagesToBudget`, `reserveTokenWindow`, `TOKEN_LIMIT_RE`. The prompt-meter calibration try-block **stayed** in the worker (module-load side effect; timing must not move). Worker re-exports `estimateTokens`/`fitMessagesToBudget` so `token-budget.test.ts` keeps its import path.
- `src/lib/auto-verify.ts` (52 lines) — `VERIFY_COMMAND`, `VERIFY_TIMEOUT_MS`, `MAX_REPAIR_ROUNDS`, `TYPECHECK_ERROR_RE`, `summarizeTypecheckOutput`, `buildVerificationRepairPrompt`. The verification **loop** stays in the worker; the module owns the pure contract.
- `src/lib/orchestration-client.ts` (99 lines) — `ORCHESTRATE_URL`, `runOrchestration`, `executeOrchestratedWrites`. The worker's `_readFile`/`_writeFile` module lets are now passed explicitly as `ctx.fs` at the single call site — same read-at-call-time semantics, no hidden module state.
- `background-worker.ts`: **3,502 → 3,239 lines** across the three extractions. `run-state-isolation.test.ts` (the text-level contract) was verified CLEAN against every extracted region before cutting.

Executor envelope adoption:
- All 14 inline `<tool_result>` templates in `server-executor/executor.ts` migrated to `formatToolResult`/`formatToolError`; zero inline envelopes remain. Deliberate model-visible byte changes (exactly as the parity map predicted): every executor result gained the trailing `\n`; error prefix `"error: "` → shared `"error - "`. `results.test.ts` now carries a **text-level guard**: `executor.ts` must never hand-build a `<tool_result` envelope again.

Dispatch-surface contract (the native-tools split prerequisite):
- `src/lib/agent/__tests__/dispatch-surface.test.ts` — 97 tests. Pins: all 42 roster tools route through `dispatchToolCall` without throwing and name themselves in the envelope; the incomplete-args recognition map stays roster-synced (with the pinned reality that the write family — `write_file`, `write_file_chunk`, `edit_file`, `batch_edit`, `undo_last_change` — gates on the open-folder check BEFORE arg checks, and `apply_edit_ops` routes to the no-folder refusal even with empty args); `spawn_subagent` is the only roster tool falling through to the unknown-tool refusal (server-lane tool, no client branch). `@/lib/api-base` is mocked to throw so any accidental network access fails loudly.

Gates: dispatch-surface 97/97; worker-adjacent suites 82/82 (run-state-isolation, token-budget, auto-verification, orchestration-wiring, live-run hardening ×2, serve-lane); server-executor + contract suites 55/55; full suite **210 suites / 2,337 tests** (baseline 209/2,240 + 97 new); lint + typecheck green.

### Pass 5 evidence (native-tools lane split + settings tabs + send glyph)

- `src/lib/agent/mcp-lane.ts` (260 lines) — the Phase 8 lane gate, the SDK roster snapshot cache, the C6 risk assessment, and the three MCP dispatch branches (`mcp__<server>__<tool>`, `mcp_call`, `mcp_search_tools`/`mcp_describe_tool`) moved verbatim. `tryMcpDispatch` returns null for non-MCP calls so the dispatcher falls through to the built-ins. The lane/roster caches stay module-level state — one instance per bundle, exactly as before.
- `src/lib/agent/browser-lane.ts` (287 lines) — the `browser_*` lane (Electron IPC bridge, server Playwright fallback, screenshot attach) plus `attachScreenshot` moved verbatim; `attachScreenshot` is exported because `take_screenshot` shares it.
- `native-tools.ts`: **2,141 → 1,676 lines**. Routing order is unchanged (MCP checked first, browser before `session_search`); the dispatch-surface contract (97 tests) passed unchanged after the split — that was the point of writing it first.
- `src/components/settings/{warm-models-card,api-keys-tab,cost-tab,reset-recovery-tab}.tsx` — the four self-contained settings components moved verbatim out of `app/settings/page.tsx` (**1,089 → 256 lines**), following the right-panel tab pattern. `WarmModelsCard` is exported (api-keys-tab renders it); `ReliabilityCard` and `tierBadge` stay private.
- `src/components/send-glyph.tsx` (82 lines) — the paper-plane→stop-square morphing SVG icon moved verbatim out of `PromptBar.tsx` (**1,180 → 1,113 lines**) with its path constants and interpolation helpers. `LINE`/`EDGE` stay in the bar (menu geometry uses them).

Gates: agent suites 146/146; full suite **210 suites / 2,337 tests** after every extraction; lint + typecheck green. Commits: `2f74d2b`, `c8d8474`, `6d5d99e`, `e67d7a7`.

## 9. Remaining oversized files — why they stay intact for now

- `src/lib/background-worker.ts` (3,239 after this pass's three extractions) — the most-tested file in the repo; several suites are **source-level regression tests that read its raw text** (e.g. `run-state-isolation.test.ts`). Decomposition requires reading those as contracts first; target design is already in the audit (run-state / verification / gates / finalize). The pure-contract blocks (token budget, auto-verify, orchestration client) are now extracted; the bulk is the `runInBackground` closure itself — deep-refactor territory.
- `src/lib/server-executor/executor.ts` (2,727) — the ~700-line `executeTool` mirrors ≥24 client-lane tools. The shared `formatToolResult`/`formatToolError` envelope is now adopted across all 14 result sites (text-level guard forbids regression); per-tool extraction can proceed against `dispatch-surface.test.ts` + the parity map. Its `executeRun` has no direct unit test today.
- `src/lib/agent/native-tools.ts` (now 1,676) — the 42-branch dispatcher after the MCP + browser lane extraction. The split-safety contract (`dispatch-surface.test.ts`, 97 tests) proved every roster tool still routes. Remaining branches are file ops, exec, and chat-meta tools — each extractable the same way (capability module + null fall-through) now that the contract exists.
- `src/lib/skills.ts` (1,132) — a pure data catalog (SKILL_CATEGORIES) + three tiny functions. Splitting a static dataset adds indirection without a cohesion gain; left intact deliberately.
- `src/hooks/useChatSession.ts` (1,043) — one hook whose ~30 refs interlock (queue, stall watchdog, retry, reload recovery). Same deep-refactor class as the worker's `runInBackground` closure; needs a behavioral test harness before any cut.
- `electron/main.ts` (now 1,016) — preview/agent-browser extracted; the remainder is lifecycle/window/port logic that is deliberately cohesive.
- UI hotspots — `RightPanel` (356) and `ChatInput` (606) are done for this pass; `settings/page.tsx` (1,089) and `PromptBar.tsx` (1,180) remain mapped in the audit.

## 10. Unresolved problems

1. ~~`diagnosePortConflict` divergence~~ **RESOLVED** — `src/lib/port-conflict.ts` is the single implementation; the worker lane adopted the serve lane's fix (deliberate behavior change, pinned by tests).
2. ~~`validateToolArgs` name collision~~ **RESOLVED** — contract lane renamed to `validateRequiredArgs` (behavior-free).
3. ~~`formatToolResult` pinned but unused~~ **ADOPTED in the server lane** — all 14 inline `<tool_result>` templates in `server-executor/executor.ts` now call `formatToolResult`/`formatToolError`, and a text-level guard in `results.test.ts` forbids reintroducing inline templates there. Two deliberate model-visible byte changes came with it: every executor tool result gained the shared trailing `\n`, and the error prefix moved from `"error: "` to the shared `"error - "` dialect. The client lane (`native-tools.ts`, ~141 occurrences, itself internally mixed) remains per-call-site work for a later pass.
4. No direct tests: `executor.executeRun`, `main.ts` lifecycle, `api/chat` HTTP surface (policy layer now tested; the route's request plumbing still isn't), `api/agent/exec`. Test-first plan required before their extraction (order specified in the audit's migration list).
5. Dep-cruiser (or equivalent) automated circular/forbidden-import check is not yet configured; boundary rules are currently enforced by `eslint`, `tsc`, code review and `npm run audit`.
6. Stale documentation: "41 tools" references elsewhere in the repo should be reconciled to the real 42.
7. Observed quirk pinned as-is: `showBlockingSpinner` in `useModelCatalog` can never be true (`models.length === 0` is unreachable because the curated defaults are permanent). Fixing it would be a product decision, not a refactor.
