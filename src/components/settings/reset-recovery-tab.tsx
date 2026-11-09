"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-base";

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
      const res = await apiFetch("/api/agent/runs?limit=50");
      const data = await res.json();
      const runs: Array<{ id: string; isActive: boolean; status: string }> = data?.runs || [];
      const targets = runs.filter((r) => r.isActive);
      let ok = 0;
      for (const r of targets) {
        try {
          const del = await apiFetch(`/api/agent/runs/${r.id}`, { method: "DELETE" });
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
        "orplex.rightPanel", "orplex.rightPanelTab", "orplex.rightPanelTabs", "orplex.tipShown", "orplex.tipIndex",
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
        <div className="settings-card" style={{ marginBottom: 12, borderLeft: "3px solid var(--st-done-fg)" }}>
          <p className="settings-hint" style={{ color: "var(--st-done-fg)" }}>{result}</p>
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

export { ResetRecoveryTab };
