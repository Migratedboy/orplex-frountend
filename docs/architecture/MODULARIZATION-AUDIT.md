# MODULARIZATION-AUDIT.md — Operation Modularity, initial assessment

Date: 2026-11-04. Scope measured across `src/`, `electron/`, `scripts/`, `cli/src/`, `vscode-extension/src/`, `docs-site/docs/`, `evals/`.

**Method.** Line/function/import inventory by script; responsibility mapping by reading the largest files and running focused module-ownership research. No source files were modified while producing this audit.

**Baseline at audit time (all verified by execution in this session):**
- `npm run lint` — pass
- `npm run typecheck` (`tsc --noEmit` app + electron) — pass
- `npm test` (jest) — **201 suites passed, 1 skipped, 2160 tests passed, 2161 total**
- Tool registry count check — see §2 (42 tools, not 41)

---

## 1. Global condition

766 measured source files, ~130,505 lines.

| Size bucket | Files |
|---|---|
| 200–400 lines | 130 |
| 400–700 lines | 36 |
| 700–1,000 lines | 9 |
| >1,000 lines | 11 |

The >1,000-line files (all in `src/` except `electron/main.ts`):

| File | Lines | Exports |
|---|---|---|
| `src/lib/background-worker.ts` | 3,502 | 14 |
| `src/lib/server-executor/executor.ts` | 2,727 | 7 |
| `src/lib/agent/native-tools.ts` | 2,141 | 4 |
| `electron/main.ts` | 1,962 | 51 |
| `src/components/RightPanel.tsx` | 1,301 | 30 |
| `src/lib/model-catalog.ts` | 1,202 | 40 |
| `src/components/PromptBar.tsx` | 1,180 | 32 |
| `src/lib/skills.ts` | 1,132 | 2 |
| `src/components/ChatInput.tsx` | 1,128 | 37 |
| `src/app/settings/page.tsx` | 1,089 | 25 |
| `src/hooks/useChatSession.ts` | 1,043 | 10 |

---

## 2. Tool registry reconciliation (Mission 5)

- Canonical registry: `M3_TOOL_DEFINITIONS` — `src/lib/tool-definitions.ts:7` (first entry `read_file` at line 11, last `spawn_subagent` at line 658). **Actual count: 42 tools**, not 41 as instructed. The 42nd is `extract_archive` (added since the 41-tool count was documented). **Decision: 42 is the source of truth; documentation elsewhere saying "41" is stale and should be corrected where the count matters.** No tool was removed or invented.
- Roster derivation into the system prompt: `buildToolRoster(names?)` — `src/lib/master-prompt.ts:108-132`, categorized by the regex table at `master-prompt.ts:110-119`. The server lane feeds its real roster via `buildSystemPrompt({ toolNames })` (`executor.ts:1856`), the client lane advertises the full belt.
- Provider conversion: client lane dispatch `dispatchToolCall` (`src/lib/agent/native-tools.ts:305-2138`, 42 branches); server lane native defs `buildNativeToolDefs` (`executor.ts:247-317`) + text-protocol gate `TOOL_WHITELIST` (`executor.ts:95-138`).
- Dispatch → prompt → schema → validation → permission → execution chain is intact and covered by tests (`src/lib/__tests__/agent-browser-advanced-ops.test.ts`, `src/lib/agent/__tests__/contract/__tests__/contract.test.ts`, `src/lib/master-prompt.test.ts`).

---

## 3. File-by-file decomposition assessment

Priority order below = suggested migration order (impact first, gated by test coverage).

### P1 — `electron/main.ts` (1,962 lines) — Electron entry point

Responsibilities (mapped to real symbol names and line ranges):

| # | Concern | Lines | Symbols | Extractable / reuse |
|---|---|---|---|---|
| 1 | env + packaged config loading | 30–75 | `loadElectronEnv`, `loadAppConfig` | yes (pure fs) |
| 2 | IPC origin gate | 105–117 | `handleAppIpc` | yes (`IpcGate` pattern already lives in `terminal.ts`) |
| 3 | navigation/origin guards | 144–174 | `isAppOrigin`, `isLegalPageUrl` | yes (pure) |
| 4 | conversations IPC shims | 188-190, 952–997 | `registerConversationIpc` | yes; store already separate |
| 5 | crash-recovery session file | 202–227 | `readLastSessionState`/`writeSessionState` | yes (pure fs; internally still uses re-`require("node:fs")` vestiges) |
| 6 | single-instance + taskbar identity | 229–279 | `gotTheLock`, AUMID, Lnk poison sweep, `second-instance` | yes |
| 7 | **preview + agent-browser state and views** | 281–538, 999–1746 | `previewViews`, `agentTabs`, `createPreviewView`, `getAgentView`, ~30 IPC handlers | **~50% of the file; the single largest extraction win** |
| 8 | Next.js child-process management | 541–697 | `startNextServer`, `wireChild` | yes → `next-server.ts` |
| 9 | readiness probing | 550–591 | `waitForServer`, `probeServer` | near-duplicate of `terminal.ts isPortOpen` (TCP vs HTTP) |
| 10 | icon resolution | 703–734 | `resolveIconPath` | near-duplicate of `tray.ts iconPath` (different candidate lists — deliberate, not identical) |
| 11 | window creation + security guards | 736–909 | `createWindow` | yes |
| 12 | menu | 911–950 | `buildMenu` | trivial |
| 13 | child-process kill (will-quit vs shutdown) | 1785–1806, 1938–1961 | verbatim-twin loops | **verified duplication — first extraction candidate** |
| 14 | port takeover | 1758–1783 | `killPortListener` | yes |
| 15 | startup wiring | 1816–1962 | `app.whenReady()` sequence | stays as composition layer |

Duplication findings verified:
- `main.ts:1944–1954` (shutdownMain) duplicates `main.ts:1795–1804` (will-quit) verbatim — safe to consolidate.
- Unused import: `node:net` (`main.ts:17`) — dead code.
- `readLastSessionState`/`writeSessionState` re-`require("node:fs")`/`node:path` inside the functions although both are already top-level imports (lines 23–24).

Startup ordering (must be preserved exactly): env → app-config → single-instance lock + AUMID + poison sweep → IPC registration (conversations/preview/agent before ready, 960–1746) → ready: AUMID re-assert (1820), `registerDesktopAuth` (1827), `registerMcpIpc` (1837), `registerTerminalIpc` (1843), inline IPC 1846/1854/1861, port takeover (1870–1878), `startNextServer("ui")` (1880), `startNextServer("api")` only if no cloud API (1881), `waitForServer` ×2 (1882–1887), dev warm-up (1892–1894), permission handler reset (1898), `createWindow` (1908), tray (1913), updater (1923). Shutdown order: flush conversations → session mark → killAllTerminalChildren → kill Next children.

Risk: **medium-high** (lifecycle ordering, platform branches). Extraction must be service-module sized, one concern at a time, with the composition layer staying in `main.ts`.

### P2 — `src/lib/background-worker.ts` (3,502 lines) — client chat lane orchestrator

| Lines | Responsibility | Symbols |
|---|---|---|
| 124–294 | token budget + TPM pacing | `estimateTokens`, `fitMessagesToBudget`, `reserveTokenWindow` |
| 303–604 | model-call wrapper: compaction, metering, cache, retries | `createRunState`, `callModel` |
| 606–760 | auto-verification utilities + serve helpers | `runOrchestration`, `summarizeTypecheckOutput`, `isServerCommand`, `diagnosePortConflict` |
| 763–863 | question polling, fs access, workspace context | `waitForAnswer`, `setFileSystemAccess`, `buildContext` |
| 864–1993 | run entry, gates, doctrine injection, turn loop | `runInBackground` |
| 1994–2399 | tool gating chain + dispatch | spawn gate … `dispatchToolCall` |
| 2400–3200 | verification lanes (typecheck, gates, browser, swarm) | |
| 3200–3501 | finalize: rubric, acceptance, ledger | `postRunToLedger` |

Coupling observations (verified imports): depends on nearly everything (background-chat, loop-engine, effort, stream-reader, tool-text, loop-detect surfacing, master-prompt, native-tools, agent/subagent).

Duplication hotspots verified against the server lane:
- **`diagnosePortConflict` and `isServerCommand` exist twice and have DIVERGED:** `background-worker.ts:740-761` matches `permission denied` (and `port is already`) while `agent/serve-helpers.ts:16-30` deliberately does not — the serve-helpers copy documents that "permission denied" alone caused wrong hints; the worker copy predates that fix. Both are used at runtime in different lanes (`background-chat`-lane vs `native-tools.ts:1272,1349,1400`). Unifying is a **behavior decision, not a refactor** — needs a deliberate owner sign-off. Flagged, not changed.
- Serve helpers tri-duplicated with native-tools import; sealed by `src/lib/__tests__/serve-lane.test.ts`.
- Two validators share the name `validateToolArgs`: `reliability/tool-args.ts` (worker:78,2222) vs `agent/contract/tools.ts` (executor:26) — same name, different semantics. Rename or merge (behavior decision).
- A canonical `formatToolResult`/`formatToolError` exists (`agent/contract/results.ts:20,33`) but **neither lane uses it** — both lanes inline the same XML template. Candidate for adoption once output parity is proven by snapshot test.

Risk: **high** — the most-tested-against file in the repo (13+ suites reference it, including source-level regression tests like `run-state-isolation.test.ts` that read its raw text). Extraction must not break those text-level tests; check them before any move.

Suggested decomposition (target only, not executed yet): `worker/run-state.ts` (budget/pacing/callModel), `worker/verification.ts` (lanes), `worker/gates.ts` (tool gating chain), `worker/finalize.ts` (rubric/ledger). Keep `runInBackground` as the orchestrator wiring.

### P3 — `src/lib/server-executor/executor.ts` (2,727 lines) — server worktree lane

| Lines | Responsibility | Symbols |
|---|---|---|
| 81–246 | constants, run types, transcript budget, known context windows | `resolveTranscriptBudget`, `trimTranscriptToBudget` |
| 247–380 | native tool defs + lane addendum | `buildNativeToolDefs`, `buildWorktreeAddendum` |
| 382–601 | lease/events/truncation + local file ops | `leaseOneRun`, `emit`, `readLocalFile*` |
| 602–1315 | **own ~700-line tool dispatcher duplicating ≥24 client tools** | `executeTool` |
| 1317–1364 | worktree path guard + DB approvals | `worktreePath`, `requestUserApproval` |
| 1368–2494 | run loop: BYOK, compaction, hooks, lanes | `executeRun` |
| 2496–2726 | poll loop, status, insights | `startServerExecutor`, `recordRunInsights` |

The duplicated dispatcher is the single largest containment violation in the repo (each bug must be fixed twice — v1.0.28 fixed 24 of them in one pass). Long-term fix = one shared dispatcher core with lane adapters; short-term safe step = extract `executeTool`-bound pure helpers (result formatting, worktreePath) with contract tests. Risk: **high** (no direct unit test for `executeRun`; coverage is via `buildNativeToolDefs` and worktree isolation tests).

### P4 — `src/lib/agent/native-tools.ts` (2,141 lines)

Single 42-branch sequential `dispatchToolCall` if-chain (305–2138). It is the only client-lane dispatcher; splitting it risks breaking tool coverage. Options (behavior-preserving): group by capability into handler modules selected by name, with the same `ToolContext`. Only behind full dispatch tests. Risk: **high**.

### P5 — API routes with inlined business logic

| Route | Lines | Inlined responsibilities that belong in a service |
|---|---|---|
| `api/chat/route.ts` | 465 | provider attempt loop, lean-retry policy, permanent-vs-transient failure classifier, tool-lane selection; helpers `bareModelId`/`loadContextWindows` (31–62) |
| `api/agent/ledger/route.ts` | 276 | dual-shape payload normalization + Prisma transaction (92–253) — clean service candidate with an existing route test as regression net (`__tests__/route.test.ts`, 269 lines) |
| `api/agent/serve/route.ts` | 275 | `detectPort`/`waitUntilListening`/`treeKill` (47–101, pure + platform), serve registry, secret-strip env list kept in sync by hand with `exec-guard.buildSafeEnv` (distribution line-up documented in both files) |
| `api/agent/exec/route.ts` | 207 | three execution lanes duplicating screening/timeout/truncation rules |

Risk: **medium-low**. Auth + response contracts are thin; service extraction is the natural next step and route-level tests exist for ledger, auth-desktop, runs-events, conversations, files, models-available.

### P6 — UI hotspots (do NOT split merely by size)

| Component | Lines | Verdict |
|---|---|---|
| `RightPanel.tsx` | 1,301 | **Extract tab components** (`ChangesTab`, `BrowserPreviewInner` ~500 lines, `TerminalTab`) — each is already self-contained with its own polling/effects; `BrowserPreviewInner` has 9 effects + IPC plumbing and is the risk core. No direct component tests — snapshot the props contract first. |
| `PromptBar.tsx` | 1,180 | Spark canvas particle system (542–642) is an isolated presentational unit; extract `SparkCanvas` with a component test. Picker logic already extracted (`PromptBarModel`). |
| `ChatInput.tsx` | 1,128 | Model-catalog engine (193–664: polling/retry windows/coalescing/toast-once) is a testable hook candidate (`useModelCatalog`) — behavior lives in business rules, not JSX. |
| `settings/page.tsx` | 1,021 | `WarmModelsCard`, `SettingsApiKeyTab`, `SettingsCostTab`, `ResetRecoveryTab` are Sinatra-style tabs — extract file-per-tab; N+1 `cancelStuckRuns` (788–810) is a behavioral smell to report, not silently fix. |
| `useChatSession.ts` | 1,043 | Hook with session orchestration; defer until component layer is thinner. |
| `AgentManager.tsx`, `ConnectorsPanel.tsx` | 604/753 | Manageable; document responsibilities only. |

---

## 4. Existing modules to reuse (do not duplicate)

- `electron/terminal.ts` (`IpcGate`, command screen), `electron/conversations-store.ts`, `electron/updater.ts`, `electron/loopback.ts`, `electron/dev-mode.ts` — main.ts must compose these, not re-implement.
- `src/lib/agent/contract/*` — shared pure-logic layer both lanes import (`agent/contract/index.ts` header names both lanes). `formatToolResult` lives here unused; `validateToolArgs` semantics diverge between `contract/tools` and `reliability/tool-args`.
- `src/lib/compaction.ts` — the ONE hierarchical compactor both lanes already share.
- `src/lib/effort.ts`, `src/lib/loop-detect.ts`, `src/lib/tool-text.ts` — leaf pure libs, no changes needed.
- `src/lib/web-search.ts` — v1.0.28 already collapsed the two search chains into one.

---

## 5. Risk register / migration order

1. **Electron verbatim-twin kill loop + dead `net` import** (P1.13) — trivial, do first.
2. **Ledger route service extraction** (P5) — service module + existing route test.
3. **chat route helpers → provider-failure policy module** (P5) — only with the route test gap closed first (no direct test today; cover with focused tests on the policy module).
4. **LeftPanel/UI tabs extraction** (P6) — component-per-file, add contract tests first.
5. **background-worker decomposition** (P2) — only after the source-level regression tests (`run-state-isolation.test.ts`) are understood as contracts; prefer moving whole responsibilities behind unchanged exports.
6. **dispatcher unification client/server** (P3/P4) — the real goal, but only after (a) `formatToolResult` adoption proven by snapshot parity, (b) `validateToolArgs` naming collision resolved, (c) `diagnosePortConflict` divergence owned by a decision. Never refactor both lanes at once.

Items deliberately NOT touched in the audit phase: none removed, no behavior changed. Two behavior-decision flags are handed to the owner: `diagnosePortConflict` divergence and the `validateToolArgs` name collision.
