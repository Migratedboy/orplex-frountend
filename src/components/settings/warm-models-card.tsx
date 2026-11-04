"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api-base";

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
  waking: { label: "waking", color: "var(--st-warn-fg)", bg: "rgba(217,119,6,.12)" },
  woke: { label: "✓ woke", color: "var(--st-done-fg)", bg: "rgba(16,185,129,.15)" },
  dead: { label: "unreachable", color: "var(--st-error-fg)", bg: "rgba(239,68,68,.12)" },
  failed: { label: "no answer", color: "var(--text-tertiary)", bg: "rgba(156,163,175,.15)" },
};

export function WarmModelsCard({ toast }: { toast: (msg: string, type?: "info" | "error" | "success") => void }) {
  const [running, setRunning] = useState(false);
  const [coldCount, setColdCount] = useState(0);
  const [models, setModels] = useState<WakeModelStateUI[]>([]);
  const [starting, setStarting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async (force = false) => {
    try {
      const res = await apiFetch("/api/models/warm", {
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
                    background: m.state === "waking" ? "var(--st-warn-fg)" : m.state === "woke" ? "var(--st-done-fg)" : "var(--text-tertiary)",
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
