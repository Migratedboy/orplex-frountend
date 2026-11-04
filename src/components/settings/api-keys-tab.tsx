"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api-base";
import { listProviderDefs, type ProviderDef } from "@/lib/provider-registry";
import type { ListedModel } from "@/lib/provider-models";
import { WarmModelsCard } from "./warm-models-card";

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

function tierBadge(def: ProviderDef) {
  return def.free ? (
    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,.15)", color: "var(--st-done-fg)", fontWeight: 600 }}>FREE TIER</span>
  ) : (
    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(99,102,241,.12)", color: "var(--st-verify-fg)", fontWeight: 600 }}>PAY-PER-USE</span>
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
  // Engine-reported metadata: lets the UI state honestly whether the whole
  // catalogue arrived, instead of implying a truncated list is complete.
  const [modelsTruncated, setModelsTruncated] = useState(false);
  const [modelMeta, setModelMeta] = useState({ free: 0, paid: 0, unknown: 0 });
  const freeModelCount = modelMeta.free;
  const paidModelCount = modelMeta.paid + modelMeta.unknown;
  const [modelQuery, setModelQuery] = useState("");

  /**
   * Record what the engine actually returned, so the list can state honestly
   * whether the WHOLE catalogue arrived. A list that silently drops half its
   * entries (the old 200-cap) is how models went missing without explanation.
   */
  const applyModelMeta = (list: Array<{ free?: boolean }>, truncated?: boolean) => {
    setModelsTruncated(truncated === true);
    setModelMeta({
      free: list.filter((m) => m.free === true).length,
      paid: list.filter((m) => m.free === false).length,
      unknown: list.filter((m) => m.free === undefined).length,
    });
  };

  const fetchKeys = async () => {
    try {
      const res = await apiFetch("/api/settings/keys");
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
      const res = await apiFetch("/api/settings/keys/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedDef.id, apiKey: apiKey.trim() }),
      });
      const j = await res.json();
      if (j.success && Array.isArray(j.models)) {
        setModels(j.models);
        applyModelMeta(j.models, j.truncated);
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
      const res = await apiFetch("/api/settings/keys", {
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
    await apiFetch(`/api/settings/keys?id=${id}`, { method: "DELETE" });
    toast("Key removed", "success");
    fetchKeys();
  };

  const filteredModels = (models ?? [])
    .filter((m) => {
      if (!modelQuery.trim()) return true;
      const q = modelQuery.toLowerCase();
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    })
    // No display truncation: the list container scrolls, and slicing here used
    // to make 300+ of a real provider's models unreachable no matter what the
    // user typed. The cap is only a render-speed backstop.
    .slice(0, 1000);

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
                            const res = await apiFetch("/api/settings/keys/models", {
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
                            const res = await apiFetch("/api/settings/keys/models", {
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
                  style={{ width: "100%", padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid var(--set-line, var(--border))", background: "var(--set-input-bg, #fff)", color: "inherit", marginBottom: 6 }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <a href={selectedDef.keyHintUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--st-verify-fg)" }}>
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

                {modelsError && <p style={{ fontSize: 11, color: "var(--st-error-fg)", marginBottom: 8 }}>{modelsError}</p>}
                {addWarning && <p style={{ fontSize: 11, color: "var(--st-warn-fg)", marginBottom: 8 }}>{addWarning}</p>}

                {models && models.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <input
                      placeholder="Search models…"
                      value={modelQuery}
                      onChange={e => setModelQuery(e.target.value)}
                      style={{ width: "100%", padding: 6, fontSize: 12, borderRadius: 4, border: "1px solid var(--set-line, var(--border))", background: "var(--set-input-bg, #fff)", color: "inherit", marginBottom: 6 }}
                    />
                    <div className="set-model-list" style={{ maxHeight: 220, overflowY: "auto" }}>
                      {filteredModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setModel(m.id)}
                          style={{
                            display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
                            borderBottom: "1px solid var(--set-row-line, var(--well))", background: model === m.id ? "rgba(99,102,241,.1)" : "transparent",
                            border: "none", cursor: "pointer",
                          }}
                        >
                          <div style={{ fontSize: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontWeight: 500 }}>{m.name}</span>
                            <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                              {m.free && <span style={{ fontSize: 10, color: "var(--st-done-fg)", fontWeight: 600 }}>FREE</span>}
                              {m.contextWindow ? <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{Math.round(m.contextWindow / 1024)}k ctx</span> : null}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "monospace" }}>{m.id}</div>
                        </button>
                      ))}
                      {filteredModels.length === 0 && (
                        <p style={{ fontSize: 11, color: "var(--text-tertiary)", padding: 10 }}>No models match &quot;{modelQuery}&quot;.</p>
                      )}
                    </div>
                    <p style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>
                        Showing {filteredModels.length} of {models.length} fetched models
                        {freeModelCount > 0 ? ` · ${freeModelCount} free` : ""}
                        {paidModelCount > 0 ? ` · ${paidModelCount} paid` : ""}
                        {modelsTruncated ? " · list truncated for safety" : ""}
                        .
                      </p>
                  </div>
                )}

                <label style={{ fontSize: 11, fontWeight: 600, display: "block", marginBottom: 4 }}>Model</label>
                <input
                  placeholder={selectedDef.fallbackModel}
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  style={{ width: "100%", padding: 8, fontSize: 12, borderRadius: 4, border: "1px solid var(--border)", marginBottom: 8 }}
                />
                {!model.trim() && (
                  <p style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 8 }}>
                    Empty = default model ({selectedDef.fallbackModel}).
                  </p>
                )}

                {addStatus && <p style={{ fontSize: 11, color: addStatus.includes("success") || addStatus.includes("added") ? "green" : "var(--st-error-fg)", marginBottom: 8 }}>{addStatus}</p>}
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

export { SettingsApiKeyTab };
