// benchmark-report.ts — Cost-adjusted benchmark report over the TaskRun
// ledger (task_runs). Answers the question the raw run list can't: what does
// a PASSED task actually cost, and is that cost trending the right way for
// the token-efficiency machinery (compaction savings) to matter?
//
// Cost model: the ledger stores modelCalls (not raw token counts), so cost
// is ESTIMATED as modelCalls × avgTokensPerCall through estimateCostFromTotal
// (70/30 in/out split — same assumption as the live spend display). avgTokens
// per call defaults to 3500 (the executor's per-turn transcript budget is
// ~5.1k; observed traffic runs lower) and is overridable via
// ORPLEX_AVG_TOKENS_PER_CALL. Ambient reporting only — never billing, per
// cost-estimator.ts's contract.
//
// Pure core (buildBenchmarkReport / formatBenchmarkReport) is unit-tested;
// scripts/bench-report.mjs supplies the prisma rows via `npm run bench:report`.

import { estimateCostFromTotal, formatCost } from "./cost-estimator";

export interface BenchRunRow {
  finalStatus: string; // done | error | aborted
  mode: string;
  typecheckLane: string; // pass | fail | skipped
  browserLane: string;
  swarmLane: string;
  modelCalls: number;
  tokensSaved: number;
  durationMs: number;
  createdAt: Date | string;
}

export interface BenchmarkReport {
  totalRuns: number;
  done: number;
  failed: number; // error + aborted
  /** Share of runs whose task completed (finalStatus "done"). */
  passRate: number; // 0..1
  /** Hard-verdict mix, A2 semantics: done AND no lane failed. */
  hardPassed: number;
  hardFailed: number;
  lanes: Record<"typecheck" | "browser" | "swarm", { pass: number; fail: number; skipped: number }>;
  durationMs: { median: number; p90: number };
  modelCalls: { total: number; median: number };
  tokensSaved: { total: number; median: number };
  /** Estimated USD (see cost model in the header comment). */
  cost: {
    totalUsd: number;
    medianPerRunUsd: number;
    perHardPassUsd: number;
    avgTokensPerCall: number;
    estimated: true;
  };
  byMode: Array<{ mode: string; runs: number; hardPassed: number; costUsd: number; medianDurationMs: number }>;
  windowDays: number | null;
}

const LANE_KEYS = ["typecheck", "browser", "swarm"] as const;

function laneCount(rows: BenchRunRow[], lane: (typeof LANE_KEYS)[number], value: string): number {
  const key = `${lane}Lane` as keyof BenchRunRow;
  return rows.filter((r) => r[key] === value).length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Build the aggregate report. opts.windowDays limits to recent rows (the CLI
 * passes a date-bounded set; when null, use everything given).
 */
export function buildBenchmarkReport(
  rows: BenchRunRow[],
  opts?: { windowDays?: number | null; avgTokensPerCall?: number }
): BenchmarkReport {
  const windowDays = opts?.windowDays ?? null;
  let scoped = rows;
  if (windowDays != null) {
    const cutoff = Date.now() - windowDays * 86_400_000;
    scoped = rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
  }
  const runs = scoped;
  const total = runs.length;
  const done = runs.filter((r) => r.finalStatus === "done").length;
  const failed = total - done;
  // A2 hard verdicts recomputed from lane outcomes: done AND no fail
  // (skipped lanes never fail — computeVerdict semantics).
  const hardPassed = runs.filter(
    (r) => r.finalStatus === "done" && LANE_KEYS.every((l) => r[`${l}Lane` as keyof BenchRunRow] !== "fail")
  ).length;

  const avgTokensPerCall =
    opts?.avgTokensPerCall ??
    (Number(process.env.ORPLEX_AVG_TOKENS_PER_CALL) > 0 ? Number(process.env.ORPLEX_AVG_TOKENS_PER_CALL) : 3500);
  const runCost = (r: BenchRunRow) => estimateCostFromTotal(Math.max(0, r.modelCalls) * avgTokensPerCall);

  const durations = runs.map((r) => Math.max(0, r.durationMs)).filter((d) => d > 0);
  const calls = runs.map((r) => r.modelCalls).filter((c) => c > 0);
  const saved = runs.map((r) => r.tokensSaved).filter((s) => s > 0);
  const totalCost = runs.reduce((s, r) => s + runCost(r), 0);

  const modeMap = new Map<string, BenchRunRow[]>();
  for (const r of runs) {
    const arr = modeMap.get(r.mode) || [];
    arr.push(r);
    modeMap.set(r.mode, arr);
  }
  const byMode = [...modeMap.entries()]
    .map(([mode, rs]) => ({
      mode,
      runs: rs.length,
      hardPassed: rs.filter(
        (r) => r.finalStatus === "done" && LANE_KEYS.every((l) => r[`${l}Lane` as keyof BenchRunRow] !== "fail")
      ).length,
      costUsd: rs.reduce((s, r) => s + runCost(r), 0),
      medianDurationMs: median(rs.map((r) => r.durationMs)),
    }))
    .sort((a, b) => b.runs - a.runs);

  return {
    totalRuns: total,
    done,
    failed,
    passRate: total > 0 ? done / total : 0,
    hardPassed,
    hardFailed: total - hardPassed,
    lanes: {
      typecheck: { pass: laneCount(runs, "typecheck", "pass"), fail: laneCount(runs, "typecheck", "fail"), skipped: laneCount(runs, "typecheck", "skipped") },
      browser: { pass: laneCount(runs, "browser", "pass"), fail: laneCount(runs, "browser", "fail"), skipped: laneCount(runs, "browser", "skipped") },
      swarm: { pass: laneCount(runs, "swarm", "pass"), fail: laneCount(runs, "swarm", "fail"), skipped: laneCount(runs, "swarm", "skipped") },
    },
    durationMs: { median: median(durations), p90: percentile(durations, 0.9) },
    modelCalls: { total: runs.reduce((s, r) => s + Math.max(0, r.modelCalls), 0), median: median(calls) },
    tokensSaved: { total: runs.reduce((s, r) => s + Math.max(0, r.tokensSaved), 0), median: median(saved) },
    cost: {
      totalUsd: totalCost,
      medianPerRunUsd: median(runs.map(runCost)),
      perHardPassUsd: hardPassed > 0 ? totalCost / hardPassed : 0,
      avgTokensPerCall,
      estimated: true,
    },
    byMode,
    windowDays,
  };
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const m = ms / 60_000;
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function laneStr(l: { pass: number; fail: number; skipped: number }): string {
  return `${l.pass} pass / ${l.fail} fail / ${l.skipped} skip`;
}

/** Human-readable report — verdict-first, in the A2 house style. */
export function formatBenchmarkReport(r: BenchmarkReport): string {
  if (r.totalRuns === 0) {
    return "=== Orplex benchmark report ===\nNo runs in scope — nothing to report yet.";
  }
  const lines: string[] = [];
  lines.push("=== Orplex benchmark report (cost-adjusted) ===");
  lines.push(
    `Scope: ${r.totalRuns} run(s)${r.windowDays != null ? ` (last ${r.windowDays} day(s))` : ""} — ${r.hardPassed}/${r.totalRuns} hard-PASSED`
  );
  lines.push(
    `Outcomes: ${r.done} done · ${r.failed} error/aborted — pass rate ${(r.passRate * 100).toFixed(1)}%`
  );
  lines.push(
    `Lanes — typecheck ${laneStr(r.lanes.typecheck)} · browser ${laneStr(r.lanes.browser)} · swarm ${laneStr(r.lanes.swarm)}`
  );
  lines.push(
    `Duration: median ${fmtDuration(r.durationMs.median)} · p90 ${fmtDuration(r.durationMs.p90)}`
  );
  lines.push(
    `Model calls: ${r.modelCalls.total} total · median ${r.modelCalls.median}/run — tokens saved (compaction): ${Math.round(r.tokensSaved.total).toLocaleString()} total · median ${Math.round(r.tokensSaved.median).toLocaleString()}/run`
  );
  lines.push(
    `Cost (ESTIMATED at ~${r.cost.avgTokensPerCall} tok/call, 70/30 in-out): ${formatCost(r.cost.totalUsd)} total · ${formatCost(r.cost.medianPerRunUsd)}/run median · ${formatCost(r.cost.perHardPassUsd)} per hard-PASS`
  );
  if (r.byMode.length > 0) {
    lines.push("By mode:");
    for (const m of r.byMode) {
      lines.push(
        `  ${m.mode}: ${m.runs} run(s), ${m.hardPassed} hard-PASS, ${formatCost(m.costUsd)}, median ${fmtDuration(m.medianDurationMs)}`
      );
    }
  }
  lines.push("Costs are ambient estimates from model-call counts — not billing data.");
  return lines.join("\n");
}
