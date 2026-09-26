// spend-format.ts — Pure presentation helpers for the provider & cost tab in
// Settings. Shapes the per-run spend history returned by /api/agent/spend and
// computes everything the dependency-free SVG bar chart needs. Deterministic
// data-in, data-out — unit-testable without React or the DB (same rules as
// board-format.ts).

import { estimateCostFromTotal } from "@/lib/cost-estimator";

/** One historical run's metering as returned by /api/agent/spend. */
export interface SpendRun {
  id: string;
  /** ISO timestamp of run creation; malformed values sort last. */
  createdAt: string;
  /** Combined prompt+completion tokens from the AgentRun.tokenUsage column. */
  totalTokens: number;
  /** Prompt/completion split from run.result.tokenUsage; null when unknown. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** Provider that actually served the run (failover-aware); null when unknown. */
  provider: string | null;
  /** Effective model: per-run override or the provider default. */
  model: string;
  status: string;
}

/** Sorted oldest→newest. Zero-token runs are dropped — they carry no spend. */
export function sortSpendRuns(runs: SpendRun[]): SpendRun[] {
  const kept = runs.filter((r) => (Number(r.totalTokens) || 0) > 0);
  return kept.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    const fa = Number.isFinite(ta) ? ta : Infinity;
    const fb = Number.isFinite(tb) ? tb : Infinity;
    return fa - fb;
  });
}

/** Cost estimate for one run using the shared estimator (ambient display only). */
export function spendRunCostUsd(run: Pick<SpendRun, "totalTokens" | "model">): number {
  return estimateCostFromTotal(Number(run.totalTokens) || 0, run.model);
}

export interface SpendAggregates {
  runCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

/**
 * Totals across the history. Split tokens are summed from the run's
 * prompt/completion fields; runs without a split contribute their combined
 * total only (prompt/completion sums may then undershoot totalTokens —
 * "unknown split", displayed as such).
 */
export function spendAggregates(runs: SpendRun[]): SpendAggregates {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  for (const r of runs) {
    const total = Number(r.totalTokens) || 0;
    totalTokens += total;
    estimatedCostUsd += spendRunCostUsd(r);
    const p = Number(r.promptTokens) || 0;
    const c = Number(r.completionTokens) || 0;
    if (p > 0 || c > 0) {
      promptTokens += p;
      completionTokens += c;
    }
  }
  return {
    runCount: runs.length,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostUsd,
  };
}

/** true when the prompt/completion sums miss some of the combined total. */
export function splitIsPartial(aggregates: SpendAggregates): boolean {
  return aggregates.promptTokens + aggregates.completionTokens < aggregates.totalTokens;
}

/**
 * Group runs by calendar day and sum tokens. Input must already be sorted
 * oldest→newest (sortSpendRuns). Days with no runs between the first and last
 * active day are emitted with zero tokens so the chart shows real gaps.
 */
export function dailySpendBars(runs: SpendRun[]): { day: string; label: string; tokens: number; costUsd: number; runCount: number }[] {
  if (runs.length === 0) return [];
  const byDay = new Map<string, { tokens: number; costUsd: number; runCount: number }>();
  let first = Infinity;
  let last = -Infinity;
  for (const r of runs) {
    const t = new Date(r.createdAt).getTime();
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const entry = byDay.get(key) || { tokens: 0, costUsd: 0, runCount: 0 };
    entry.tokens += Number(r.totalTokens) || 0;
    entry.costUsd += spendRunCostUsd(r);
    entry.runCount += 1;
    byDay.set(key, entry);
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const lastD = new Date(last);
  const lastKey = `${lastD.getFullYear()}-${String(lastD.getMonth() + 1).padStart(2, "0")}-${String(lastD.getDate()).padStart(2, "0")}`;
  const bars: { day: string; label: string; tokens: number; costUsd: number; runCount: number }[] = [];
  // Walk one day at a time from first to last (DST shifts make the wall-clock
  // date the source of truth, not elapsed time), emitting zero rows for gap
  // days so the chart shows real holes in activity.
  const cursor = new Date(first);
  cursor.setHours(12, 0, 0, 0); // noon avoids most DST edges
  for (;;) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const entry = byDay.get(key) || { tokens: 0, costUsd: 0, runCount: 0 };
    bars.push({ day: key, label: `${cursor.getMonth() + 1}/${cursor.getDate()}`, ...entry });
    if (key === lastKey) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return bars;
}

export interface ChartScale {
  /** Pixel height of the tallest bar; every other bar is proportional. */
  peakHeight: number;
  /** Max tokens across bars; 0 for empty/flat data. */
  maxTokens: number;
  /** Bar height in px for a bar with `tokens` tokens (0 when flat). */
  heightFor(tokens: number): number;
}

/** Bar-height scale shared by the daily chart so bars are comparable. */
export function chartScale(bars: { tokens: number }[], peakHeight: number): ChartScale {
  const maxTokens = bars.reduce((m, b) => Math.max(m, Number(b.tokens) || 0), 0);
  return {
    peakHeight,
    maxTokens,
    heightFor(tokens: number): number {
      if (maxTokens <= 0) return 0;
      const v = Math.max(0, Number(tokens) || 0);
      // Round up so the tallest bar hits peak exactly and empties stay empty.
      return Math.min(peakHeight, Math.max(v > 0 ? 1 : 0, Math.round((v / maxTokens) * peakHeight)));
    },
  };
}
