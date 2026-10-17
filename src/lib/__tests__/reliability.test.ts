/**
 * reliability.test.ts — Phase 1 gate pipeline + edit lock.
 *
 * The scripted-sequence tests drive runGatePipeline with a fake exec that
 * returns exit codes in a fixed order, which is how the plan requires an
 * "agent does X, system must respond Y" scenario to be proven without a live
 * model. Every assertion is about the GATE's decision, not the model's text.
 */
import {
  acquireEditLock,
  clearLane,
  getEditLock,
  isEditLocked,
  recordRefusedWrite,
  releaseEditLock,
  resetEditLocksForTests,
} from "../reliability/edit-lock";
import {
  captureBaseline,
  extractTypecheckSignatures,
  formatGateResult,
  runGatePipeline,
  tscErrorSignature,
  GATE_COMMANDS,
} from "../reliability/gates";
import type { GateExec } from "../reliability/types";
import {
  reliabilityGatesEnabled,
  reliabilityEditLockEnabled,
  reliabilityTestLaneEnabled,
  reliabilityBaselineEnabled,
} from "../reliability/flags";

// ---------------------------------------------------------------------------
// Flags — every sub-flag must be inert unless the master switch is on
// ---------------------------------------------------------------------------

describe("reliability flags (plan §15: default OFF, master switch gates all)", () => {
  const ENV = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ENV };
    delete process.env.RELIABILITY_GATES;
    delete process.env.RELIABILITY_EDIT_LOCK;
    delete process.env.RELIABILITY_TEST_LANE;
    delete process.env.RELIABILITY_BLOCK_BASELINE;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("everything is OFF when RELIABILITY_GATES is unset", () => {
    expect(reliabilityGatesEnabled()).toBe(false);
    expect(reliabilityEditLockEnabled()).toBe(false);
    expect(reliabilityTestLaneEnabled()).toBe(false);
    expect(reliabilityBaselineEnabled()).toBe(false);
  });

  it("sub-flags stay OFF when the master switch is off, even if set", () => {
    process.env.RELIABILITY_EDIT_LOCK = "1";
    process.env.RELIABILITY_TEST_LANE = "1";
    // A lock armed without a pipeline to clear it would wedge the task.
    expect(reliabilityEditLockEnabled()).toBe(false);
    expect(reliabilityTestLaneEnabled()).toBe(false);
  });

  it("sub-flags turn ON only when the master switch is also on", () => {
    process.env.RELIABILITY_GATES = "1";
    process.env.RELIABILITY_EDIT_LOCK = "1";
    process.env.RELIABILITY_TEST_LANE = "1";
    expect(reliabilityGatesEnabled()).toBe(true);
    expect(reliabilityEditLockEnabled()).toBe(true);
    expect(reliabilityTestLaneEnabled()).toBe(true);
    expect(reliabilityBaselineEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edit lock
// ---------------------------------------------------------------------------

describe("edit-lock (plan §6.2 — a red gate must refuse, not just report)", () => {
  beforeEach(() => resetEditLocksForTests());

  it("is unlocked for an unknown task", () => {
    expect(isEditLocked("t1")).toBeNull();
  });

  it("locks on acquire and unlocks when the last red lane clears", () => {
    acquireEditLock("t1", "typecheck", "tsc failed");
    expect(isEditLocked("t1")).not.toBeNull();
    // One red lane left → clearing it releases the lock entirely.
    expect(clearLane("t1", "typecheck")).toBe(true);
    expect(isEditLocked("t1")).toBeNull();
  });

  it("stays locked while any lane remains red", () => {
    acquireEditLock("t1", "typecheck", "tsc failed");
    acquireEditLock("t1", "test", "jest failed");
    // Clearing one lane must NOT release — two were red.
    expect(clearLane("t1", "typecheck")).toBe(false);
    expect(isEditLocked("t1")).not.toBeNull();
    expect(clearLane("t1", "test")).toBe(true);
    expect(isEditLocked("t1")).toBeNull();
  });

  it("counts refused writes so the report can state how many were blocked", () => {
    acquireEditLock("t1", "typecheck", "tsc failed");
    recordRefusedWrite("t1");
    recordRefusedWrite("t1");
    expect(getEditLock("t1")?.refusedWrites).toBe(2);
  });

  it("releaseEditLock drops the lock unconditionally (task end)", () => {
    acquireEditLock("t1", "typecheck", "tsc failed");
    releaseEditLock("t1");
    expect(isEditLocked("t1")).toBeNull();
  });

  it("locks are per-task — one task's red gate does not lock another", () => {
    acquireEditLock("t1", "typecheck", "tsc failed");
    expect(isEditLocked("t2")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error signatures — the baseline diff depends on these being stable
// ---------------------------------------------------------------------------

describe("typecheck error signatures", () => {
  it("reduces a tsc line to path:CODE, dropping line/column", () => {
    // Line/col must be dropped: an error that shifts because the agent
    // inserted a line above it is the SAME error, not a new one.
    expect(tscErrorSignature("src/a.ts(10,5): error TS2345: Argument of type 'x'.")).toBe("src/a.ts:TS2345");
    expect(tscErrorSignature("src/a.ts(99,1): error TS2345: Argument of type 'x'.")).toBe("src/a.ts:TS2345");
  });

  it("dedupes and sorts signatures across a multi-error dump", () => {
    const out = [
      "src/b.ts(1,1): error TS1005: ';' expected.",
      "src/a.ts(2,3): error TS2345: Argument.",
      "src/a.ts(10,5): error TS2345: Argument of type.", // same sig as above
      "no error here",
    ].join("\n");
    expect(extractTypecheckSignatures(out)).toEqual(["src/a.ts:TS2345", "src/b.ts:TS1005"]);
  });

  it("returns [] for clean output", () => {
    expect(extractTypecheckSignatures("")).toEqual([]);
    expect(extractTypecheckSignatures("Found 0 errors.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline verdict — scripted exec sequences
// ---------------------------------------------------------------------------

/** A GateExec that replays a fixed list of responses in call order. */
function scriptedExec(responses: Array<{ exitCode?: number; stdout?: string; stderr?: string }>): GateExec & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  const run = async (command: string, _timeoutMs: number) => {
    calls.push(command);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
  return Object.assign(run, { calls });
}

const CLEAN = { exitCode: 0, stdout: "", stderr: "" };

describe("gate pipeline verdict (scripted sequences)", () => {
  it("PASSes when every lane is clean", async () => {
    const exec = scriptedExec([CLEAN, CLEAN, CLEAN]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: ["src/a.ts"],
      includeTestLane: false,
    });
    expect(r.verdict).toBe("PASS");
    expect(r.blocking).toHaveLength(0);
  });

  it("FAILS on a typecheck regression and names the blocking lane", async () => {
    const exec = scriptedExec([
      { exitCode: 2, stdout: "src/a.ts(3,1): error TS1005: ';' expected.", stderr: "" },
    ]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.blocking.map((b) => b.lane)).toEqual(["typecheck"]);
  });

  it("does NOT block on a pre-existing baseline failure", async () => {
    // Baseline already had src/old.ts:TS2345. The gate fails with the SAME
    // error and nothing new — that is not this task's fault.
    const baseline = {
      capturedAt: Date.now(),
      typecheck: { ran: true, exitCode: 2, errors: ["src/old.ts:TS2345"] },
    };
    const exec = scriptedExec([
      { exitCode: 2, stdout: "src/old.ts(4,1): error TS2345: old error.", stderr: "" },
    ]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    const tc = r.results.find((x) => x.lane === "typecheck")!;
    expect(tc.preExisting).toBe(true);
    expect(r.verdict).toBe("PASS");
    expect(r.blocking).toHaveLength(0);
  });

  it("blocks when the baseline error is joined by a NEW one", async () => {
    const baseline = {
      capturedAt: Date.now(),
      typecheck: { ran: true, exitCode: 2, errors: ["src/old.ts:TS2345"] },
    };
    const exec = scriptedExec([
      {
        exitCode: 2,
        stdout: [
          "src/old.ts(4,1): error TS2345: old error.",
          "src/new.ts(7,1): error TS1005: ';' expected.", // the agent's
        ].join("\n"),
        stderr: "",
      },
    ]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    const tc = r.results.find((x) => x.lane === "typecheck")!;
    expect(tc.newErrors).toEqual(["src/new.ts:TS1005"]);
    expect(tc.preExisting).toBe(false);
    expect(r.verdict).toBe("FAIL");
  });

  it("treats a lane that could not run as skipped, never a pass", async () => {
    // No exitCode in the response = exec route unavailable.
    const exec = scriptedExec([{ stdout: "", stderr: "boom" }]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    const tc = r.results.find((x) => x.lane === "typecheck")!;
    expect(tc.outcome).toBe("skipped");
    expect(tc.exitCode).toBeNull();
    // A skipped lane is not a failure either — nothing to block on.
    expect(r.verdict).toBe("PASS");
  });

  it("scopes the lint lane to the files the task changed", async () => {
    const exec = scriptedExec([CLEAN, CLEAN]);
    await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: ["src/my file.ts", "src/plain.ts"],
      includeTestLane: false,
    });
    const lintCall = exec.calls.find((c) => c.startsWith("npx eslint"));
    expect(lintCall).toBeDefined();
    // Quoted so a space in the path survives the shell.
    expect(lintCall).toContain('"src/my file.ts"');
    expect(lintCall).toContain("src/plain.ts");
  });

  it("skips lint when nothing was written", async () => {
    const exec = scriptedExec([CLEAN]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    const lint = r.results.find((x) => x.lane === "lint")!;
    expect(lint.outcome).toBe("skipped");
    // Only the typecheck command ran — no eslint invocation.
    expect(exec.calls.every((c) => !c.startsWith("npx eslint"))).toBe(true);
  });

  it("does not run the jest lane unless explicitly armed", async () => {
    const exec = scriptedExec([CLEAN]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: ["src/a.ts"],
      includeTestLane: false,
    });
    const test = r.results.find((x) => x.lane === "test")!;
    expect(test.outcome).toBe("skipped");
    expect(exec.calls.some((c) => c.includes("jest"))).toBe(false);
  });

  it("runs the jest lane when armed and blocks on a real failure", async () => {
    // typecheck clean, lint clean, jest red.
    const exec = scriptedExec([CLEAN, CLEAN, { exitCode: 1, stdout: "FAIL src/a.test.ts", stderr: "" }]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: ["src/a.ts"],
      includeTestLane: true,
    });
    expect(exec.calls.some((c) => c === GATE_COMMANDS.test)).toBe(true);
    expect(r.verdict).toBe("FAIL");
    expect(r.blocking.map((b) => b.lane)).toEqual(["test"]);
  });

  it("reports resolved baseline errors so the summary can show progress", async () => {
    const baseline = {
      capturedAt: Date.now(),
      typecheck: { ran: true, exitCode: 2, errors: ["src/old.ts:TS2345", "src/gone.ts:TS1005"] },
    };
    // Now only one of the two baseline errors remains; the other was fixed.
    const exec = scriptedExec([
      { exitCode: 2, stdout: "src/old.ts(4,1): error TS2345: still here.", stderr: "" },
    ]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    const tc = r.results.find((x) => x.lane === "typecheck")!;
    expect(tc.resolvedErrors).toEqual(["src/gone.ts:TS1005"]);
    expect(tc.preExisting).toBe(true);
    expect(r.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Baseline capture
// ---------------------------------------------------------------------------

describe("baseline capture", () => {
  it("records the pre-task error set when the lane runs", async () => {
    const exec = scriptedExec([
      { exitCode: 2, stdout: "src/a.ts(1,1): error TS1005: expected.", stderr: "" },
    ]);
    const b = await captureBaseline(exec);
    expect(b.typecheck?.ran).toBe(true);
    expect(b.typecheck?.errors).toEqual(["src/a.ts:TS1005"]);
  });

  it("records ran:false when the lane cannot execute", async () => {
    const exec = scriptedExec([{ stdout: "", stderr: "no server" }]);
    const b = await captureBaseline(exec);
    expect(b.typecheck?.ran).toBe(false);
  });

  it("captures nothing when already aborted", async () => {
    const exec = scriptedExec([CLEAN]);
    const ac = new AbortController();
    ac.abort();
    const b = await captureBaseline(exec, ac.signal);
    expect(b.typecheck?.ran).toBe(false);
    expect(exec.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate summary formatting — the Verification Report surface
// ---------------------------------------------------------------------------

describe("formatGateResult", () => {
  it("states the verdict, per-lane outcomes, and the refusal reason", async () => {
    const exec = scriptedExec([
      { exitCode: 2, stdout: "src/a.ts(1,1): error TS1005: expected.", stderr: "" },
    ]);
    const r = await runGatePipeline({
      taskId: "t1",
      baseline: null,
      exec,
      changedFiles: [],
      includeTestLane: false,
    });
    const text = formatGateResult(r);
    expect(text).toContain("verdict FAIL");
    expect(text).toContain("typecheck");
    expect(text).toContain("1 lane(s) blocking");
    expect(text).toContain("writes are refused");
    // Skipped lanes must read as skipped, not silently absent.
    expect(text).toContain("skipped");
  });
});
