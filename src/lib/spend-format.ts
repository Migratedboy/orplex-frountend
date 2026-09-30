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

// === Provider uptime telemetry (7-day reliability view) =====================

/** One recorded provider attempt (raw event row, as returned by /api/agent/uptime). */
export interface UptimeEvent {
  lane: string;
  provider: string;
  model: string;
  outcome: "ok" | "error";
  errorKind: string | null;
  createdAt: string;
}

export interface UptimeModelRow {
  model: string;
  ok: number;
  errors: number;
  /** Error-kind → count, most frequent first ("rate_limit", "auth", …). */
  errorKinds: Record<string, number>;
}

export interface UptimeProviderRow {
  provider: string;
  models: UptimeModelRow[];
  ok: number;
  errors: number;
  /** Success rate 0–100 over ok+errors; null when the provider has no attempts. */
  successPct: number | null;
}

export interface UptimeSummary {
  providers: UptimeProviderRow[];
  windowDays: number;
  totalOk: number;
  totalErrors: number;
}

/**
 * Aggregate raw provider-attempt events into the reliability view: per
 * provider (and per model under it) attempt counts, success rate, and the
 * dominant error kinds. Events outside the window (default 7 days) are
 * dropped; malformed timestamps are dropped rather than guessed. Rows sort
 * healthiest-first (fewest errors, then busiest, then name) so the provider
 * you should look at is at the bottom.
 */
export function summarizeUptime(events: UptimeEvent[], windowDays = 7, nowMs: number = Date.now()): UptimeSummary {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const byProvider = new Map<string, { models: Map<string, UptimeModelRow>; ok: number; errors: number }>();
  for (const e of events) {
    const t = new Date(e.createdAt).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const provider = e.provider || "unknown";
    let p = byProvider.get(provider);
    if (!p) {
      p = { models: new Map(), ok: 0, errors: 0 };
      byProvider.set(provider, p);
    }
    const modelKey = e.model || "unknown";
    let m = p.models.get(modelKey);
    if (!m) {
      m = { model: modelKey, ok: 0, errors: 0, errorKinds: {} };
      p.models.set(modelKey, m);
    }
    if (e.outcome === "error") {
      p.errors += 1;
      m.errors += 1;
      const kind = e.errorKind || "error";
      m.errorKinds[kind] = (m.errorKinds[kind] ?? 0) + 1;
    } else {
      p.ok += 1;
      m.ok += 1;
    }
  }
  const providers: UptimeProviderRow[] = [...byProvider.entries()]
    .map(([provider, p]) => {
      const models: UptimeModelRow[] = [...p.models.values()]
        .map((m) => ({
          model: m.model,
          ok: m.ok,
          errors: m.errors,
          errorKinds: Object.fromEntries(
            Object.entries(m.errorKinds).sort((a, b) => b[1] - a[1])
          ),
        }))
        .sort((a, b) => a.errors - b.errors || b.ok - a.ok || a.model.localeCompare(b.model));
      const total = p.ok + p.errors;
      return {
        provider,
        models,
        ok: p.ok,
        errors: p.errors,
        successPct: total > 0 ? Math.round((p.ok / total) * 100) : null,
      };
    })
    .sort((a, b) => a.errors - b.errors || b.ok - a.ok || a.provider.localeCompare(b.provider));
  return {
    providers,
    windowDays,
    totalOk: providers.reduce((s, p) => s + p.ok, 0),
    totalErrors: providers.reduce((s, p) => s + p.errors, 0),
  };
}

/** Traffic-light for a provider row: ≥95 green, ≥80 amber, else red; no data → none. */
export function uptimeHealth(successPct: number | null): "green" | "amber" | "red" | "none" {
  if (successPct == null) return "none";
  if (successPct >= 95) return "green";
  if (successPct >= 80) return "amber";
  return "red";
}
