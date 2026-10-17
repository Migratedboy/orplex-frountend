# Phase 0 — Audit + Eval Harness + Baseline

**Status:** complete. No feature code written. Awaiting deviation approval (see `AUDIT.md` §3) before Phase 1.

## What shipped

| Item | Path |
|---|---|
| Capability probes + trap replay harness | `evals/reliability/run.mjs` |
| Trap fixtures (6) | `evals/reliability/fixtures/*` |
| Detector/signature table + task defs | `evals/reliability/lib/tasks.mjs` |
| TS transpiler for dependency-free modules | `evals/reliability/lib/load-ts.mjs` |
| Committed baseline (2 runs, deterministic) | `evals/reliability/baseline.json` |
| Full capability map + Plan Deviations | `docs/reliability/AUDIT.md` |
| npm script | `npm run eval:reliability` |

## Gate result

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint .` | 0 problems |
| `jest --forceExit` | 1485 passed, 1 skipped |

## Baseline (committed, deterministic across 2 runs)

```
capability_present           1 / 18
trap_tasks                   6
test_tamper_passed           1   (target 0)
injection_actions_executed   0   (target 0)
unverified_checks            10  (target 0)
```

All 6 traps have at least one undetected check. `capability_present: 1/18` is the harness itself (`eval-harness`).

## What the audit found (summary — full detail in AUDIT.md)

1. **The plan's core claim holds:** every verification lane appends display text and continues. `computeVerdict` (`rubric-recorder.ts:274`) is a correct hard gate but unreachable — gated behind `TEST_MODE=1`. There is no edit lock, no flake control, no test lane.
2. **Two independent loops, not one.** Lane A (`background-worker.ts:772`, client) and Lane B (`server-executor/executor.ts:1009`, gated off by default). Plan hooks go into Lane A.
3. **Test paths are inverted.** `risk-classifier.ts:73` lists `test/`, `tests/`, `__tests__/` as `SAFE_WRITE_PREFIXES` → auto-approved. Deleting tests is *low risk*.
4. **`master-prompt.ts:179` promises atomic `batch_edit`.** It is not atomic.
5. **No Zod on tool args** on the client dispatcher; `EditOp` union does not exist.
6. **Cross-restart failure learning has never worked** — `run-ledger.ts:74` posts a ledger payload to a file-undo endpoint that 400s. `task_runs`/`task_failures` tables are dead schema.
7. **No taint/provenance anywhere.** An injected `curl|sh` is stopped today only by the generic denylist + unconditional `run_command` approval — the harness records this distinction explicitly.

## Stopping for approval

Per master-prompt rule 2, **Phase 1 does not start** until deviations **D-1 … D-11** (`AUDIT.md` §3) are approved. Key ones:

- **D-1:** hook Lane A only; Lane B parity deferred.
- **D-2:** use a **Prisma** migration, not Supabase-specific DDL.
- **D-3:** add `EditOp` as new tools behind `RELIABILITY_EDIT_OPS`; do not remove existing write tools.
- **D-6:** enable and extend the existing `rubric-recorder.ts` verdict rather than building a parallel report.
- **D-7/D-8:** add a `test` lane member first; flake control sequenced after it within Phase 1.

Also requested: whether the 10 high-severity findings outside plan scope (`AUDIT.md` §5) are fixed here or separately, and whether the stale `db:local` script (D-9) is removed.
