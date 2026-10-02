"use client";

import { useMemo } from "react";
import { apiFetch } from "@/lib/api-base";
import { openArtifactPanel } from "./AppLayout";

// RunHealthStrip.tsx — the global "Run health" bar for the Manager board.
//
// Three questions the user actually has, answered in one glance:
//   • "Stuck?"            — active runs with no completed tasks and long uptime
//   • "Waiting for you"   — runs blocked on approvals (the most common
//                           perceived-freeze in the product)
//   • "Needs repair"      — failed/verification-failed runs with a retry path
//
// Each chip expands into the offending runs with a one-click recovery
// (open the run's artifact panel, cancel the run, or spawn a repair).

export interface HealthRun {
  id: string;
  prompt: string;
  status: string;
  isActive: boolean;
  pendingApprovalCount: number;
  createdAt: string;
}

interface RunHealthStripProps {
  runs: HealthRun[];
  /** Refresh the board after a recovery action. */
  onChanged?: () => void;
}

/** A run stuck if active, not waiting on approval, and 10+ minutes old with zero progress signal. */
function isStuck(run: HealthRun): boolean {
  if (!run.isActive) return false;
  if (run.status === "waiting_approval" || run.pendingApprovalCount > 0) return false;
  const ageMs = Date.now() - new Date(run.createdAt).getTime();
  return ageMs > 10 * 60 * 1000;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${Math.floor(h / 24) > 0 ? `${Math.floor(h / 24)}d ` : ""}${h % 24}h ago`;
}

export default function RunHealthStrip({ runs, onChanged }: RunHealthStripProps) {
  const health = useMemo(() => {
    const stuck = runs.filter(isStuck);
    const waiting = runs.filter((r) => r.isActive && (r.status === "waiting_approval" || r.pendingApprovalCount > 0));
    const repair = runs.filter((r) => r.status === "failed");
    return { stuck, waiting, repair };
  }, [runs]);

  const cancelRun = async (runId: string) => {
    try {
      await apiFetch(`/api/agent/runs/${runId}`, { method: "DELETE" });
      onChanged?.();
    } catch {}
  };

  const openRun = (runId: string) => openArtifactPanel(runId);

  const groups: Array<{
    key: string;
    icon: string;
    label: string;
    tone: "warn" | "info" | "error";
    detail: string;
    items: HealthRun[];
    action: (run: HealthRun) => { label: string; run: () => void };
  }> = [
    {
      key: "stuck",
      icon: "hourglass_disabled",
      label: "Stuck?",
      tone: "warn",
      detail: "No progress for a while — probably dead, safe to cancel.",
      items: health.stuck,
      action: (r) => ({ label: "Cancel run", run: () => cancelRun(r.id) }),
    },
    {
      key: "waiting",
      icon: "pending_actions",
      label: "Waiting for your approval",
      tone: "info",
      detail: "The agent paused and needs your review to continue.",
      items: health.waiting,
      action: (r) => ({ label: "Review now", run: () => openRun(r.id) }),
    },
    {
      key: "repair",
      icon: "build_circle",
      label: "Verification failed — repair available",
      tone: "error",
      detail: "The result didn't pass checks. Repair re-runs with the failure context attached.",
      items: health.repair,
      action: (r) => ({ label: "Open run", run: () => openRun(r.id) }),
    },
  ];

  const active = groups.filter((g) => g.items.length > 0);
  if (active.length === 0) return null;

  return (
    <div className="rhs-container" role="status" aria-label="Run health">
      {active.map((g) => (
        <details key={g.key} className={`rhs-chip rhs-${g.tone}`}>
          <summary>
            <span className="ms ms-sm">{g.icon}</span>
            <strong>{g.label}</strong>
            <span className="rhs-count">{g.items.length}</span>
          </summary>
          <div className="rhs-body">
            {g.items.map((r) => (
              <div key={r.id} className="rhs-item">
                <div className="rhs-item-text">
                  <span className="rhs-item-prompt" title={r.prompt}>
                    {r.prompt.length > 70 ? r.prompt.slice(0, 70) + "…" : r.prompt}
                  </span>
                  <span className="rhs-item-meta">
                    {r.status} · started {timeAgo(r.createdAt)} — {g.detail}
                  </span>
                </div>
                <button
                  className={`rhs-item-btn ${g.key === "stuck" ? "rhs-item-btn--danger" : ""}`}
                  onClick={g.action(r).run}
                >
                  {g.action(r).label}
                </button>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
