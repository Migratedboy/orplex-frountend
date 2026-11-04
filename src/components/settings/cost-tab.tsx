"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api-base";
import { formatTokens } from "@/lib/board-format";
import { estimateCostFromTotal, formatCost } from "@/lib/cost-estimator";
import { chartScale, dailySpendBars, splitIsPartial, uptimeHealth } from "@/lib/spend-format";
import type { SpendAggregates, SpendRun, UptimeSummary } from "@/lib/spend-format";

interface SpendProviderInfo {
  provider: string;
  model: string;
  keyPresent: boolean;
  budgetMode: string;
  keyEnvVar: string;
  knownProvider: boolean;
}

interface SpendData {
  history: SpendRun[];
  totals: SpendAggregates;
  provider: SpendProviderInfo;
}

// === Provider reliability (7-day uptime telemetry) card ====================
// Rendered from the pure summarizeUptime aggregation served by
// /api/agent/uptime. Traffic-light per provider, per-model breakdown with
// dominant error kinds — so a degraded free tier is visible before it eats
// an afternoon.

const UPTIME_DOT: Record<ReturnType<typeof uptimeHealth>, { color: string; bg: string }> = {
  green: { color: "var(--st-done-fg)", bg: "rgba(16,185,129,.15)" },
  amber: { color: "var(--st-warn-fg)", bg: "rgba(217,119,6,.12)" },
  red: { color: "var(--st-error-fg)", bg: "rgba(239,68,68,.12)" },
  none: { color: "var(--text-tertiary)", bg: "rgba(156,163,175,.15)" },
};

function ReliabilityCard({ uptime }: { uptime: UptimeSummary | null }) {
  if (!uptime || uptime.providers.length === 0) return null;
  return (
    <div className="settings-card" style={{ marginTop: 16 }}>
      <div className="spend-table">
        <div className="spend-table-row spend-table-head">
          <span>Provider</span><span>Models</span><span style={{ textAlign: "right" }}>OK / Errors</span><span style={{ textAlign: "right" }}>Success</span>
        </div>
        {uptime.providers.map((p) => {
          const health = uptimeHealth(p.successPct);
          const dot = UPTIME_DOT[health];
          return (
            <div key={p.provider} className="spend-table-row">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  aria-hidden
                  title={`${health === "none" ? "no attempts" : `${p.successPct}% success`} over ${uptime.windowDays} days`}
                  style={{ width: 8, height: 8, borderRadius: "50%", background: dot.color, boxShadow: `0 0 0 3px ${dot.bg}`, flex: "0 0 auto" }}
                />
                {p.provider}
              </span>
              <span className="spend-table-mono" style={{ fontSize: 12 }}>
                {p.models.map((m) => {
                  const total = m.ok + m.errors;
                  const pct = total > 0 ? Math.round((m.ok / total) * 100) : 0;
                  const topErrors = Object.entries(m.errorKinds).slice(0, 2)
                    .map(([k, c]) => `${k} ×${c}`).join(", ");
                  return (
                    <div key={m.model} title={topErrors ? `top errors: ${topErrors}` : "no errors recorded"}>
                      {m.model.split("/").pop()} — {pct}%{m.errors > 0 && topErrors ? ` (${topErrors})` : ""}
                    </div>
                  );
                })}
              </span>
              <span style={{ textAlign: "right" }} className="spend-table-mono">{p.ok} / {p.errors}</span>
              <span style={{ textAlign: "right" }}>
                <span style={{
                  color: dot.color,
                  background: dot.bg,
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontWeight: 600,
                }}>{p.successPct == null ? "—" : `${p.successPct}%`}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="settings-hint" style={{ marginTop: 10 }}>
        Attempts recorded over the last {uptime.windowDays} days ({uptime.totalOk} ok, {uptime.totalErrors} failed). Health: ≥95% green, ≥80% amber, below red.
      </p>
    </div>
  );
}

function SettingsCostTab() {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 7-day provider reliability (uptime telemetry from provider_events).
  const [uptime, setUptime] = useState<UptimeSummary | null>(null);

  const fetchSpend = async () => {
    try {
      const res = await apiFetch("/api/agent/spend");
      const json = await res.json();
      if (res.ok && json.success) {
        setData(json);
        setError("");
      } else {
        setError(json.error || "Failed to load usage");
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  };

  const fetchUptime = async () => {
    try {
      const res = await apiFetch("/api/agent/uptime");
      const json = await res.json();
      if (res.ok && json.success) setUptime(json.summary as UptimeSummary);
    } catch {
      // Reliability view is best-effort; the spend tab works without it.
    }
  };

  useEffect(() => { fetchSpend(); fetchUptime(); }, []);

  const bars = data ? dailySpendBars(data.history) : [];
  const scale = chartScale(bars, 96);
  const totals = data?.totals;
  const provider = data?.provider;
  const recent = data ? [...data.history].slice(-15).reverse() : [];

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h2 className="settings-section-title">Provider &amp; Cost</h2>
        <p className="settings-section-desc">Which provider serves your runs, plus token usage and estimated spend per run. Estimates use list-price rates — never a bill.</p>
      </div>

      <div className="settings-card">
        {provider ? (
          <div className="settings-about-grid">
            <div className="settings-about-item">
              <span className="settings-about-label">Provider</span>
              <span className="settings-about-value">{provider.provider}{provider.budgetMode === "free" ? " (free tier)" : " (BYOK)"}</span>
            </div>
            <div className="settings-about-item">
              <span className="settings-about-label">Default model</span>
              <span className="settings-about-value">{provider.model}</span>
            </div>
            <div className="settings-about-item">
              <span className="settings-about-label">API key</span>
              <span className="settings-about-value">{provider.keyPresent ? "configured" : "not set"}</span>
            </div>
            <div className="settings-about-item">
              <span className="settings-about-label">Runs metered</span>
              <span className="settings-about-value">{totals ? totals.runCount : 0}</span>
            </div>
          </div>
        ) : (
          <p className="settings-hint">Provider info unavailable.</p>
        )}
      </div>

      <ReliabilityCard uptime={uptime} />

      <div className="settings-card" style={{ marginTop: 16 }}>
        {loading ? (
          <p className="settings-hint">Loading usage...</p>
        ) : error ? (
          <p className="settings-hint" style={{ color: "var(--st-error-fg)" }}>{error}</p>
        ) : bars.length === 0 ? (
          <p className="settings-hint">No token usage recorded yet — run an agent task and it will show up here.</p>
        ) : (
          <>
            {totals && (
              <div className="settings-about-grid" style={{ marginBottom: 16 }}>
                <div className="settings-about-item">
                  <span className="settings-about-label">Total tokens</span>
                  <span className="settings-about-value">{formatTokens(totals.totalTokens)}</span>
                </div>
                <div className="settings-about-item">
                  <span className="settings-about-label">Prompt / completion</span>
                  <span className="settings-about-value">{formatTokens(totals.promptTokens)} / {formatTokens(totals.completionTokens)}{splitIsPartial(totals) ? " (partial)" : ""}</span>
                </div>
                <div className="settings-about-item">
                  <span className="settings-about-label">Estimated spend</span>
                  <span className="settings-about-value">{formatCost(totals.estimatedCostUsd)}</span>
                </div>
              </div>
            )}
            <div className="spend-chart" role="img" aria-label={`Daily token usage across ${bars.length} day(s), peak ${formatTokens(scale.maxTokens)} tokens`}>
              {bars.map((b) => (
                <div key={b.day} className="spend-chart-col" title={`${b.label}: ${formatTokens(b.tokens)} tokens · ${formatCost(b.costUsd)} est · ${b.runCount} run(s)`}>
                  <div className="spend-chart-bar" style={{ height: `${scale.heightFor(b.tokens)}px` }} />
                  <span className="spend-chart-label">{b.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {!loading && !error && recent.length > 0 && (
        <div className="settings-card" style={{ marginTop: 16 }}>
          <div className="spend-table">
            <div className="spend-table-row spend-table-head">
              <span>When</span><span>Model</span><span>Provider</span><span style={{ textAlign: "right" }}>Tokens</span><span style={{ textAlign: "right" }}>Est. cost</span>
            </div>
            {recent.map((r) => (
              <div key={r.id} className="spend-table-row">
                <span>{new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="spend-table-mono" title={r.model}>{r.model}</span>
                <span>{r.provider || "—"}</span>
                <span style={{ textAlign: "right" }} title={r.promptTokens != null ? `prompt ${formatTokens(r.promptTokens)} + completion ${formatTokens(r.completionTokens ?? 0)}` : undefined}>{formatTokens(r.totalTokens)}</span>
                <span style={{ textAlign: "right" }}>{formatCost(estimateCostFromTotal(r.totalTokens, r.model))}</span>
              </div>
            ))}
          </div>
          <button onClick={fetchSpend} className="settings-save-btn" style={{ marginTop: 12 }}>Refresh</button>
        </div>
      )}
    </div>
  );}

export { SettingsCostTab };
