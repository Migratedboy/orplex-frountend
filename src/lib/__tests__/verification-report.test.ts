/**
 * verification-report.test.ts — Phase 7's Verification Report: the verdict
 * reuse, the deterministic residual-risk rules (a)-(f), the unverified[]
 * list, acceptance-first integration, and the human-readable format.
 *
 * Every case is a scripted platform observation — no model, no filesystem.
 */
import {
  buildVerificationReport,
  computeResidualRisk,
  formatVerificationReport,
  VERIFICATION_LANES,
} from "../reliability/verification-report";
import {
  reliabilityGatesEnabled,
  reliabilityRolesReviewEnabled,
  reliabilityVerificationReportEnabled,
} from "../reliability/flags";
import type { LaneOutcome } from "../reliability/types";

const ALL_PASS: Record<string, LaneOutcome> = {
  typecheck: "pass",
  lint: "pass",
  test: "pass",
  browser: "pass",
  swarm: "pass",
};

const ALL_SKIPPED: Record<string, LaneOutcome> = {
  typecheck: "skipped",
  lint: "skipped",
  test: "skipped",
  browser: "skipped",
  swarm: "skipped",
};

// ---------------------------------------------------------------------------
// Flag — Phase 7 is inert by default
// ---------------------------------------------------------------------------

describe("roles & review flag (plan §15: default OFF, master switch gates all)", () => {
  const ENV = process.env;
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.RELIABILITY_GATES;
    delete process.env.RELIABILITY_ROLES_REVIEW;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("is OFF when the master switch is unset", () => {
    expect(reliabilityRolesReviewEnabled()).toBe(false);
  });

  it("stays OFF when only RELIABILITY_ROLES_REVIEW is set", () => {
    process.env.RELIABILITY_ROLES_REVIEW = "1";
    expect(reliabilityRolesReviewEnabled()).toBe(false);
    expect(reliabilityGatesEnabled()).toBe(false);
  });

  it("turns ON only when both switches are on", () => {
    process.env.RELIABILITY_GATES = "1";
    process.env.RELIABILITY_ROLES_REVIEW = "1";
    expect(reliabilityRolesReviewEnabled()).toBe(true);
  });
});

describe("verification report flag (plan §15: default OFF, master switch gates all)", () => {
  const ENV = process.env;
  beforeEach(() => {
    process.env = { ...ENV };
    delete process.env.RELIABILITY_GATES;
    delete process.env.RELIABILITY_REPORT;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("is OFF when the master switch is unset", () => {
    process.env.RELIABILITY_REPORT = "1";
    expect(reliabilityVerificationReportEnabled()).toBe(false);
  });

  it("turns ON only when RELIABILITY_GATES=1 and RELIABILITY_REPORT=1", () => {
    expect(reliabilityVerificationReportEnabled()).toBe(false);
    process.env.RELIABILITY_GATES = "1";
    expect(reliabilityVerificationReportEnabled()).toBe(false);
    process.env.RELIABILITY_REPORT = "1";
    expect(reliabilityVerificationReportEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildVerificationReport
// ---------------------------------------------------------------------------

describe("buildVerificationReport", () => {
  it("reports PASS / residual risk none when every lane ran and passed", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: ALL_PASS,
      filesWritten: ["src/a.ts"],
      at: "2026-10-17T00:00:00.000Z",
    });
    expect(r.verdict).toBe("PASS");
    expect(r.residualRisk).toBe("none");
    expect(r.residualRiskReasons).toEqual([]);
    expect(r.unverified).toEqual([]);
    expect(r.taskId).toBe("t1");
    expect(r.at).toBe("2026-10-17T00:00:00.000Z");
    // All five canonical lanes are always present, in pipeline order.
    expect(Object.keys(r.lanes)).toEqual([...VERIFICATION_LANES]);
  });

  it("normalizes missing lanes to skipped — a lane nobody reported is never a pass", () => {
    const r = buildVerificationReport({ taskId: "t1", finalStatus: "done", lanes: { typecheck: "pass" } });
    expect(r.lanes.lint).toBe("skipped");
    expect(r.lanes.test).toBe("skipped");
    // Verdict still PASS (skipped never fails the verdict) — risk carries the doubt.
    expect(r.verdict).toBe("PASS");
    expect(r.residualRisk).not.toBe("none");
  });

  it("FAILs the verdict and forces HIGH residual risk when a lane failed with new errors", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: { typecheck: "fail" },
      gates: [
        {
          lane: "typecheck",
          outcome: "fail",
          durationMs: 1200,
          newErrors: ["src/a.ts:TS2345"],
          preExisting: false,
        },
      ],
      filesWritten: ["src/a.ts"],
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.residualRisk).toBe("high");
    expect(r.residualRiskReasons.some((x) => x.includes("typecheck"))).toBe(true);
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0].newErrors).toEqual(["src/a.ts:TS2345"]);
  });

  it("FAILs the verdict for a non-done close regardless of lanes", () => {
    const r = buildVerificationReport({ taskId: "t1", finalStatus: "error", lanes: ALL_PASS });
    expect(r.verdict).toBe("FAIL");
  });

  it("reuses computeVerdict semantics: gate results win over the lane map", () => {
    // The caller's lane map says pass; the gate (exit-code evidence) says fail.
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: { typecheck: "pass" },
      gates: [
        { lane: "typecheck", outcome: "fail", durationMs: 10, newErrors: ["x.ts:TS1"], preExisting: false },
      ],
    });
    expect(r.lanes.typecheck).toBe("fail");
    expect(r.verdict).toBe("FAIL");
  });

  it("does NOT escalate to HIGH for a pre-existing failure with no new errors", () => {
    // Rule (a) requires NEW errors; a pre-existing red is not this task's
    // fault — same philosophy as the gate pipeline's baseline diff.
    const lanes = { ...ALL_PASS, typecheck: "fail" as LaneOutcome };
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes,
      gates: [
        { lane: "typecheck", outcome: "fail", durationMs: 5, newErrors: [], preExisting: true },
      ],
      filesWritten: ["src/a.ts"],
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.residualRisk).not.toBe("high");
  });

  it("forces HIGH when tamperFindings contains a block severity", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: ALL_PASS,
      tamperFindings: [{ signal: "test-file-deleted", severity: "block" }],
    });
    expect(r.residualRisk).toBe("high");
    expect(r.residualRiskReasons.some((x) => x.includes("tamper"))).toBe(true);
    expect(r.tamperFindings).toHaveLength(1);
  });

  it("forces MEDIUM when files were written and NO verification lane ran", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: ALL_SKIPPED,
      filesWritten: ["src/a.ts"],
    });
    // Verdict is PASS (nothing failed) — the risk carries the "unverified close".
    expect(r.verdict).toBe("PASS");
    expect(r.residualRisk).toBe("medium");
    expect(r.residualRiskReasons.some((x) => x.includes("no verification lane ran"))).toBe(true);
  });

  it("forces MEDIUM when the test lane is skipped while lint/typecheck passed (untested code shipped)", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: { typecheck: "pass", lint: "pass", test: "skipped", browser: "pass", swarm: "pass" },
      filesWritten: ["src/a.ts"],
    });
    expect(r.residualRisk).toBe("medium");
    expect(r.residualRiskReasons.some((x) => x.includes("untested code shipped"))).toBe(true);
  });

  it("reports LOW when a lane was skipped but nothing else is wrong", () => {
    // test PASSED (so rule (d) can't fire) — only browser/swarm didn't run.
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: { typecheck: "pass", lint: "pass", test: "pass", browser: "skipped", swarm: "skipped" },
      filesWritten: ["src/a.ts"],
    });
    expect(r.residualRisk).toBe("low");
    expect(r.residualRiskReasons.some((x) => x.includes("browser"))).toBe(true);
  });

  it("merges acceptance items into unverified[] and the acceptance tally", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: { typecheck: "pass", lint: "pass", test: "skipped", browser: "pass", swarm: "pass" },
      filesWritten: ["src/login.ts"],
      acceptanceSpec: [
        { description: "login rejects bad passwords", verifiedBy: "test", files: ["src/login.test.ts"] },
        { description: "types still compile", verifiedBy: "typecheck" },
      ],
    });
    expect(r.acceptance).toEqual({ verified: 1, failed: 0, unverified: 1, complete: false });
    expect(r.unverified).toHaveLength(1);
    expect(r.unverified[0].area).toBe("login rejects bad passwords");
    expect(r.unverified[0].files).toEqual(["src/login.test.ts"]);
    // Unverified acceptance forces residualRisk >= medium.
    expect(r.residualRisk).not.toBe("low");
    expect(r.residualRisk).not.toBe("none");
    expect(r.residualRiskReasons.some((x) => x.includes("acceptance"))).toBe(true);
  });

  it("keeps a complete acceptance tally when every declared lane passed", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "done",
      lanes: ALL_PASS,
      acceptanceSpec: [{ description: "it works", verifiedBy: "test" }],
    });
    expect(r.acceptance).toEqual({ verified: 1, failed: 0, unverified: 0, complete: true });
    expect(r.unverified).toEqual([]);
    expect(r.residualRisk).toBe("none");
  });

  it("passes through editLockRefused and merges caller-supplied unverified items", () => {
    const r = buildVerificationReport({
      taskId: "t1",
      finalStatus: "error",
      lanes: ALL_PASS,
      editLockRefused: 2,
      unverified: [{ area: "browser lane", reason: "no browser session available" }],
    });
    expect(r.editLockRefused).toBe(2);
    expect(r.unverified).toHaveLength(1);
    // Optional fields stay absent when not supplied.
    const bare = buildVerificationReport({ taskId: "t2", finalStatus: "done", lanes: ALL_PASS });
    expect(bare.editLockRefused).toBeUndefined();
    expect(bare.tamperFindings).toBeUndefined();
    expect(bare.acceptance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeResidualRisk — the six rules, deterministically
// ---------------------------------------------------------------------------

describe("computeResidualRisk rules", () => {
  it("(a) HIGH on a failed lane with new errors", () => {
    const { risk } = computeResidualRisk({
      lanes: { typecheck: "fail" },
      gates: [{ lane: "typecheck", outcome: "fail", durationMs: 1, newErrors: ["a.ts:TS1"], preExisting: false }],
    });
    expect(risk).toBe("high");
  });

  it("(b) HIGH on a block-severity tamper finding; non-block severities do not escalate", () => {
    expect(computeResidualRisk({ lanes: ALL_PASS, tamperFindings: [{ severity: "block" }] }).risk).toBe("high");
    expect(computeResidualRisk({ lanes: ALL_PASS, tamperFindings: [{ severity: "warn" }] }).risk).toBe("none");
  });

  it("(c) MEDIUM when files were written and no lane ran", () => {
    const { risk, reasons } = computeResidualRisk({ lanes: ALL_SKIPPED, filesWritten: ["a.ts"] });
    expect(risk).toBe("medium");
    expect(reasons.some((x) => x.includes("no verification lane ran"))).toBe(true);
  });

  it("(c) does not fire when nothing was written", () => {
    // All lanes skipped, no writes → only rule (e).
    const { risk } = computeResidualRisk({ lanes: ALL_SKIPPED, filesWritten: [] });
    expect(risk).toBe("low");
  });

  it("(d) MEDIUM when the test lane is skipped while lint/typecheck passed", () => {
    expect(
      computeResidualRisk({ lanes: { typecheck: "pass", lint: "pass", test: "skipped" } }).risk,
    ).toBe("medium");
    // test skipped while typecheck FAILED (and lint never ran) → not (d).
    expect(
      computeResidualRisk({ lanes: { typecheck: "fail", lint: "skipped", test: "skipped" } }).risk,
    ).toBe("low");
  });

  it("(d') unverified acceptance items force at least MEDIUM even with all lanes green", () => {
    const { risk, reasons } = computeResidualRisk({
      lanes: ALL_PASS,
      unverified: [{ area: "billing refund", reason: "never checked" }],
    });
    expect(risk).toBe("medium");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("acceptance");
  });

  it("(e) LOW when any verification lane was skipped", () => {
    const { risk } = computeResidualRisk({ lanes: { ...ALL_PASS, swarm: "skipped" } });
    expect(risk).toBe("low");
  });

  it("(f) NONE when every lane ran and passed and nothing else is outstanding", () => {
    const { risk, reasons } = computeResidualRisk({ lanes: ALL_PASS, filesWritten: ["a.ts"] });
    expect(risk).toBe("none");
    expect(reasons).toEqual([]);
  });

  it("takes the MAXIMUM of simultaneous triggers and lists only the top-level reasons", () => {
    const { risk, reasons } = computeResidualRisk({
      lanes: { typecheck: "fail", lint: "pass", test: "skipped", browser: "pass", swarm: "pass" },
      gates: [
        { lane: "typecheck", outcome: "fail", durationMs: 1, newErrors: ["a.ts:TS1"], preExisting: false },
      ],
      unverified: [{ area: "x", reason: "y" }],
    });
    expect(risk).toBe("high");
    // The medium/low triggers were outweighed — their reasons must not masquerade
    // as HIGH reasons.
    expect(reasons.every((x) => x.includes("new error"))).toBe(true);
  });

  it("treats missing lanes as skipped (never a pass)", () => {
    const { risk } = computeResidualRisk({});
    expect(risk).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// formatVerificationReport — the block a user reads
// ---------------------------------------------------------------------------

describe("formatVerificationReport", () => {
  it("lists the verdict, every lane in plain words, unverified items, and the risk", () => {
    const r = buildVerificationReport({
      taskId: "t9",
      finalStatus: "done",
      at: "2026-10-17T12:00:00.000Z",
      lanes: { typecheck: "pass", lint: "pass", test: "skipped", browser: "pass", swarm: "skipped" },
      filesWritten: ["src/login.ts"],
      acceptanceSpec: [
        { description: "types still compile", verifiedBy: "typecheck" },
        { description: "login is rate-limited", verifiedBy: "test", files: ["src/login.test.ts"] },
      ],
      editLockRefused: 1,
    });
    const text = formatVerificationReport(r);
    expect(text).toContain("VERIFICATION REPORT — task t9");
    expect(text).toContain("Result: PASS");
    // Plain words, not jargon, for lane outcomes.
    expect(text).toContain("passed");
    expect(text).toContain("not run");
    expect(text).toContain("Acceptance: 1 verified, 0 failed, 1 not verified — INCOMPLETE");
    expect(text).toContain("Not verified (1):");
    expect(text).toContain("login is rate-limited");
    expect(text).toContain("files: src/login.test.ts");
    expect(text).toContain("Writes refused while a check was red: 1.");
    expect(text).toMatch(/Residual risk: (MEDIUM|HIGH)/);
  });

  it("spells out a FAIL with the failing lane and its new errors", () => {
    const r = buildVerificationReport({
      taskId: "t9",
      finalStatus: "done",
      lanes: { typecheck: "fail" },
      gates: [
        {
          lane: "typecheck",
          outcome: "fail",
          durationMs: 900,
          newErrors: ["src/a.ts:TS2345", "src/b.ts:TS1005"],
          preExisting: false,
        },
      ],
      filesWritten: ["src/a.ts"],
    });
    const text = formatVerificationReport(r);
    expect(text).toContain("Result: FAIL");
    expect(text).toContain("Failed checks:");
    expect(text).toContain("typecheck: FAILED");
    expect(text).toContain("2 new error(s)");
    expect(text).toContain("Residual risk: HIGH");
  });

  it("says so explicitly when nothing is unverified", () => {
    const text = formatVerificationReport(
      buildVerificationReport({ taskId: "t1", finalStatus: "done", lanes: ALL_PASS }),
    );
    expect(text).toContain("Not verified: nothing");
    expect(text).toContain("Residual risk: NONE");
  });

  it("marks a pre-existing failure so it is not read as this task's regression", () => {
    const text = formatVerificationReport(
      buildVerificationReport({
        taskId: "t1",
        finalStatus: "done",
        lanes: { typecheck: "fail" },
        gates: [
          { lane: "typecheck", outcome: "fail", durationMs: 1, newErrors: [], preExisting: true },
        ],
      }),
    );
    expect(text).toContain("pre-existing — not caused by this task");
  });
});
