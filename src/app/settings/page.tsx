"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { IconCheck } from "@/components/Icons";
import { formatTokens } from "@/lib/board-format";
import { estimateCostFromTotal, formatCost } from "@/lib/cost-estimator";
import { chartScale, dailySpendBars, splitIsPartial, uptimeHealth } from "@/lib/spend-format";
import type { SpendAggregates, SpendRun, UptimeSummary } from "@/lib/spend-format";
import { listProviderDefs, type ProviderDef } from "@/lib/provider-registry";
import type { ListedModel } from "@/lib/provider-models";

interface UserKey {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  apiKeyMasked: string;
  isActive: boolean;
  usageToday: number;
  createdAt: string;
  verified?: boolean;
  lastVerifiedAt?: string | null;
  modelsFetchedAt?: string | null;
  cachedModelCount?: number | null;
}

const PROVIDER_DEFS = listProviderDefs();

// === Warm models (cold-start wake engine) card =============================
// NVIDIA build.farm cold-loads a model's function on first invocation: the
// first request can hang for minutes, then the model works fine forever.
// Cold models are hidden from the picker until the wake engine proves them —
// this card makes that invisible process visible and manually kickable.

interface WakeModelStateUI {
  id: string;
  state: "waking" | "woke" | "dead" | "failed";
  attempt: number;
  totalAttempts: number;
}

const WAKE_STATE_STYLE: Record<WakeModelStateUI["state"], { label: string; color: string; bg: string }> = {
  waking: { label: "waking", color: "#d97706", bg: "rgba(217,119,6,.12)" },
  woke: { label: "✓ woke", color: "#10b981", bg: "rgba(16,185,129,.15)" },
  dead: { label: "unreachable", color: "#ef4444", bg: "rgba(239,68,68,.12)" },
  failed: { label: "no answer", color: "#9ca3af", bg: "rgba(156,163,175,.15)" },
};

function WarmModelsCard({ toast }: { toast: (msg: string, type?: "info" | "error" | "success") => void }) {
  const [running, setRunning] = useState(false);
  const [coldCount, setColdCount] = useState(0);
  const [models, setModels] = useState<WakeModelStateUI[]>([]);
  const [starting, setStarting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async (force = false) => {
    try {
      const res = await fetch("/api/models/warm", {
        method: force ? "POST" : "GET",
        headers: force ? { "Content-Type": "application/json" } : undefined,
        body: force ? JSON.stringify({ force: true }) : undefined,
      });
      const j = await res.json();
      if (!j.success) return;
      setRunning(!!j.running);
      setColdCount(Array.isArray(j.coldModels) ? j.coldModels.length : 0);
      setModels(Array.isArray(j.models) ? j.models : []);
    } catch {
      /* transient — the next poll retries */
    }
  }, []);

  useEffect(() => {
    poll();
    // Poll every 5s while the card is mounted: cheap, and progress updates
    // (attempt N/3 → woke/failed) arrive within one interval.
    timerRef.current = setInterval(() => { poll(); }, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [poll]);

  const warmNow = async () => {
    setStarting(true);
    await poll(true);
    setStarting(false);
    toast("Warming started — cold models are being probed in the background", "info");
  };

  const wokeCount = models.filter((m) => m.state === "woke").length;
  const settled = models.length > 0 && models.every((m) => m.state !== "waking");

  return (
    <div className="settings-card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 600 }}>Warm models</p>
          <p className="settings-hint" style={{ marginTop: 2 }}>
            {coldCount > 0
              ? `${coldCount} model${coldCount > 1 ? "s" : ""} still warming up on their provider (first request can take minutes). They appear in the picker automatically once they answer.`
              : settled && models.length > 0
                ? `Last wake run: ${wokeCount}/${models.length} model(s) now answer. All verified models are in the picker.`
                : "Every verified model is live — nothing to warm."}
          </p>
        </div>
        <button
          onClick={warmNow}
          disabled={starting || running}
          className="settings-save-btn"
          style={running ? { opacity: 0.6 } : undefined}
          title="Probe every cold model now with generous warm-up timeouts — models that answer join the picker immediately"
        >
          {running ? "Warming…" : starting ? "Starting…" : "Warm models"}
        </button>
      </div>

      {models.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {models.map((m) => {
            const s = WAKE_STATE_STYLE[m.state];
            return (
              <div key={m.id} className="set-row">
                <span
                  aria-hidden="true"
                  style={{
                    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                    background: m.state === "waking" ? "#d97706" : m.state === "woke" ? "#10b981" : "#9ca3af",
                    animation: m.state === "waking" ? "settings-pulse 1.4s ease-in-out infinite" : undefined,
                  }}
                />
                <span className="spend-table-mono" style={{ fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.id}>
                  {m.id}
                </span>
                {m.state === "waking" && (
                  <span className="set-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                    attempt {m.attempt}/{m.totalAttempts}
                  </span>
                )}
                <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, color: s.color, background: s.bg, flexShrink: 0 }}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function tierBadge(def: ProviderDef) {
  return def.free ? (
    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,.15)", color: "#10b981", fontWeight: 600 }}>FREE TIER</span>
  ) : (
    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(99,102,241,.12)", color: "#818cf8", fontWeight: 600 }}>PAY-PER-USE</span>
  );
}

function SettingsApiKeyTab({ toast }: { toast: (msg: string, type?: "info" | "error" | "success") => void }) {
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedDef, setSelectedDef] = useState<ProviderDef | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [addStatus, setAddStatus] = useState("");
  const [addWarning, setAddWarning] = useState("");
  const [adding, setAdding] = useState(false);

  // Model-fetching engine state
  const [models, setModels] = useState<ListedModel[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [modelQuery, setModelQuery] = useState("");

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/settings/keys");
      if (res.ok) { const data = await res.json(); setKeys(data.keys); }
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchKeys(); }, []);

  const resetAddFlow = () => {
    setShowAdd(false);
    setSelectedDef(null);
    setApiKey("");
    setModel("");
    setAddStatus("");
    setAddWarning("");
    setModels(null);
    setModelsError("");
    setModelQuery("");
  };

  const fetchModels = async () => {
    if (!selectedDef || !apiKey.trim()) return;
    setModelsLoading(true);
    setModelsError("");
    try {
      const res = await fetch("/api/settings/keys/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedDef.id, apiKey: apiKey.trim() }),
      });
      const j = await res.json();
      if (j.success && Array.isArray(j.models)) {
        setModels(j.models);
        if (j.warning) setAddWarning(j.warning);
        if (!model && j.models.length > 0) setModel("");
      } else {
        setModels(null);
        setModelsError(j.error || "Could not fetch models.");
      }
    } catch {
      setModelsError("Network error while fetching models.");
    }
    setModelsLoading(false);
  };

  const addKey = async () => {
    if (!selectedDef) return;
    setAdding(true);
    setAddStatus("Testing key...");
    setAddWarning("");
    try {
      const res = await fetch("/api/settings/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedDef.id, apiKey: apiKey.trim(), model: model.trim() || selectedDef.fallbackModel }),
      });
      const data = await res.json();
      if (res.ok) {
        setAddStatus(data.key.message);
        toast("API key added", "success");
        resetAddFlow();
        fetchKeys();
      } else {
        setAddStatus(data.error || "Failed");
        if (data.warning) setAddWarning(data.warning);
      }
    } catch { setAddStatus("Network error"); }
    setAdding(false);
  };

  const deleteKey = async (id: string) => {
    if (!confirm("Remove this API key?")) return;
    await fetch(`/api/settings/keys?id=${id}`, { method: "DELETE" });
    toast("Key removed", "success");
    fetchKeys();
  };

  const filteredModels = (models ?? [])
    .filter((m) => {
      if (!modelQuery.trim()) return true;
      const q = modelQuery.toLowerCase();
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    })
    .slice(0, 80);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h2 className="settings-section-title">API Keys</h2>
        <p className="settings-section-desc">Add your own API keys for unlimited requests. Without personal keys, you use the platform shared quota (50 requests/day).</p>
      </div>
      <WarmModelsCard toast={toast} />
      <div className="settings-card">
        {loading ? (
          <p className="settings-hint">Loading keys...</p>
        ) : (
          <>
            {keys.length > 0 && (
              <div className="settings-api-grid">
                {keys.map(key => (
                  <div key={key.id} className="settings-api-item">
                    <div className="settings-api-header">
                      <span className="settings-api-name">{key.providerLabel || key.provider}</span>
                      <span className="settings-api-status settings-api-status-active">
                        {key.verified ? "✓ Verified" : "Active"}
                      </span>
                    </div>
                    <p className="settings-api-desc">Model: {key.model}</p>
                    {key.cachedModelCount != null && (
                      <p className="settings-api-desc" style={{ fontSize: 11, opacity: 0.75 }}>
                        {key.cachedModelCount} models listed{key.modelsFetchedAt ? ` · ${new Date(key.modelsFetchedAt).toLocaleDateString()}` : ""}
                      </p>
                    )}
                    <div className="settings-api-key-display">
                      <span className="settings-api-key-masked">{key.apiKeyMasked}</span>
                    </div>
                    <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={async () => {
                          setModelsLoading(true);
                          try {
                            const res = await fetch("/api/settings/keys/models", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ provider: key.provider, keyId: key.id }),
                            });
                            const j = await res.json();
                            toast(j.success ? `${j.count} models fetched` : (j.error || "Fetch failed"), j.success ? "success" : "error");
                            fetchKeys();
                          } catch { toast("Network error", "error"); }
                          setModelsLoading(false);
                        }}
                        className="settings-save-btn set-btn-secondary"
                      >
                        {modelsLoading ? "…" : "Refresh models"}
                      </button>
                      <button
                        onClick={async () => {
                          if (!confirm(`Verify models for ${key.providerLabel || key.provider}?\n\nThis sends a tiny test request to up to 12 models using your key (small credit cost).`)) return;
                          setModelsLoading(true);
                          try {
                            const res = await fetch("/api/settings/keys/models", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ provider: key.provider, keyId: key.id, mode: "verify" }),
                            });
                            const j = await res.json();
                            toast(
                              j.success ? `${j.verifiedCount}/${j.probedCount} models verified live` : (j.error || "Verify failed"),
                              j.success ? "success" : "error"
                            );
                            fetchKeys();
                          } catch { toast("Network error", "error"); }
                          setModelsLoading(false);
                        }}
                        className="settings-save-btn set-btn-secondary"
                        title="Probe up to 12 models with a tiny request to prove they answer — results get a ✓ in the picker"
                      >
                        {modelsLoading ? "…" : "Verify models"}
                      </button>
                      <button onClick={() => deleteKey(key.id)} className="settings-save-btn set-btn-danger">
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!showAdd ? (
              <button onClick={() => setShowAdd(true)} className="settings-save-btn" style={{ marginTop: 12 }}>
                + Add API Key
              </button>
            ) : !selectedDef ? (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Pick a provider</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
                  {PROVIDER_DEFS.map((def) => (
                    <button
                      key={def.id}
                      onClick={() => { setSelectedDef(def); setModel(""); setModels(null); setModelsError(""); }}
                      className="settings-api-item set-provider-card" style={{ textAlign: "left", cursor: "pointer", padding: 12 }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{def.label}</span>
                        {tierBadge(def)}
                      </div>
                      <p className="set-muted" style={{ fontSize: 11, marginTop: 4 }}>{def.tagline}</p>
                    </button>
                  ))}
                </div>
                <button onClick={resetAddFlow} className="settings-save-btn set-btn-secondary" style={{ marginTop: 12 }}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="set-panel" style={{ marginTop: 12, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedDef.label}</span>
                  <button onClick={() => setSelectedDef(null)} className="set-muted" style={{ fontSize: 11, background: "none", border: "none", cursor: "pointer" }}>
                    ← change provider
                  </button>
                </div>

                <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>API key</label>
                <input
                  type="password"
                  placeholder={selectedDef.keyPrefix ? `e.g. ${selectedDef.keyPrefix}…` : "Paste your API key here"}
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setModels(null); setModelsError(""); }}
                  style={{ width: "100%", padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid var(--set-line, #e4e4e7)", background: "var(--set-input-bg, #fff)", color: "inherit", marginBottom: 6 }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <a href={selectedDef.keyHintUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#818cf8" }}>
                    Get a {selectedDef.label} key ↗
                  </a>
                  <button
                    onClick={fetchModels}
                    disabled={modelsLoading || !apiKey.trim()}
                    className="settings-save-btn"
                    style={{ fontSize: 11, padding: "4px 10px" }}
                  >
                    {modelsLoading ? "Fetching…" : models ? "Re-fetch models" : "Fetch models"}
                  </button>
                </div>

                {modelsError && <p style={{ fontSize: 11, color: "#ef4444", marginBottom: 8 }}>{modelsError}</p>}
                {addWarning && <p style={{ fontSize: 11, color: "#d97706", marginBottom: 8 }}>{addWarning}</p>}

                {models && models.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <input
                      placeholder="Search models…"
                      value={modelQuery}
                      onChange={e => setModelQuery(e.target.value)}
                      style={{ width: "100%", padding: 6, fontSize: 12, borderRadius: 4, border: "1px solid var(--set-line, #e4e4e7)", background: "var(--set-input-bg, #fff)", color: "inherit", marginBottom: 6 }}
                    />
                    <div className="set-model-list" style={{ maxHeight: 220, overflowY: "auto" }}>
                      {filteredModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setModel(m.id)}
                          style={{
                            display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
                            borderBottom: "1px solid var(--set-row-line, #f3f4f6)", background: model === m.id ? "rgba(99,102,241,.1)" : "transparent",
                            border: "none", cursor: "pointer",
                          }}
                        >
                          <div style={{ fontSize: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontWeight: 500 }}>{m.name}</span>
                            <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                              {m.free && <span style={{ fontSize: 10, color: "#10b981", fontWeight: 600 }}>FREE</span>}
                              {m.contextWindow ? <span style={{ fontSize: 10, color: "#9ca3af" }}>{Math.round(m.contextWindow / 1024)}k ctx</span> : null}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace" }}>{m.id}</div>
                        </button>
                      ))}
                      {filteredModels.length === 0 && (
                        <p style={{ fontSize: 11, color: "#9ca3af", padding: 10 }}>No models match &quot;{modelQuery}&quot;.</p>
                      )}
                    </div>
                    <p style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>
                      Showing {filteredModels.length} of {models.length} fetched models.
                    </p>
                  </div>
                )}

                <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Model</label>
                <input
                  placeholder={selectedDef.fallbackModel}
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  style={{ width: "100%", padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid #e4e4e7", marginBottom: 8 }}
                />
                {!model.trim() && (
                  <p style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8 }}>
                    Empty = default model ({selectedDef.fallbackModel}).
                  </p>
                )}

                {addStatus && <p style={{ fontSize: 11, color: addStatus.includes("success") || addStatus.includes("added") ? "green" : "#ef4444", marginBottom: 8 }}>{addStatus}</p>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={addKey} disabled={adding || !apiKey.trim()} className="settings-save-btn">
                    {adding ? "Testing..." : "Add Key"}
                  </button>
                  <button onClick={resetAddFlow} className="settings-save-btn set-btn-secondary">
                    Cancel
                  </button>
                </div>
                <p className="settings-hint" style={{ marginTop: 8 }}>
                  {selectedDef.free
                    ? `${selectedDef.label} has a free tier — grab a key, paste it above, and Fetch models fills the list for you.`
                    : `${selectedDef.label} is pay-per-use with your own credits. Fetch models lists everything your key can reach.`}
                </p>
              </div>
            )}

            <div className="settings-api-note" style={{ marginTop: 16 }}>
              <p><strong>Without a personal key:</strong> You use the platform shared quota (50 requests/day).</p>
              <p style={{ marginTop: 4 }}><strong>With your own key:</strong> Unlimited requests, using your own API credits.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

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
  green: { color: "#10b981", bg: "rgba(16,185,129,.15)" },
  amber: { color: "#d97706", bg: "rgba(217,119,6,.12)" },
  red: { color: "#ef4444", bg: "rgba(239,68,68,.12)" },
  none: { color: "#9ca3af", bg: "rgba(156,163,175,.15)" },
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
      const res = await fetch("/api/agent/spend");
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
      const res = await fetch("/api/agent/uptime");
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
          <p className="settings-hint" style={{ color: "#ef4444" }}>{error}</p>
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

// === Reset & Recovery tab ================================================
// One documented, safe escape hatch for "the app looks frozen": clear stuck
// runs / cancel active runs and clear transient local UI state. Nothing here
// touches conversations, files, or workspace data — the card says so
// explicitly because trust is the point.
function ResetRecoveryTab({ toast }: { toast: (msg: string, type?: "info" | "error" | "success") => void }) {
  const [busy, setBusy] = useState<"runs" | "state" | null>(null);
  const [confirming, setConfirming] = useState<"runs" | "state" | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const cancelStuckRuns = async () => {
    setBusy("runs");
    setResult(null);
    try {
      const res = await fetch("/api/agent/runs?limit=50");
      const data = await res.json();
      const runs: Array<{ id: string; isActive: boolean; status: string }> = data?.runs || [];
      const targets = runs.filter((r) => r.isActive);
      let ok = 0;
      for (const r of targets) {
        try {
          const del = await fetch(`/api/agent/runs/${r.id}`, { method: "DELETE" });
          if (del.ok) ok++;
        } catch {}
      }
      setResult(`Cancelled ${ok} active run${ok === 1 ? "" : "s"}. Your conversations and files are untouched.`);
      toast(ok > 0 ? `Cancelled ${ok} stuck run${ok === 1 ? "" : "s"}` : "No active runs to clear", "success");
    } catch {
      toast("Could not reach the run service — try again", "error");
    }
    setBusy(null);
    setConfirming(null);
  };

  const resetAgentState = () => {
    setBusy("state");
    try {
      // Transient UI/agent state only — never conversations or files.
      for (const key of [
        "orplex.rightPanel", "orplex.rightPanelTab", "orplex.tipShown", "orplex.tipIndex",
        "orplex.firstRun.v1", "orplex.whatsNewSeen.latest",
      ]) {
        try { localStorage.removeItem(key); } catch {}
        try { sessionStorage.removeItem(key); } catch {}
      }
      try { sessionStorage.clear(); } catch {}
      setResult("Transient agent/UI state cleared. Reload to start from a clean slate.");
      toast("Agent state reset — reloading…", "success");
      setTimeout(() => window.location.reload(), 900);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h2 className="settings-section-title">Reset &amp; Recovery</h2>
        <p className="settings-section-desc">Safe, documented recovery when a run looks frozen or the UI feels wedged. Nothing here deletes conversations, files, or workspace data.</p>
      </div>

      {result && (
        <div className="settings-card" style={{ marginBottom: 12, borderLeft: "3px solid #10b981" }}>
          <p className="settings-hint" style={{ color: "#10b981" }}>{result}</p>
        </div>
      )}

      <div className="settings-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 600 }}>Clear stuck runs</p>
            <p className="settings-hint" style={{ marginTop: 2 }}>
              Cancels every active run (including ghosted ones that stopped reporting). Files already written stay; conversations stay.
            </p>
          </div>
          {confirming === "runs" ? (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={cancelStuckRuns} disabled={busy !== null} className="settings-save-btn set-btn-danger">
                {busy === "runs" ? "Cancelling…" : "Confirm cancel"}
              </button>
              <button onClick={() => setConfirming(null)} disabled={busy !== null} className="settings-save-btn set-btn-secondary">Keep</button>
            </div>
          ) : (
            <button onClick={() => setConfirming("runs")} disabled={busy !== null} className="settings-save-btn set-btn-secondary">
              Clear stuck runs
            </button>
          )}
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 600 }}>Reset agent state</p>
            <p className="settings-hint" style={{ marginTop: 2 }}>
              Clears transient local state (queues, panel layout, onboarding flags) and reloads. Conversations, history, and files are never touched.
            </p>
          </div>
          {confirming === "state" ? (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={resetAgentState} disabled={busy !== null} className="settings-save-btn set-btn-danger">
                {busy === "state" ? "Resetting…" : "Confirm reset"}
              </button>
              <button onClick={() => setConfirming(null)} disabled={busy !== null} className="settings-save-btn set-btn-secondary">Keep</button>
            </div>
          ) : (
            <button onClick={() => setConfirming("state")} disabled={busy !== null} className="settings-save-btn set-btn-secondary">
              Reset agent state
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("profile");
  // Deep links (/settings?tab=api) and sidebar-driven switches arrive without
  // remounting this page (query-only pushes don't re-run mount effects), so
  // sync the tab from the URL + the orplex:settings-tab nav event.
  useEffect(() => {
    const readUrlTab = () => {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t) setActiveTab(t);
    };
    const onSettingsTab = (e: Event) => setActiveTab((e as CustomEvent<string>).detail);
    readUrlTab();
    window.addEventListener("popstate", readUrlTab);
    window.addEventListener("orplex:settings-tab", onSettingsTab);
    return () => {
      window.removeEventListener("popstate", readUrlTab);
      window.removeEventListener("orplex:settings-tab", onSettingsTab);
    };
  }, []);
  const router = useRouter();
  const { data: session, update } = useSession();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (session?.user?.name) setName(session.user.name); }, [session?.user?.name]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      await update();
      setSaved(true);
      toast("Profile saved", "success");
      setTimeout(() => setSaved(false), 2000);
    } catch { toast("Failed to save profile", "error"); }
    setSaving(false);
  };

  const tabs = [
    { id: "profile", label: "Profile" },
    { id: "appearance", label: "Appearance" },
    { id: "cost", label: "Provider & Cost" },
    { id: "api", label: "API Keys" },
    { id: "about", label: "About" },
    { id: "danger", label: "Reset & Recovery" },
  ];

  // Tab switches update the URL (so ?tab= stays shareable/back-nav friendly)
  // and tell the sidebar, which tracks the active tab via the
  // orplex:settings-tab event — usePathname can't see query params.
  const switchTab = (id: string) => {
    setActiveTab(id);
    router.replace(`/settings?tab=${id}`, { scroll: false });
    window.dispatchEvent(new CustomEvent("orplex:settings-tab", { detail: id }));
  };

  return (
      <div className="page-content">
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-header">
              <span className="settings-sidebar-title">Settings</span>
            </div>
            {tabs.map((tab) => (
              <button key={tab.id} onClick={() => switchTab(tab.id)}
                className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}>
                {tab.label}
              </button>
            ))}
          </aside>
          <div className="settings-main">
            {activeTab === "profile" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Profile</h2>
                  <p className="settings-section-desc">Manage your personal information and display name.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-profile">
                    <div className="settings-avatar-section">
                      <div className="settings-avatar-large">
                        {session?.user?.image ? (
                          <img src={session.user.image} alt="Avatar" />
                        ) : (
                          <span>{(session?.user?.name || "U")[0].toUpperCase()}</span>
                        )}
                      </div>
                      <div className="settings-avatar-info">
                        <p className="settings-avatar-name">{session?.user?.name || "User"}</p>
                        <p className="settings-avatar-email">{session?.user?.email || ""}</p>
                      </div>
                    </div>
                    <div className="settings-divider" />
                    <div className="settings-fields">
                      <div className="settings-field">
                        <label className="settings-label">Display Name</label>
                        <input className="settings-input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your name" />
                      </div>
                      <div className="settings-field">
                        <label className="settings-label">Email Address</label>
                        <input className="settings-input settings-input-disabled" disabled type="email" value={session?.user?.email || ""} />
                        <p className="settings-hint">Managed by your OAuth provider</p>
                      </div>
                    </div>
                    <div className="settings-actions">
                      <button onClick={saveProfile} disabled={saving || name === session?.user?.name} className="settings-save-btn">
                        {saved ? <><IconCheck size={14} /> Saved</> : saving ? "Saving..." : "Save Changes"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Appearance</h2>
                  <p className="settings-section-desc">Customize the look and feel of Orplex Code.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-info">
                      <span className="settings-toggle-label">Dark Mode</span>
                      <span className="settings-toggle-desc">Switch between light and dark themes</span>
                    </div>
                    <span className="settings-toggle-hint">Use the toggle in the top bar</span>
                  </div>
                  <div className="settings-divider" />
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-info">
                      <span className="settings-toggle-label">Compact Messages</span>
                      <span className="settings-toggle-desc">Reduce spacing in chat messages</span>
                    </div>
                    <span className="settings-toggle-badge">Coming Soon</span>
                  </div>
                  <div className="settings-divider" />
                  <div className="settings-toggle-row">
                    <div className="settings-toggle-info">
                      <span className="settings-toggle-label">Font Size</span>
                      <span className="settings-toggle-desc">Adjust text size throughout the app</span>
                    </div>
                    <span className="settings-toggle-badge">Coming Soon</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "cost" && (
              <SettingsCostTab />
            )}

            {activeTab === "api" && (
              <SettingsApiKeyTab toast={toast} />
            )}

            {activeTab === "about" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">About Orplex Code</h2>
                  <p className="settings-section-desc">Information about your installation.</p>
                </div>
                <div className="settings-card">
                  <div className="settings-about-grid">
                    <div className="settings-about-item">
                      <span className="settings-about-label">Version</span>
                      <span className="settings-about-value">1.0.0</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">Build</span>
                      <span className="settings-about-value">Production</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">Framework</span>
                      <span className="settings-about-value">Next.js + TypeScript</span>
                    </div>
                    <div className="settings-about-item">
                      <span className="settings-about-label">AI Backend</span>
                      <span className="settings-about-value">Multi-provider (Groq, Claude, Gemini, +9)</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "danger" && <ResetRecoveryTab toast={toast} />}
          </div>
        </div>
      </div>
  );
}
