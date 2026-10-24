/**
 * Per-run state must not be shared between runs.
 *
 * anchorTaskMessage / taskCompactor / lastCompactedThrough / taskMemoriesUsed
 * were module-level `let`s, written when a run started and read inside
 * callModel with network awaits in between. With queue concurrency of 3 (and
 * detached lanes running in parallel) two overlapping runs reached into each
 * other's state:
 *
 *  - the task anchor, so run A's prompt gained run B's sentence labelled
 *    "ORIGINAL TASK - never ask for clarification about it"
 *  - ONE compactor instance holding {coveredCount, summary, fingerprint}, so B's
 *    reset() landing during A's summarizer request let B fold its tail onto A's
 *    summary - B's model context literally containing A's compressed history
 *
 * These assertions pin the source shape, since the behaviour itself is only
 * observable under a real concurrent overlap.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "..", "background-worker.ts"), "utf8");

describe("per-run state isolation", () => {
  it("declares no module-level per-run state", () => {
    for (const name of [
      "anchorTaskMessage",
      "taskCompactor",
      "lastCompactedThrough",
      "taskMemoriesUsed",
    ]) {
      const asModuleLevel = new RegExp(`^let\\s+${name}\\b`, "m");
      expect(SRC).not.toMatch(asModuleLevel);
    }
  });

  it("threads runState into every callModel invocation", () => {
    // Declarations, doc comments and call sites all mention callModel, so pin
    // the invariant rather than a brittle count: every invocation passes
    // runState as its second argument, so the two tallies line up.
    const calls = (SRC.match(/callModel\(/g) || []).length;
    const withRunState = (SRC.match(/runState,/g) || []).length;
    // `callModel(` also matches the declaration, so calls = 1 + invocations.
    // Each invocation passes runState as its second argument.
    // Transform 2a: the subagent mini-loop's call is an 7th invocation, and it
    // threads runState too (per-run state isolation applies to subagents).
    expect(calls).toBe(8); // declaration + 7 invocations
    expect(withRunState).toBe(calls - 1);
  });

  it("creates a fresh RunState per run rather than resetting shared state", () => {
    expect(SRC).toMatch(/const runState = createRunState\(userMessage\)/);
    // The old reset-the-shared-instance pattern must be gone.
    expect(SRC).not.toMatch(/taskCompactor\?\.reset\(\)/);
  });

  it("reads and writes compaction state through runState", () => {
    expect(SRC).toMatch(/appendTaskAnchor\(apiMessages, runState\.anchorTaskMessage\)/);
    // 4c: the compactor is now hierarchical (trim/drop tiers first, summarize
    // last) — the per-run instance lives on runState exactly as before.
    expect(SRC).toMatch(/runState\.taskCompactor \|\|= createHierarchicalCompactor\(/);
    expect(SRC).toMatch(/await runState\.taskCompactor\.compact\(/);
    expect(SRC).toMatch(/evictedNow > runState\.lastCompactedThrough/);
  });

  it("runs the subagent mini-loop on a DERIVED child state, not the parent's", () => {
    // Sharing the parent's runState put the parent's ORIGINAL TASK anchor on
    // every subagent tool-result, and let the sub's incremental compactor
    // overwrite lastCompactionSummary/lastCompactedThrough with sub content
    // that then seeded the PARENT's scratchpad. The dispatch site must
    // capture the parent state and shadow it with a child: the sub's task as
    // anchor, a lazily-created compactor of its own, and fresh eviction marks.
    expect(SRC).toMatch(/const parentRunState = runState;/);
    expect(SRC).toMatch(/const runState = \{ \.\.\.parentRunState \};/);
    expect(SRC).toMatch(/runState\.taskCompactor = null;/);
    expect(SRC).toMatch(/runState\.lastCompactedThrough = 0;/);
    expect(SRC).toMatch(/runState\.lastCompactionSummary = null;/);
  });

  it("enforces the effort budget's subagentLimit at the spawn dispatch site", () => {
    // The trivial tier promises 0 subagents — limit was never checked.
    expect(SRC).toMatch(/subagentsSpawned >= effortBudget\.subagentLimit/);
    expect(SRC).toContain("Refused: subagent budget exhausted");
  });

  it("keeps the loop-guard denylist and wall-clock budget sticky across streak resets", () => {
    // Resetting with a bare Object.assign(loopStreaks, createLoopStreaks())
    // wiped callFailureCounts (loop-detect: the denylist is sticky for the
    // run) and restarted budget.startedAt (the wall-clock origin).
    expect(SRC).not.toMatch(/Object\.assign\(loopStreaks, createLoopStreaks\(\)\)/);
    expect(SRC).toMatch(/fresh\.callFailureCounts = loopStreaks\.callFailureCounts;/);
    expect(SRC).toMatch(/fresh\.budget = loopStreaks\.budget;/);
    expect(SRC).toMatch(/const resetLoopStreaks = \(\) => \{/);
  });
});
