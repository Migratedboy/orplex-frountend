// benchmark-report.test.ts — The aggregation core behind `npm run bench:report`.
//
// This module had NO test while scripts/bench-report.mjs depended on it for
// its math. That is precisely how the module could be deleted while the script
// kept reading it: nothing failed until DATABASE_URL was set and the script
// threw ENOENT. These tests pin the behaviour AND make the file loadable, so
// the same deletion fails loudly here first.

import {
  buildBenchmarkReport,
  formatBenchmarkReport,
  type BenchmarkRow,
  type BenchmarkFailureRow,
} from "../benchmark-report";

const row = (over: Partial<BenchmarkRow> = {}): BenchmarkRow => ({
  finalStatus: "done",
  mode: "code",
  typecheckLane: "pass",
  browserLane: "pass",
  swarmLane: "skipped",
  modelCalls: 10,
  tokensSaved: 100,
  durationMs: 5_000,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("buildBenchmarkReport", () => {
  it("counts a finished run with no failing lane as a hard pass", () => {
    const r = buildBenchmarkReport([row()]);
    expect(r.total).toBe(1);
    expect(r.done).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.laneFailed).toBe(0);
    expect(r.passRate).toBe(1);
  });

  it("does NOT let a skipped lane turn a finished run into a failure", () => {
    // The regression this guards: treating "skipped" as a failure would report
    // every task that never opened a browser as broken.
    const r = buildBenchmarkReport([
      row({ typecheckLane: "pass", browserLane: "skipped", swarmLane: "skipped" }),
    ]);
    expect(r.passed).toBe(1);
    expect(r.laneFailed).toBe(0);
  });

  it("separates 'finished but lane failed' from 'passed'", () => {
    const r = buildBenchmarkReport([row({ browserLane: "fail" })]);
    expect(r.passed).toBe(0);
    expect(r.laneFailed).toBe(1);
    expect(r.done).toBe(1);
    expect(r.passRate).toBe(0);
  });

  it("separates aborted from error", () => {
    const r = buildBenchmarkReport([
      row({ finalStatus: "aborted" }),
      row({ finalStatus: "error" }),
    ]);
    expect(r.aborted).toBe(1);
    expect(r.error).toBe(1);
    // Neither finished, so neither is a pass.
    expect(r.passed).toBe(0);
  });

  it("tracks per-lane health independently", () => {
    const r = buildBenchmarkReport([
      row({ typecheckLane: "pass", browserLane: "fail", swarmLane: "skipped" }),
      row({ typecheckLane: "fail", browserLane: "pass", swarmLane: "pass" }),
      row({ typecheckLane: "pass", browserLane: "pass", swarmLane: "pass" }),
    ]);
    expect(r.laneHealth.typecheck).toEqual({ pass: 2, fail: 1, skipped: 0 });
    expect(r.laneHealth.browser).toEqual({ pass: 2, fail: 1, skipped: 0 });
    expect(r.laneHealth.swarm).toEqual({ pass: 2, fail: 0, skipped: 1 });
  });

  it("averages model calls and tokens saved per run", () => {
    const r = buildBenchmarkReport([row({ modelCalls: 10, tokensSaved: 100 }), row({ modelCalls: 20, tokensSaved: 300 })]);
    expect(r.modelCalls.total).toBe(30);
    expect(r.modelCalls.perRun).toBe(15);
    expect(r.tokensSaved.total).toBe(400);
    expect(r.tokensSaved.perRun).toBe(200);
  });

  it("computes duration percentiles without mutating the input order", () => {
    const rows = [
      row({ durationMs: 100 }),
      row({ durationMs: 200 }),
      row({ durationMs: 300 }),
      row({ durationMs: 400 }),
    ];
    const r = buildBenchmarkReport(rows);
    expect(r.durationMs.p50).toBe(200);
    expect(r.durationMs.p95).toBe(400);
    expect(r.durationMs.max).toBe(400);
    expect(rows.map((x) => x.durationMs)).toEqual([100, 200, 300, 400]);
  });

  it("reports cost per hard pass, and null when nothing passed", () => {
    const good = buildBenchmarkReport([row(), row()]);
    expect(good.perHardPassCost).not.toBeNull();

    const none = buildBenchmarkReport([row({ finalStatus: "error" })]);
    expect(none.perHardPassCost).toBeNull();
  });

  it("handles an empty window without dividing by zero or throwing", () => {
    const r = buildBenchmarkReport([], { windowDays: 7 });
    expect(r.total).toBe(0);
    expect(r.passRate).toBe(0);
    expect(r.modelCalls.perRun).toBe(0);
    expect(r.perHardPassCost).toBeNull();
    expect(r.windowDays).toBe(7);
  });

  it("ignores non-positive durations rather than skewing percentiles", () => {
    const r = buildBenchmarkReport([row({ durationMs: 0 }), row({ durationMs: 5_000 })]);
    expect(r.durationMs.p50).toBe(5_000);
    expect(r.durationMs.max).toBe(5_000);
  });
});

describe("top failures (TaskFailure wiring)", () => {
  const fail = (over: Partial<BenchmarkFailureRow> = {}): BenchmarkFailureRow => ({
    kind: "typecheck",
    detail: "TS2322: Type mismatch",
    count: 1,
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    resolvedAt: null,
    ...over,
  });

  it("orders by recurrence, worst first", () => {
    const r = buildBenchmarkReport([row()], {
      failures: [fail({ count: 2 }), fail({ detail: "flaky", count: 19 }), fail({ count: 5 })],
    });
    expect(r.topFailures.map((f) => f.count)).toEqual([19, 5, 2]);
  });

  it("excludes resolved signatures — a fixed bug is not a live problem", () => {
    const r = buildBenchmarkReport([row()], {
      failures: [
        fail({ detail: "already fixed", count: 99, resolvedAt: new Date() }),
        fail({ detail: "still live", count: 1 }),
      ],
    });
    expect(r.topFailures).toHaveLength(1);
    expect(r.topFailures[0].detail).toBe("still live");
  });

  it("respects the display limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => fail({ detail: `e${i}`, count: i + 1 }));
    const r = buildBenchmarkReport([row()], { failures: many, topFailureLimit: 3 });
    expect(r.topFailures).toHaveLength(3);
  });

  it("is empty when no failures are supplied (default window)", () => {
    expect(buildBenchmarkReport([row()]).topFailures).toEqual([]);
  });

  it("renders the recurring failures in the formatted report", () => {
    const out = formatBenchmarkReport(
      buildBenchmarkReport([row()], { failures: [fail({ count: 7, detail: "TS2345" })] })
    );
    expect(out).toContain("Top unresolved failures");
    expect(out).toContain("7x [typecheck] TS2345");
  });

  it("truncates a very long detail so one failure cannot flood the report", () => {
    const out = formatBenchmarkReport(
      buildBenchmarkReport([row()], { failures: [fail({ detail: "x".repeat(400) })] })
    );
    expect(out).toContain("…");
  });
});

describe("formatBenchmarkReport", () => {
  it("renders a readable report and flags the absence of passes", () => {
    const out = formatBenchmarkReport(buildBenchmarkReport([row({ browserLane: "fail" })], { windowDays: 7 }));
    expect(out).toContain("last 7d");
    expect(out).toContain("Hard passes 0");
    expect(out).toContain("finished but failed a verification lane");
    expect(out).toContain("Cost per hard PASS n/a");
  });

  it("surfaces per-hard-pass cost when there are passes", () => {
    const out = formatBenchmarkReport(buildBenchmarkReport([row()]));
    expect(out).toContain("headline number");
    expect(out).toMatch(/Cost per hard PASS \$/);
  });
});