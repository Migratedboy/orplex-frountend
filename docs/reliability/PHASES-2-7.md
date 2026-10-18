# Phases 2–7 — Reliability Hardening (complete)

**Status:** Phases 0–7 complete. Phase 8 (eval harness) shipped in Phase 0.
**Gate:** tsc clean · eslint 0 problems · **1970 tests pass** (+659 from pre-plan).
**Eval:** capability **1/18 → 26/30**, unverified checks **10 → 2**, `test_tamper_passed` **1 → 0**. Deterministic across 2 runs.

## Baseline movement

| Metric | Pre-plan | Now |
|---|---|---|
| capability_present | 1 / 18 | **26 / 30** |
| trap_tasks detected | 0 / 6 | **4 / 6** |
| test_tamper_passed | 1 (bad) | **0** |
| unverified_checks | 10 | **2** |

The 4 remaining capabilities are real, tracked gaps: `shadow-worktree-browser-lane`, `diff-coverage-gate`, `import-resolver`, `add-dependency-tool`.

## What shipped

| Phase | Modules | Capability gained |
|---|---|---|
| **2** test integrity | `protected-paths.ts`, `tamper-detector.ts` (11 signals), `flake-control.ts`, `acceptance.ts` | tamper detector, protected-path policy, acceptance spec, flake control |
| **3** edit ops | `edit-ops.ts` (zod `EditOp`), `atomic-batch.ts`, `hash.ts`, `path-jail.ts`, `tool-args.ts`, `zod-errors.ts` | structured edits, atomic rollback, path jail, arg validation |
| **4** untrusted content | `provenance.ts` (TaintStore), `injection-scanner.ts`, `egress-policy.ts`, `scrubber.ts`, `capability-policy.ts` | taint policy, injection scanner, output scrubber, egress policy, capability policy |
| **5** loop guard | `progress-hash.ts` + additive extensions to `loop-detect.ts` | oscillation (R3), no-progress (R5), hard denylist rung, budget |
| **6** memory | `failure-ledger.ts`, `flake-registry.ts`, `compaction-state.ts`, new `/api/agent/ledger` route, `run-ledger.ts` fix, pinned-eviction fix | durable ledger, cross-restart failure learning |
| **7** roles/review | `verification-report.ts`, `acceptance-gate.ts`, `reviewers.ts`, `risk-tiering.ts`, `roles.ts` | verification report, reviewer panel, risk tiering, role stack |

### The three fixes that were live bugs, not new features

1. **Protected-path inversion** (`risk-classifier.ts`): `test/`, `tests/`, `__tests__/` were in `SAFE_WRITE_PREFIXES` — *deleting every test in a repo was low risk and auto-approved*. Now high-risk and approval-gated.
2. **Ledger endpoint** (`run-ledger.ts`): posted to `/api/agent/history` — the file-undo route — so cross-restart failure learning had **never** worked and `task_runs`/`task_failures` had zero writers. New `/api/agent/ledger` route fixes it.
3. **Injection evasion** (`injection-scanner.ts`): a zero-width space (`<\u200btool_call>`) split the tag name and slipped past the literal regex — the classic evasion against a scanner guarding a tag-parsing loop. Now tolerates zero-width/invisible chars and matches closing tags.

## Integration pass (what actually runs)

All of the above is wired into `background-worker.ts` (Lane A), each behind a flag defaulting OFF:

- **Output scrub** at the single choke point where tool output enters context (`outcome.resultXml`) — the audit found `read_file` returned `.env` verbatim and `client-signatures.ts:119` *boosted* it.
- **Injection scan + taint** on the same path.
- **Tool-arg validation** at dispatch (the client lane validated nothing before).
- **Loop guard** — hard denylist + oscillation + wall-clock, before dispatch.
- **Verification report** appended before final content is derived.

## Flags (all default OFF, all require `RELIABILITY_GATES=1`)

`RELIABILITY_EDIT_LOCK` · `RELIABILITY_TEST_LANE` · `RELIABILITY_TAMPER_DETECT` · `RELIABILITY_FLAKE_CONTROL` · `RELIABILITY_ACCEPTANCE` · `RELIABILITY_EDIT_OPS` · `RELIABILITY_PATH_JAIL` · `RELIABILITY_PROVENANCE` · `RELIABILITY_INJECTION_SCAN` · `RELIABILITY_SCRUB` · `RELIABILITY_CAPABILITY_POLICY` · `RELIABILITY_LOOP_GUARD` · `RELIABILITY_DURABLE_MEMORY` · `RELIABILITY_REPORT` · `RELIABILITY_ROLES_REVIEW`

## Known gaps (not built, tracked)

- **Shadow worktree for the browser lane** — server lane has one, browser lane writes live.
- **Diff coverage gate** — `jest.config.js` still has no `coverageThreshold`; CI runs `--coverage` and asserts nothing.
- **Import resolver / `add_dependency`** — `hallucinated-import` trap still undetected; an unresolvable specifier is written unchecked.
- **Lane B (server executor) parity** — deviation D-1, deferred by design.

## Note on the eval harness loader

`evals/reliability/lib/load-ts.mjs` was rewritten to use a `require.extensions['.ts']` hook instead of transpiling one file to a flat temp dir. Phase 2 gave `risk-classifier.ts` real relative imports; the old loader failed to resolve them, which would have been misread as "capability missing". The hook resolves and transpiles relative TS imports recursively and maps the `@/` alias.