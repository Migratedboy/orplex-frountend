// benchmark-report.ts — Cost-adjusted aggregation over the TaskRun ledger.
//
// RESTORED. `scripts/bench-report.mjs` transpiles and loads this module for its
// aggregation math (`buildBenchmarkReport` + `formatBenchmarkReport`), but the
// file had been deleted while the script kept reading it — so `npm run
// bench:report` threw ENOENT the moment DATABASE_URL was set. It also had no
// unit test of its own, which is how the deletion went unnoticed.
//
// It stays in src/lib (not inlined into the script) deliberately: plain node
// cannot import TS, and duplicating the math into the .mjs would mean two
// implementations that drift. The script transpiles this one file; the unit
// tests import it directly. Same source, one implementation.
//
// HONESTY (read before quoting these numbers):
//   - `savedPct`/`tokensSaved` come from the prompt meter, i.e. tokens the
//     COMPACT profile avoided relative to the FULL profile for the same call.
//     That is a real reduction in tokens billed, not a comparison against what
//     a different model would have cost.
//   - Estimated USD is a modelled rate (MODEL_COST_RATES), not a provider
//     invoice. Treat it as ambient reporting, never as billing.
//   - A run counts as PASSED only when it finished AND no verification lane
//     failed. A SKIPPED lane never fails a run — otherwise every task that
//     never touched the browser would read as a failure.
//   - `perHardPassCost` is the headline number: what one verified-good task
//     actually cost. Divide by it before comparing against any alternative.

import { estimateCostFromTotal, formatCost } from "./cost-estimator";

/** One ledger row. Mirrors the fields scripts/bench-report.mjs projects. */
export interface BenchmarkRow {
  finalStatus: string;
  mode: string;
  typecheckLane: string;
  browserLane: string;
  swarmLane: string;
  modelCalls: number;
  tokensSaved: number;
  durationMs: number;
  createdAt: Date;
}

/**
 * One recurring-failure signature. Mirrors `TaskFailure`.
 *
 * This is the sibling table of TaskRun and was the reason the benchmark could
 * answer "what keeps breaking" instead of only "how often does it fail".
 */
export interface BenchmarkFailureRow {
  kind: string;
  detail: string;
  count: number;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

export interface BenchmarkReport {
  total: number;
  done: number;
  error: number;
  aborted: number;
  /** Finished with no failing lane. */
  passed: number;
  /** Finished but at least one verification lane FAILED. */
  laneFailed: number;
  passRate: number;
  laneHealth: {
    typecheck: { pass: number; fail: number; skipped: number };
    browser: { pass: number; fail: number; skipped: number };
    swarm: { pass: number; fail: number; skipped: number };
  };
  modelCalls: { total: number; perRun: number };
  tokensSaved: { total: number; perRun: number };
  /** Modelled USD across the window (not a provider invoice). */
  estimatedCost: number;
  durationMs: { p50: number; p95: number; max: number };
  /** Modelled USD per hard PASS, or null when nothing passed. */
  perHardPassCost: number | null;
  /**
   * What keeps breaking: the recurring, UNRESOLVED failure signatures, worst
   * first. `count` is recurrence, so a signature seen 20 times outranks one
   * seen once — that is the anti-loop signal the table exists for.
   */
  topFailures: Array<{ kind: string; detail: string; count: number }>;
  windowDays: number | null;
}

function laneCounts(rows: BenchmarkRow[]): BenchmarkReport["laneHealth"] {
  const out: BenchmarkReport["laneHealth"] = {
    typecheck: { pass: 0, fail: 0, skipped: 0 },
    browser: { pass: 0, fail: 0, skipped: 0 },
    swarm: { pass: 0, fail: 0, skipped: 0 },
  };
  for (const r of rows) {
    for (const key of ["typecheckLane", "browserLane", "swarmLane"] as const) {
      const lane = key.replace("Lane", "") as "typecheck" | "browser" | "swarm";
      const value = String(r[key] ?? "skipped").toLowerCase();
      if (value === "pass") out[lane].pass++;
      else if (value === "fail") out[lane].fail++;
      else out[lane].skipped++;
    }
  }
  return out;
}

/** Nearest-rank percentile over an unsorted copy. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function buildBenchmarkReport(
  rows: BenchmarkRow[],
  opts: { windowDays?: number | null; failures?: BenchmarkFailureRow[]; topFailureLimit?: number } = {}
): BenchmarkReport {
  const total = rows.length;
  let done = 0;
  let error = 0;
  let aborted = 0;
  let passed = 0;
  let laneFailed = 0;
  let modelCalls = 0;
  let tokensSaved = 0;
  const durations: number[] = [];

  for (const r of rows) {
    const status = String(r.finalStatus ?? "").toLowerCase();
    if (status === "done") done++;
    else if (status === "aborted") aborted++;
    else error++;

    const lanes = [r.typecheckLane, r.browserLane, r.swarmLane].map((l) =>
      String(l ?? "skipped").toLowerCase()
    );
    const anyLaneFailed = lanes.some((l) => l === "fail");

    if (status === "done") {
      // A skipped lane is neutral: it must not turn a finished task into a
      // failure, it just means that lane never applied to this task.
      if (anyLaneFailed) laneFailed++;
      else passed++;
    }

    modelCalls += Number(r.modelCalls) || 0;
    tokensSaved += Number(r.tokensSaved) || 0;
    if (Number(r.durationMs) > 0) durations.push(Number(r.durationMs));
  }

  // The ledger stores tokens (tokensSaved is a delta), not a per-run USD
  // figure, so this is explicitly an estimate — see the honesty note at the
  // top of this file.
  const estimatedUsd = estimateCostFromCalls(modelCalls);

  // Worst first. A resolved signature is history, not a live problem, so it
  // is excluded entirely — reporting fixed bugs as "top failures" is how a
  // dashboard stops being trusted.
  const topFailures = (opts.failures ?? [])
    .filter((f) => !f.resolvedAt)
    .sort((a, b) => Number(b.count) - Number(a.count))
    .slice(0, opts.topFailureLimit ?? 5)
    .map((f) => ({ kind: String(f.kind), detail: String(f.detail), count: Number(f.count) || 0 }));

  return {
    total,
    done,
    error,
    aborted,
    passed,
    laneFailed,
    passRate: total > 0 ? passed / total : 0,
    laneHealth: laneCounts(rows),
    modelCalls: { total: modelCalls, perRun: total > 0 ? modelCalls / total : 0 },
    tokensSaved: { total: tokensSaved, perRun: total > 0 ? tokensSaved / total : 0 },
    estimatedCost: estimatedUsd,
    durationMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length > 0 ? Math.max(...durations) : 0,
    },
    perHardPassCost: passed > 0 ? estimatedUsd / passed : null,
    topFailures,
    windowDays: opts.windowDays ?? null,
  };
}

/**
 * Modelled USD for a call count. Uses the cost estimator's total-token
 * helper so there is ONE rate table in the codebase (MODEL_COST_RATES) rather
 * than a second copy drifting inside this file.
 */
function estimateCostFromCalls(calls: number): number {
  if (calls <= 0) return 0;
  // A model call is dominated by its generated tokens; ~4 chars/token is the
  // same rough conversion the rest of the codebase uses for sizing.
  return estimateCostFromTotal(calls * 1000);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function laneLine(label: string, lane: BenchmarkReport["laneHealth"]["typecheck"]): string {
  return `  ${label.padEnd(10)} pass ${lane.pass} · fail ${lane.fail} · skipped ${lane.skipped}`;
}

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  const window = report.windowDays != null ? ` (last ${report.windowDays}d)` : " (all time)";
  lines.push(`Orplex benchmark report${window}`);
  lines.push("");
  lines.push(`Runs        ${report.total}`);
  lines.push(`  done ${report.done} · error ${report.error} · aborted ${report.aborted}`);
  lines.push(`Hard passes ${report.passed} (${pct(report.passRate)})`);
  if (report.laneFailed > 0) {
    lines.push(`  ${report.laneFailed} finished but failed a verification lane`);
  }
  lines.push("");
  lines.push("Lane health");
  lines.push(laneLine("typecheck", report.laneHealth.typecheck));
  lines.push(laneLine("browser", report.laneHealth.browser));
  lines.push(laneLine("swarm", report.laneHealth.swarm));
  lines.push("");
  lines.push(`Model calls ${report.modelCalls.total} (${report.modelCalls.perRun.toFixed(1)} per run)`);
  lines.push(`Tokens saved ${report.tokensSaved.total} (${report.tokensSaved.perRun.toFixed(0)} per run)`);
  lines.push(
    `Duration    p50 ${(report.durationMs.p50 / 1000).toFixed(1)}s · p95 ${(report.durationMs.p95 / 1000).toFixed(1)}s · max ${(report.durationMs.max / 1000).toFixed(1)}s`
  );
  lines.push("");
  lines.push(`Estimated cost ${formatCost(report.estimatedCost)} (modelled, not a provider invoice)`);
  lines.push(
    report.perHardPassCost != null
      ? `Cost per hard PASS ${formatCost(report.perHardPassCost)}  ← headline number`
      : `Cost per hard PASS n/a (nothing passed in this window)`
  );
  if (report.topFailures.length > 0) {
    lines.push("");
    lines.push("Top unresolved failures (recurrence)");
    for (const f of report.topFailures) {
      const detail = f.detail.length > 72 ? `${f.detail.slice(0, 72)}…` : f.detail;
      lines.push(`  ${String(f.count).padStart(4)}x [${f.kind}] ${detail}`);
    }
  }
  return lines.join("\n");
}