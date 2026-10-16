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
    expect(calls).toBe(7); // declaration + 6 invocations
    expect(withRunState).toBe(calls - 1);
  });

  it("creates a fresh RunState per run rather than resetting shared state", () => {
    expect(SRC).toMatch(/const runState = createRunState\(userMessage\)/);
    // The old reset-the-shared-instance pattern must be gone.
    expect(SRC).not.toMatch(/taskCompactor\?\.reset\(\)/);
  });

  it("reads and writes compaction state through runState", () => {
    expect(SRC).toMatch(/appendTaskAnchor\(apiMessages, runState\.anchorTaskMessage\)/);
    expect(SRC).toMatch(/runState\.taskCompactor \|\|= createTranscriptCompactor\(/);
    expect(SRC).toMatch(/await runState\.taskCompactor\.compact\(/);
    expect(SRC).toMatch(/evictedNow > runState\.lastCompactedThrough/);
  });
});
