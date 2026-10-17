// plan-gate.test.ts — The hard plan-approval latch: state-changing tools are
// blocked until explicit approval; rejection forces re-plan; non-write tools
// never block; finished tasks drop their latch.

import {
  planGateBlocks,
  planGateMessage,
  approvePlan,
  rejectPlan,
  isPlanApproved,
  isPlanRejected,
  clearPlanLatch,
  resetPlanGate,
} from "../plan-gate";

beforeEach(() => resetPlanGate());

describe("plan-gate", () => {
  it("blocks write tools before approval", () => {
    expect(planGateBlocks("t1", "write_file")).toBe(true);
    expect(planGateBlocks("t1", "edit_file")).toBe(true);
    expect(planGateBlocks("t1", "run_command")).toBe(true);
  });

  it("never blocks read-only tools", () => {
    expect(planGateBlocks("t1", "read_file")).toBe(false);
    expect(planGateBlocks("t1", "list_files")).toBe(false);
    expect(planGateBlocks("t1", "todo_list")).toBe(false);
    expect(planGateBlocks("t1", "grep_search")).toBe(false);
  });

  it("approval opens the latch", () => {
    expect(planGateBlocks("t1", "write_file")).toBe(true);
    approvePlan("t1");
    expect(isPlanApproved("t1")).toBe(true);
    expect(planGateBlocks("t1", "write_file")).toBe(false);
  });

  it("rejection forces re-plan (latch stays closed, rejection recorded)", () => {
    rejectPlan("t1");
    expect(planGateBlocks("t1", "write_file")).toBe(true);
    expect(isPlanRejected("t1")).toBe(true);
    expect(isPlanApproved("t1")).toBe(false);
    // A revised plan can still be approved afterwards.
    approvePlan("t1");
    expect(planGateBlocks("t1", "write_file")).toBe(false);
  });

  it("task cleanup drops the latch (bounded state)", () => {
    approvePlan("t1");
    clearPlanLatch("t1");
    expect(isPlanApproved("t1")).toBe(false);
    // A fresh task with the same id starts unlatched.
    expect(planGateBlocks("t1", "write_file")).toBe(true);
  });

  it("tasks are isolated", () => {
    approvePlan("tA");
    expect(planGateBlocks("tB", "write_file")).toBe(true);
  });

  it("message names the tool and the required action", () => {
    const msg = planGateMessage("write_file");
    expect(msg).toContain("write_file");
    expect(msg).toMatch(/plan gate/i);
    expect(msg).toMatch(/approv/i);
  });

  // batch_edit, write_file_chunk and undo_last_change were all missing from
  // WRITE_TOOLS. Each requests its own approval, but the plan gate is a
  // stronger contract: in plan mode they were a way to change the workspace
  // before the plan was approved.
  it("blocks the write tools that were previously missing", () => {
    expect(planGateBlocks("t1", "batch_edit")).toBe(true);
    expect(planGateBlocks("t1", "write_file_chunk")).toBe(true);
    expect(planGateBlocks("t1", "undo_last_change")).toBe(true);
    expect(planGateBlocks("t1", "move_file")).toBe(true);
    expect(planGateBlocks("t1", "delete_file")).toBe(true);
  });

  it("blocks every workspace-mutating tool the registry defines", () => {
    // Guards against the set drifting from the tool registry again: anything
    // whose name implies a write must be plan-gated, approval or not.
    const MUTATING = /^(write|edit|batch_edit|undo_last_change|run_command|move|delete|patch)/;
    const knownTools = [
      "write_file",
      "write_file_chunk",
      "edit_file",
      "batch_edit",
      "undo_last_change",
      "run_command",
      "move_file",
      "delete_file",
    ];
    const ungated = knownTools.filter((t) => MUTATING.test(t) && !planGateBlocks("t1", t));
    expect(ungated).toEqual([]);
  });

  it("rejects them after the plan is approved, like every other write", () => {
    approvePlan("t1");
    for (const tool of ["write_file", "batch_edit", "write_file_chunk", "undo_last_change"]) {
      expect(planGateBlocks("t1", tool)).toBe(false);
    }
  });
});
