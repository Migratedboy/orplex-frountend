# Phase 1 — Tiered gate pipeline + baseline diagnostics + edit lock

**Status:** complete. Ships behind `RELIABILITY_GATES=1` (default OFF — existing behaviour byte-for-byte unchanged).
**Gate:** tsc clean · eslint 0 problems · 1511 tests pass (+26 new).
**Capability delta:** 1/18 → 4/18 (`tiered-gate-pipeline`, `baseline-diagnostics`, `edit-lock`).

## What this phase fixes

The plan's central finding, confirmed by the Phase 0 audit: *"the pipeline detects, reports, annotates, and remembers. It does not gate."* Every verification lane appended display text and then called `completeTask` regardless. `computeVerdict` in `rubric-recorder.ts` already modelled a correct hard gate but was unreachable (behind `TEST_MODE=1`) and had no `test` lane in its union.

Phase 1 supplies the missing enforcement layer: a pipeline that can **refuse**.

## New modules

| Module | Purpose |
|---|---|
| `src/lib/reliability/flags.ts` | Single source of truth for every `RELIABILITY_*` flag. Sub-flags are inert unless the master switch is on. |
| `src/lib/reliability/types.ts` | Shared `LaneName`/`LaneResult`/`WorkspaceBaseline`/`GateExec` types. |
| `src/lib/reliability/gates.ts` | Tiered pipeline, baseline capture + error-set diff, verdict, summary formatter. |
| `src/lib/reliability/edit-lock.ts` | Per-task lock that refuses mutations while a gate is red. |
| `src/lib/__tests__/reliability.test.ts` | 26 tests: flag inertness, lock lifecycle, signature stability, scripted-sequence verdicts. |

## Design decisions

**Baseline diffing, not blanket blocking.** A pre-existing typecheck failure is not the agent's fault. `captureBaseline` snapshots the workspace's error signatures before the first write; `runGatePipeline` diffs post-task errors against it and only **new** signatures block. An error that merely moved lines (because the agent inserted a line above it) is the *same* error — `tscErrorSignature` drops line/column deliberately so it is not counted as a regression.

**Lanes always all run.** A single red lane does not tell the repair loop about the others. Collecting all of them costs one repair round instead of three.

**`skipped` is never `pass`.** A lane whose exec route returned no exit code records `skipped`, mirroring the careful semantics already at `background-worker.ts:1944`. This is what keeps an unreachable verifier from erasing failure memory and persisting a lie.

**The repair machinery is reused, not duplicated.** The gate pipeline populates the existing loop's `findings` variable; the repair-turn call, round logic, and break conditions are untouched. This keeps the flag-OFF path identical and avoids a second copy of ~40 lines of repair-write tracking.

**`run_command` is deliberately NOT edit-locked.** It is the lane the repair loop uses to clear the gate. Locking it would wedge the task permanently.

**Locks do not survive a task.** `releaseEditLock` runs on success, failure, and abort. A red close must not punish the next task — the lock's job is to refuse writes *within* a task while a gate is red.

## Flags (all default OFF)

| Flag | Effect |
|---|---|
| `RELIABILITY_GATES=1` | Master switch. Enables the pipeline + baseline. |
| `RELIABILITY_EDIT_LOCK=1` | Refuse writes while a lane is red. Requires the master switch. |
| `RELIABILITY_TEST_LANE=1` | Add the jest lane. Requires the master switch (it is the slowest tier). |
| `RELIABILITY_BLOCK_BASELINE=1` | Treat pre-existing failures as blocking too. Off by default. |

## Deviations applied this phase

- **D-2 (amended by you):** no new Prisma migration flow. New tables (when Phase 6 needs them) go into the existing `schema.prisma` and are pushed with the same `npx -y prisma@5.22.0 db push` against your Supabase `DATABASE_URL`. No new tooling.
- **D-7:** `test` and `lint` added as lane members. `Lanes` is now `Record<"typecheck"|"lint"|"test"|"browser"|"swarm", LaneOutcome>`. Existing 3-key call sites still typecheck.
- **D-8:** flake control is **not** in this phase — it needs a test lane to attach to and a test baseline to compare against. Sequenced for Phase 2 alongside the test-lane work.

## Not in this phase (deferred)

- Flake control / rerun-on-failure (D-8 — needs the test baseline)
- Shadow worktree for the browser lane
- Content-hash caching / related-test selection for gate speed
- Making the verdict block `completeTask` unconditionally (today it engages the edit lock and reports; the final status still reads `done` — see *Open question* below)

## Open question for you

When the gate is red after every repair round, Phase 1 engages the edit lock and prints an explicit refusal, but the task still closes with status `done` and a red verification block in the transcript. Two options:

1. **Keep as-is** — the user sees a red gate + edit lock and decides.
2. **Stamp the task failed** — a red gate closes as `[FAILED]` so Retry is offered and the ledger records `FAIL`.

Option 2 is a behaviour change under the flag and matches `computeVerdict`'s semantics. Confirm which you want before Phase 2.

## Verification

```
tsc --noEmit              clean
eslint .                  0 problems
jest --forceExit          1511 passed, 1 skipped
npm run eval:reliability  capability 4/18, deterministic across 2 runs
```
