/**
 * list_files could not be caught by the loop breaker.
 *
 * It is in READ_ONLY_TOOLS (exempt from the single-tool-streak signal) and had
 * no callTarget case (so the same-target signal never fired). The only
 * surviving signal was byte-identical calls, so a model that varied the
 * argument tripped nothing: list_files(), list_files({path:"."}),
 * list_files({path:"/"}) against a 120-turn ceiling. That is exactly the loop
 * observed on an empty workspace.
 */

import {
  MAX_SAME_TARGET,
  callTarget,
  createLoopStreaks,
  trackToolTurn,
} from "../loop-detect";

const c = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });

describe("callTarget: list_files", () => {
  it("returns a target instead of falling through to null", () => {
    // Before the fix this was null, so the same-target signal could not fire.
    expect(callTarget(c("list_files"))).not.toBeNull();
    expect(callTarget(c("list_files", { path: "src" }))).not.toBeNull();
  });

  it("collapses the spellings of the workspace root to one identity", () => {
    const keys = [
      callTarget(c("list_files"))?.key,
      callTarget(c("list_files", { path: "" }))?.key,
      callTarget(c("list_files", { path: "." }))?.key,
      callTarget(c("list_files", { path: "./" }))?.key,
      callTarget(c("list_files", { path: "/" }))?.key,
      callTarget(c("list_files", { path: "src/../" }))?.key,
    ];
    // All of these mean the same tree, so the directory walk returns the same
    // result for each — alternating between them is not progress.
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps genuinely different directories distinct", () => {
    expect(callTarget(c("list_files", { path: "src" }))?.key).not.toBe(
      callTarget(c("list_files", { path: "tests" }))?.key,
    );
  });
});

describe("loop detection on a repeated empty listing", () => {
  it("trips when the model varies the argument but means the same path", () => {
    const s = createLoopStreaks();
    // Vary the spelling each turn — the argument bytes differ, so the
    // identical-call signal never fired before.
    const variants = [
      c("list_files"),
      c("list_files", { path: "." }),
      c("list_files", { path: "/" }),
      c("list_files", { path: "./" }),
    ];

    let tripped = false;
    for (const call of variants) {
      if (trackToolTurn(s, [call]).loop) {
        tripped = true;
        break;
      }
    }
    // Either it trips within the first few variants, or it is close enough to
    // the ceiling that continuing trips it. Both are the desired outcome.
    if (!tripped) {
      for (let i = 0; i < MAX_SAME_TARGET * 2; i++) {
        if (trackToolTurn(s, [c("list_files", { path: i % 2 ? "." : "/" })]).loop) {
          tripped = true;
          break;
        }
      }
    }
    expect(tripped).toBe(true);
  });

  it("does not trip on a legitimate descent into subdirectories", () => {
    const s = createLoopStreaks();
    // Successively deeper directories are real progress and must stay allowed.
    for (const p of ["src", "src/lib", "src/lib/agent", "src/lib/agent/deep"]) {
      expect(trackToolTurn(s, [c("list_files", { path: p })]).loop).toBe(false);
    }
  });
});
