"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh, IconAgent } from "./Icons";
import RunLiveStatus from "./RunLiveStatus";
import { formatTokens, scheduledLabel, removeApprovalFromRuns } from "@/lib/board-format";
import { apiFetch } from "@/lib/api-base";

// === Types (mirror of the /api/agent/runs payload) ===

interface BoardTask {
  id: string;
  role: string;
  title: string;
  status: string;
  isLeased: boolean;
  error?: string | null;
  dependsOn: string[];
}

interface BoardApproval {
  id: string;
  action: string;
  createdAt: string;
}

interface BoardRun {
  id: string;
  prompt: string;
  status: string;
  autonomyPolicy: string;
  executionTarget: string;
  tokenUsage: number;
  estimatedCostUsd: number;
  estimatedCostLabel: string;
  createdAt: string;
  completedAt: string | null;
  isActive: boolean;
  artifactCount: number;
  pendingApprovalCount: number;
  priority?: number;
  notBefore?: string | null;
  modelOverride?: string | null;
  retries?: number;
  parentRunId?: string | null;
  missionLabel?: string | null;
  pendingApprovals?: BoardApproval[];
  tasks: BoardTask[];
}

interface BoardSummary {
  total: number;
  active: number;
  pendingApprovals: number;
}

// === Status presentation ===

const TASK_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "Pending", color: "#71717a", bg: "#f4f4f5" },
  leased: { label: "Leased", color: "#2563eb", bg: "#dbeafe" },
  running: { label: "Running", color: "#ea580c", bg: "#ffedd5" },
  waiting_approval: { label: "Waiting approval", color: "#b45309", bg: "#fef3c7" },
  verifying: { label: "Verifying", color: "#7c3aed", bg: "#ede9fe" },
  completed: { label: "Done", color: "#15803d", bg: "#dcfce7" },
  failed: { label: "Failed", color: "#b91c1c", bg: "#fee2e2" },
  cancelled: { label: "Cancelled", color: "#71717a", bg: "#f4f4f5" },
};

const RUN_STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "#71717a" },
  planning: { label: "Planning", color: "#2563eb" },
  executing: { label: "Executing", color: "#ea580c" },
  verifying: { label: "Verifying", color: "#7c3aed" },
  waiting_approval: { label: "Waiting approval", color: "#b45309" },
  completed: { label: "Completed", color: "#15803d" },
  failed: { label: "Failed", color: "#b91c1c" },
  cancelled: { label: "Cancelled", color: "#71717a" },
};

// Note: dark-mode values applied via CSS variables in globals.css (.run-board overrides)
const ROLE_LABEL: Record<string, string> = {
  architect: "ARCH",
  developer: "DEV",
  reviewer: "REV",
  verifier: "VERIFY",
};

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// === Components ===

function TaskCard({ task }: { task: BoardTask }) {
  const meta = TASK_STATUS_META[task.status] || TASK_STATUS_META.pending;
  const isWaiting = task.status === "waiting_approval";
  const isFailed = task.status === "failed";

  return (
    <div
      className={`board-task-card ${isWaiting ? "board-task-waiting" : ""} ${isFailed ? "board-task-failed" : ""}`}
      title={task.error || task.title}
    >
      <div className="board-task-top">
        <span className="board-task-role">{ROLE_LABEL[task.role] || task.role.toUpperCase()}</span>
        <span className="board-task-status-chip" style={{ color: meta.color, background: meta.bg }}>
          {task.status === "running" && task.isLeased ? "leased" : meta.label}
        </span>
      </div>
      <div className="board-task-title">{task.title}</div>
      {task.dependsOn.length > 0 && (
        <div className="board-task-deps">{task.dependsOn.length} dependency(ies)</div>
      )}
    </div>
  );
}

function RunLane({ run, onOpen, onDecide, decidingId }: { run: BoardRun; onOpen: (id: string) => void; onDecide: (runId: string, requestId: string, action: "approve" | "reject") => void; decidingId: string | null }) {
  const runMeta = RUN_STATUS_META[run.status] || RUN_STATUS_META.pending;
  const tasks = run.tasks || [];
  const doneCount = tasks.filter(t => t.status === "completed").length;
  const approvals = run.pendingApprovals || [];

  return (
    <div className="board-lane">
      <div className="board-lane-header" onClick={() => onOpen(run.id)} role="button" tabIndex={0}>
        <div className="board-lane-title-row">
          <span className="board-lane-status-dot" style={{ background: runMeta.color }} />
          <span className="board-lane-prompt">{run.prompt.slice(0, 70)}{run.prompt.length > 70 ? "..." : ""}</span>
          {run.pendingApprovalCount > 0 && (
            <span className="board-lane-approval-badge">{run.pendingApprovalCount} approval{run.pendingApprovalCount > 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="board-lane-meta">
          <span style={{ color: runMeta.color }}>{runMeta.label}</span>
          <span className="board-lane-sep">|</span>
          {run.isActive && <RunLiveStatus runId={run.id} startedAt={run.createdAt} />}
          <span>{doneCount}/{tasks.length} tasks</span>
          <span className="board-lane-sep">|</span>
          <span className="board-lane-cost" title={`${run.tokenUsage.toLocaleString()} tokens (metered by the executor)`}>
            {run.tokenUsage > 0 ? `${formatTokens(run.tokenUsage)} tok` : run.estimatedCostLabel}
            {run.tokenUsage > 0 && run.estimatedCostUsd > 0 ? ` · ${run.estimatedCostLabel}` : ""}
          </span>
          {(run.priority ?? 0) > 0 && (
            <>
              <span className="board-lane-sep">|</span>
              <span className="board-chip" title="Lease priority — higher claims first">P{run.priority}</span>
            </>
          )}
          {run.notBefore && scheduledLabel(run.notBefore) && (
            <>
              <span className="board-lane-sep">|</span>
              <span className="board-chip board-chip-scheduled" title={`Queued for ${new Date(run.notBefore).toLocaleString()}`}>🌙 {scheduledLabel(run.notBefore)}</span>
            </>
          )}
          {run.modelOverride && (
            <>
              <span className="board-lane-sep">|</span>
              <span className="board-chip" title="Per-run model override (BYOK)">{run.modelOverride.slice(0, 28)}</span>
            </>
          )}
          {(run.retries ?? 0) > 0 && (
            <>
              <span className="board-lane-sep">|</span>
              <span className="board-chip board-chip-warn" title="Requeued after an executor restart">↻ {run.retries}×</span>
            </>
          )}
          <span className="board-lane-sep">|</span>
          <span>{timeAgo(run.createdAt)}</span>
        </div>
        {tasks.length > 0 && (
          <div className="board-lane-progress">
            <div
              className="board-lane-progress-fill"
              style={{ width: `${tasks.length ? (doneCount / tasks.length) * 100 : 0}%` }}
            />
          </div>
        )}
      </div>
      {approvals.length > 0 && (
        <div className="board-approvals">
          {approvals.map(a => (
            <div key={a.id} className="board-approval-card">
              <div className="board-approval-main">
                <span className="board-approval-icon">⏸</span>
                <span className="board-approval-action" title={a.action}>{a.action}</span>
              </div>
              <div className="board-approval-buttons">
                <button
                  className="board-approval-btn board-approval-approve"
                  disabled={decidingId === a.id}
                  onClick={(e) => { e.stopPropagation(); onDecide(run.id, a.id, "approve"); }}
                >
                  {decidingId === a.id ? "…" : "Approve"}
                </button>
                <button
                  className="board-approval-btn board-approval-deny"
                  disabled={decidingId === a.id}
                  onClick={(e) => { e.stopPropagation(); onDecide(run.id, a.id, "reject"); }}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="board-lane-cards">
        {tasks.map(task => <TaskCard key={task.id} task={task} />)}
      </div>
    </div>
  );
}

export default function RunBoard() {
  const [runs, setRuns] = useState<BoardRun[]>([]);
  const [summary, setSummary] = useState<BoardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active">("all");
  const router = useRouter();

  const fetchRuns = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agent/runs?limit=30${filter === "active" ? "&status=active" : ""}`);
      const data = await res.json();
      if (data.success) {
        setRuns(data.runs || []);
        setSummary(data.summary || null);
      }
    } catch {}
    setLoading(false);
  }, [filter]);

  // Initial fetch + poll every 5s while anything is active
  useEffect(() => {
    setLoading(true);
    fetchRuns();
    const interval = setInterval(fetchRuns, 5000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  const openRun = useCallback((runId: string) => {
    // Dynamic import avoids coupling the board page to AppLayout internals
    import("./AppLayout").then(m => m.openArtifactPanel(runId)).catch(() => {});
  }, []);

  // Missions: children of mission-parent runs, grouped for the swimlanes.
  const missionGroups = (() => {
    const byParent = new Map<string, { label: string; children: BoardRun[] }>();
    for (const r of runs) {
      if (!r.parentRunId) continue;
      const group = byParent.get(r.parentRunId) ?? { label: r.missionLabel || "Mission", children: [] };
      group.children.push(r);
      byParent.set(r.parentRunId, group);
    }
    return [...byParent.entries()];
  })();
  const childIds = new Set(runs.filter(r => r.parentRunId).map(r => r.id));
  const visibleStandaloneRuns = runs.filter(r => !r.parentRunId || r.status === "mission");

  // Inline approve/deny from the board. Optimistic UI: the card disappears
  // immediately; the next poll (5s) reconciles with the server truth, and a
  // failure restores the card with a toast.
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const decide = useCallback(async (runId: string, requestId: string, action: "approve" | "reject") => {
    setDecidingId(requestId);
    const prevRuns = runs;
    setRuns(rs => removeApprovalFromRuns(rs, runId, requestId));
    try {
      const res = await apiFetch(`/api/agent/runs/${runId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setRuns(prevRuns); // restore the card — the decision did not land
    } finally {
      setDecidingId(null);
    }
  }, [runs]);

  return (
    <div className="page-content">
      <div className="page-container">
        <div className="page-header">
          <div className="page-header-text">
            <h2 className="page-title">Runs Board</h2>
            <p className="page-subtitle">
              Mission control for agent runs. {summary
                ? `${summary.active} active, ${summary.pendingApprovals} approval(s) pending.`
                : "Lanes show each run; cards show each task."}
            </p>
          </div>
          <div className="board-header-actions">
            <div className="board-filter">
              <button
                className={`board-filter-btn ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >All</button>
              <button
                className={`board-filter-btn ${filter === "active" ? "active" : ""}`}
                onClick={() => setFilter("active")}
              >Active{summary && summary.active > 0 ? ` (${summary.active})` : ""}</button>
            </div>
            <button className="board-refresh" onClick={fetchRuns} title="Refresh">
              <IconRefresh size={14} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="skeleton-list">
            {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 96 }} />)}
          </div>
        ) : runs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><span style={{ opacity: 0.35 }}><IconAgent size={40} /></span></div>
            <p className="empty-state-title">No agent runs yet</p>
            <p className="empty-state-text">
              Runs appear here once you queue agent tasks. Each run gets a lane;
              every task inside it shows live status.
            </p>
          </div>
        ) : (
          <div className="board-columns">
            {visibleStandaloneRuns.map(run => <RunLane key={run.id} run={run} onOpen={openRun} onDecide={decide} decidingId={decidingId} />)}
          </div>
        )}
        {missionGroups.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 13, margin: "0 0 8px", opacity: 0.7 }}>Missions</h3>
            <div className="board-columns">
              {missionGroups.map(([parentId, group]) => (
                <div key={parentId} style={{ border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
                    {group.label} · {group.children.filter(c => c.status === "completed").length}/{group.children.length} done
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {group.children.map(c => (
                      <div key={c.id} style={{ fontSize: 11, padding: "4px 6px", borderRadius: 4, background: "rgba(128,128,128,0.08)", cursor: "pointer" }} onClick={() => openRun(c.id)}>
                        <span style={{ color: c.status === "completed" ? "#22c55e" : c.status === "failed" ? "#ef4444" : "#eab308" }}>●</span>{" "}
                        {(c.prompt || "").replace(/^\[Mission:[^\]]+\]\s*/, "").slice(0, 60)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
