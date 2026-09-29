// benchmark-report.test.ts — C7: cost-adjusted aggregation over TaskRun rows.
// Pure-core tests: no DB; rows are dated relative to now so the window
// filter is deterministic.

import { buildBenchmarkReport, formatBenchmarkReport, type BenchRunRow } from "../benchmark-report";

const DAY = 86_400_000;

function row(over: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    finalStatus: "done",
    mode: "auto",
    typecheckLane: "pass",
    browserLane: "pass",
    swarmLane: "skipped",
    modelCalls: 10,
    tokensSaved: 1200,
    durationMs: 60_000,
    createdAt: new Date(),
    ...over,
  };
}

describe("buildBenchmarkReport", () => {
  it("computes pass rate and A2 hard-verdict mix from lanes", () => {
    const r = buildBenchmarkReport([
      row(), // done + no fail → hard PASS
      row({ typecheckLane: "fail" }), // done BUT lane fail → hard FAIL
      row({ finalStatus: "error", typecheckLane: "fail" }), // FAIL
      row({ typecheckLane: "skipped", browserLane: "skipped", swarmLane: "skipped" }), // PASS (skip never fails)
    ]);
    expect(r.totalRuns).toBe(4);
    expect(r.done).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.passRate).toBeCloseTo(0.75);
    expect(r.hardPassed).toBe(2);
    expect(r.hardFailed).toBe(2);
  });

  it("skipped lanes never fail a hard verdict", () => {
    const r = buildBenchmarkReport([
      row({ typecheckLane: "skipped", browserLane: "skipped", swarmLane: "skipped" }),
    ]);
    expect(r.hardPassed).toBe(1);
    expect(r.hardFailed).toBe(0);
  });

  it("counts lane outcomes across runs", () => {
    const r = buildBenchmarkReport([
      row({ typecheckLane: "pass", browserLane: "fail", swarmLane: "pass" }),
      row({ typecheckLane: "fail", browserLane: "pass", swarmLane: "fail" }),
      row({ typecheckLane: "skipped", browserLane: "skipped", swarmLane: "skipped" }),
    ]);
    expect(r.lanes.typecheck).toEqual({ pass: 1, fail: 1, skipped: 1 });
    expect(r.lanes.browser).toEqual({ pass: 1, fail: 1, skipped: 1 });
    expect(r.lanes.swarm).toEqual({ pass: 1, fail: 1, skipped: 1 });
  });

  it("computes duration median and p90", () => {
    const rows = [10, 20, 30, 40, 100].map((s) => row({ durationMs: s * 1000 }));
    const r = buildBenchmarkReport(rows);
    expect(r.durationMs.median).toBe(30_000);
    expect(r.durationMs.p90).toBe(100_000);
  });

  it("estimates cost from model calls and reports per-hard-pass cost", () => {
    const r = buildBenchmarkReport([row({ modelCalls: 10 }), row({ modelCalls: 20 })], {
      avgTokensPerCall: 1000,
    });
    // estimateCostFromTotal: 10k tokens → 7000 in / 3000 out at 0.3/1.2 per 1M
    // run1: 7000/1e6*0.3 + 3000/1e6*1.2 = 0.0021 + 0.0036 = 0.0057
    // run2: twice that = 0.0114 → total 0.0171
    expect(r.cost.totalUsd).toBeCloseTo(0.0171, 6);
    expect(r.cost.medianPerRunUsd).toBeCloseTo(0.00855, 6);
    expect(r.cost.perHardPassUsd).toBeCloseTo(0.00855, 6);
    expect(r.cost.estimated).toBe(true);
    expect(r.cost.avgTokensPerCall).toBe(1000);
  });

  it("breaks results down by mode", () => {
    const r = buildBenchmarkReport([
      row({ mode: "auto" }),
      row({ mode: "auto", modelCalls: 30 }),
      row({ mode: "review", finalStatus: "error", modelCalls: 5 }),
    ]);
    expect(r.byMode).toHaveLength(2);
    const auto = r.byMode.find((m) => m.mode === "auto")!;
    expect(auto.runs).toBe(2);
    expect(auto.hardPassed).toBe(2);
    const review = r.byMode.find((m) => m.mode === "review")!;
    expect(review.hardPassed).toBe(0);
  });

  it("filters by window days", () => {
    const r = buildBenchmarkReport([
      row(),
      row({ createdAt: new Date(Date.now() - 3 * DAY) }),
      row({ createdAt: new Date(Date.now() - 30 * DAY) }),
    ], { windowDays: 7 });
    expect(r.totalRuns).toBe(2);
    expect(r.windowDays).toBe(7);
  });

  it("handles an empty run set without dividing by zero", () => {
    const r = buildBenchmarkReport([]);
    expect(r.totalRuns).toBe(0);
    expect(r.passRate).toBe(0);
    expect(r.cost.totalUsd).toBe(0);
    expect(r.cost.perHardPassUsd).toBe(0);
  });
});

describe("formatBenchmarkReport", () => {
  it("renders a verdict-first human report", () => {
    const report = buildBenchmarkReport([row(), row({ modelCalls: 20, swarmLane: "fail" })], {
      avgTokensPerCall: 1000,
    });
    const text = formatBenchmarkReport(report);
    expect(text).toContain("hard-PASSED");
    expect(text).toContain("1/2 hard-PASSED");
    expect(text).toContain("pass rate 100.0%");
    expect(text).toContain("Cost (ESTIMATED");
    expect(text).toContain("$0.02 total"); // 0.0171 → formatCost → $0.02
    expect(text).toContain("By mode:");
    expect(text).toContain("not billing data");
  });

  it("has an explicit empty-state line", () => {
    expect(formatBenchmarkReport(buildBenchmarkReport([]))).toContain("No runs in scope");
  });
});
