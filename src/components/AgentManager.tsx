"use client";

import { useState, useEffect, useCallback, useRef } from "react";

import { apiFetch } from "@/lib/api-base";
import RunHealthStrip from "./RunHealthStrip";
// === Types ===

interface ManagerTask {
  id: string;
  role: string;
  title: string;
  status: string;
  isLeased: boolean;
  error?: string | null;
  dependsOn: string[];
  artifacts: { id: string; kind: string; name: string }[];
}

interface ManagerRun {
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
  tasks: ManagerTask[];
}

interface Notification {
  id: string;
  runId: string;
  type: "completed" | "failed" | "approval" | "artifact";
  message: string;
  createdAt: string;
  read: boolean;
}

// === Status Meta ===

const RUN_STATUS: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  pending: { label: "Pending", color: "#71717a", bg: "#f4f4f5", icon: "schedule" },
  planning: { label: "Planning", color: "#2563eb", bg: "#dbeafe", icon: "checklist" },
  executing: { label: "Executing", color: "#ea580c", bg: "#ffedd5", icon: "bolt" },
  verifying: { label: "Verifying", color: "#7c3aed", bg: "#ede9fe", icon: "search" },
  waiting_approval: { label: "Needs Review", color: "#b45309", bg: "#fef3c7", icon: "visibility" },
  completed: { label: "Done", color: "#15803d", bg: "#dcfce7", icon: "check_circle" },
  failed: { label: "Failed", color: "#b91c1c", bg: "#fee2e2", icon: "cancel" },
  cancelled: { label: "Cancelled", color: "#71717a", bg: "#f4f4f5", icon: "stop_circle" },
};

const TASK_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "Queued", color: "#71717a" },
  leased: { label: "Assigned", color: "#2563eb" },
  running: { label: "Working", color: "#ea580c" },
  waiting_approval: { label: "Review", color: "#b45309" },
  verifying: { label: "Verifying", color: "#7c3aed" },
  completed: { label: "Done", color: "#15803d" },
  failed: { label: "Failed", color: "#b91c1c" },
};

const ROLE_META: Record<string, { icon: string; label: string }> = {
  architect: { icon: "architecture", label: "Architect" },
  developer: { icon: "code", label: "Developer" },
  reviewer: { icon: "search", label: "Reviewer" },
  verifier: { icon: "check_circle", label: "Verifier" },
  browser: { icon: "language", label: "Browser" },
  researcher: { icon: "menu_book", label: "Researcher" },
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// === Spawn Dialog ===

function SpawnDialog({ onSpawn, onClose }: { onSpawn: (prompt: string, mode: string, model: string, schedule: "now" | "tonight") => void; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("code");
  const [model, setModel] = useState("auto");
  const [customMode, setCustomMode] = useState(false);
  const [schedule, setSchedule] = useState<"now" | "tonight">("now");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!prompt.trim()) return;
    const chosen = customMode && !model.trim() ? "auto" : model.trim();
    onSpawn(prompt.trim(), mode, chosen, schedule);
    onClose();
  };

  return (
    <div className="manager-spawn-overlay" onClick={onClose}>
      <div className="manager-spawn-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="manager-spawn-header">
          <h3><span className="ms">rocket_launch</span> Spawn Agent</h3>
          <button className="manager-spawn-close" onClick={onClose}><span className="ms">close</span></button>
        </div>

        <textarea
          ref={inputRef}
          className="manager-spawn-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the task for the agent to work on...&#10;&#10;Examples:&#10;• Fix the login form validation bug&#10;• Add unit tests for the API routes&#10;• Refactor the database layer to use transactions&#10;• Build a new dashboard page for analytics"
          rows={5}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
          }}
        />

        <div className="manager-spawn-options">
          <div className="manager-spawn-option">
            <label>Mode</label>
            <div className="manager-spawn-chips">
              {["ask", "plan", "code"].map((m) => (
                <button
                  key={m}
                  className={`manager-spawn-chip ${mode === m ? "active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m === "ask" ? (<><span className="ms">forum</span> Ask</>) : m === "plan" ? (<><span className="ms">checklist</span> Plan</>) : (<><span className="ms">bolt</span> Code</>)}
                </button>
              ))}
            </div>
          </div>

          <div className="manager-spawn-option">
            <label>Model</label>
            {customMode ? (
              <input
                className="manager-spawn-select"
                value={model}
                placeholder="e.g. anthropic/claude-sonnet-4 (BYOK — your key)"
                autoFocus
                onChange={(e) => setModel(e.target.value)}
                onBlur={(e) => { if (!e.target.value.trim()) { setModel("auto"); setCustomMode(false); } }}
              />
            ) : (
              <select
                className="manager-spawn-select"
                value={model}
                onChange={(e) => {
                  if (e.target.value === "__custom__") { setCustomMode(true); setModel(""); }
                  else setModel(e.target.value);
                }}
              >
                <option value="auto">Auto (provider default)</option>
                <option value="__custom__">Custom (BYOK model id)…</option>
              </select>
            )}
          </div>

          <div className="manager-spawn-option">
            <label>Schedule</label>
            <div className="manager-spawn-chips">
              <button
                className={`manager-spawn-chip ${schedule === "now" ? "active" : ""}`}
                onClick={() => setSchedule("now")}
              >
                <span className="ms ms-sm">bolt</span> Now
              </button>
              <button
                className={`manager-spawn-chip ${schedule === "tonight" ? "active" : ""}`}
                onClick={() => setSchedule("tonight")}
                title="Run overnight at 02:00 — the morning PR queue"
              >
                <span className="ms ms-sm">dark_mode</span> Tonight (02:00)
              </button>
            </div>
          </div>
        </div>

        <div className="manager-spawn-actions">
          <span className="manager-spawn-hint">⌘ + Enter to spawn</span>
          <button
            className="manager-spawn-btn"
            onClick={handleSubmit}
            disabled={!prompt.trim()}
          >
            Spawn Agent →
          </button>
        </div>
      </div>
    </div>
  );
}

// === Agent Card ===

function AgentCard({ run, onSelect, onKill }: {
  run: ManagerRun;
  onSelect: (runId: string) => void;
  onKill: (runId: string) => void;
}) {
  const status = RUN_STATUS[run.status] || RUN_STATUS.pending;
  const tasks = run.tasks || [];
  const doneCount = tasks.filter((t) => t.status === "completed").length;
  const progress = tasks.length > 0 ? (doneCount / tasks.length) * 100 : 0;

  return (
    <div
      className={`manager-card ${run.isActive ? "manager-card-active" : ""}`}
      data-active={run.isActive ? "true" : "false"}
      onClick={() => onSelect(run.id)}
    >
      {/* Status Bar */}
      <div className="manager-card-status" style={{ background: status.bg, color: status.color }}>
        <span className="manager-card-status-icon"><span className="ms">{status.icon}</span></span>
        <span className="manager-card-status-label" style={{ color: status.color }}>
          {status.label}
        </span>
        {run.pendingApprovalCount > 0 && (
          <span className="manager-card-approval-badge">
            {run.pendingApprovalCount} review{run.pendingApprovalCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Prompt */}
      <div className="manager-card-prompt">
        {run.prompt.length > 120 ? run.prompt.slice(0, 120) + "..." : run.prompt}
      </div>

      {/* Progress */}
      {tasks.length > 0 && (
        <div className="manager-card-progress">
          <div className="manager-card-progress-bar">
            <div
              className="manager-card-progress-fill"
              style={{ width: `${progress}%`, background: status.color }}
            />
          </div>
          <span className="manager-card-progress-text">
            {doneCount}/{tasks.length} tasks
          </span>
        </div>
      )}

      {/* Task Decomposition Preview */}
      {tasks.length > 1 && (
        <div className="manager-card-tasks">
          {tasks.slice(0, 4).map((task) => {
            const taskMeta = TASK_STATUS[task.status] || TASK_STATUS.pending;
            const roleMeta = ROLE_META[task.role] || { icon: "description", label: task.role };
            return (
              <div key={task.id} className="manager-card-task-row">
                <span className="manager-card-task-role"><span className="ms ms-sm">{roleMeta.icon}</span></span>
                <span className="manager-card-task-title">{task.title.slice(0, 40)}</span>
                <span className="manager-card-task-status" style={{ color: taskMeta.color }}>
                  {task.status === "running" ? <span className="ms ms-sm ms-spin">progress_activity</span> : task.status === "completed" ? <span className="ms ms-sm">check</span> : <span className="ms ms-sm">radio_button_unchecked</span>}
                </span>
              </div>
            );
          })}
          {tasks.length > 4 && (
            <div className="manager-card-task-more">+{tasks.length - 4} more</div>
          )}
        </div>
      )}

      {/* Meta */}
      <div className="manager-card-meta">
        <span>{run.estimatedCostLabel}</span>
        <span>•</span>
        <span>{timeAgo(run.createdAt)}</span>
        {run.artifactCount > 0 && (
          <>
            <span>•</span>
            <span><span className="ms">inventory_2</span> {run.artifactCount}</span>
          </>
        )}
      </div>

      {/* Kill button for active runs */}
      {run.isActive && (
        <button
          className="manager-card-kill"
          onClick={(e) => {
            e.stopPropagation();
            onKill(run.id);
          }}
          title="Cancel this agent"
        >
          ⏹
        </button>
      )}
    </div>
  );
}

// === Inbox Panel ===

function InboxPanel({ notifications, onMarkRead, onNavigate }: {
  notifications: Notification[];
  onMarkRead: (id: string) => void;
  onNavigate: (runId: string) => void;
}) {
  const unread = notifications.filter((n) => !n.read);

  return (
    <div className="manager-inbox">
      <div className="manager-inbox-header">
        <h4>📬 Inbox</h4>
        {unread.length > 0 && (
          <span className="manager-inbox-badge">{unread.length}</span>
        )}
      </div>
      <div className="manager-inbox-list">
        {notifications.length === 0 ? (
          <div className="manager-inbox-empty">No notifications yet</div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`manager-inbox-item ${n.read ? "" : "unread"}`}
              onClick={() => {
                onMarkRead(n.id);
                onNavigate(n.runId);
              }}
            >
              <div className="manager-inbox-item-icon">
                <span className="ms">{n.type === "completed" ? "check_circle" : n.type === "failed" ? "cancel" : n.type === "approval" ? "visibility" : "inventory_2"}</span>
              </div>
              <div className="manager-inbox-item-content">
                <div className="manager-inbox-item-message">{n.message}</div>
                <div className="manager-inbox-item-time">{timeAgo(n.createdAt)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// === Main Manager Component ===

export default function AgentManager() {
  const [runs, setRuns] = useState<ManagerRun[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSpawn, setShowSpawn] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  // Fetch runs
  const fetchRuns = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (filter === "active") params.set("status", "active");
      const res = await apiFetch(`/api/agent/runs?${params}`);
      const data = await res.json();
      if (data.success) {
        setRuns(data.runs || []);
      }
    } catch {}
    setLoading(false);
  }, [filter]);

  // Fetch notifications
  const fetchNotifications = useCallback(async () => {
    try {
      const res = await apiFetch("/api/agent/notifications?limit=20");
      const data = await res.json();
      if (data.success) {
        setNotifications(data.notifications || []);
      }
    } catch {}
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    setLoading(true);
    fetchRuns();
    fetchNotifications();
    const interval = setInterval(() => {
      fetchRuns();
      fetchNotifications();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchRuns, fetchNotifications]);

  // Provider badge (free tier vs BYOK) — fetched once.
  const [provider, setProvider] = useState<{ provider: string; model: string; budgetMode: string; keyPresent: boolean } | null>(null);
  useEffect(() => {
    apiFetch("/api/agent/provider-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d?.success ? setProvider(d) : null))
      .catch(() => {});
  }, []);

  // Spawn agent
  const handleSpawn = async (prompt: string, mode: string, model: string, schedule: "now" | "tonight") => {
    try {
      // 🌙 Morning PR queue: park the run until 02:00 local so the serial
      // executor sips through it overnight (8k-TPM compliant by construction).
      let notBefore: string | undefined;
      if (schedule === "tonight") {
        const tonight = new Date();
        tonight.setHours(2, 0, 0, 0);
        if (tonight.getTime() <= Date.now()) tonight.setDate(tonight.getDate() + 1);
        notBefore = tonight.toISOString();
      }
      const res = await apiFetch("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          mode,
          autonomyPolicy: "approval",
          ...(model && model !== "auto" ? { modelOverride: model } : {}),
          ...(notBefore ? { notBefore } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        fetchRuns();
        // Open the artifact panel for the new run
        try {
          const { openArtifactPanel } = await import("./AppLayout");
          openArtifactPanel(data.run.id);
        } catch {}
      }
    } catch {}
  };

  // Kill agent
  const handleKill = async (runId: string) => {
    try {
      await apiFetch(`/api/agent/runs/${runId}`, { method: "DELETE" });
      fetchRuns();
    } catch {}
  };

  // Mark notification read
  const handleMarkRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    try {
      await apiFetch(`/api/agent/notifications/${id}/read`, { method: "POST" });
    } catch {}
  };

  // Navigate to run
  const handleNavigate = async (runId: string) => {
    setSelectedRun(runId);
    try {
      const { openArtifactPanel } = await import("./AppLayout");
      openArtifactPanel(runId);
    } catch {}
  };

  // Filter runs
  const filteredRuns = runs.filter((r) => {
    if (filter === "active") return r.isActive;
    if (filter === "completed") return r.status === "completed" || r.status === "failed";
    return true;
  });

  const activeCount = runs.filter((r) => r.isActive).length;
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="manager-container">
      {/* Header */}
      <div className="manager-header">
        <div className="manager-header-left">
          <h2 className="manager-title">🎛️ Agent Manager</h2>
          <p className="manager-subtitle">
            {activeCount > 0
              ? `${activeCount} agent${activeCount > 1 ? "s" : ""} working`
              : "All agents idle"}
            {provider && (
              <span
                className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-label align-middle"
                style={{
                  background: provider.budgetMode === "byok" ? "rgba(16,185,129,.15)" : "rgba(99,102,241,.12)",
                  color: provider.budgetMode === "byok" ? "#10b981" : "#818cf8",
                }}
                title={provider.keyPresent ? `${provider.provider} · ${provider.model}` : `${provider.provider} — ${provider.budgetMode === "byok" ? "key missing" : "default key"}`}
              >
                {provider.budgetMode === "byok" ? "🔑 BYOK" : "🆓 Free tier"} · {provider.model}
              </span>
            )}
          </p>
        </div>

        <div className="manager-header-actions">
          {/* Inbox */}
          <button
            className="manager-inbox-btn"
            onClick={() => setShowInbox(!showInbox)}
          >
            📬
            {unreadCount > 0 && <span className="manager-inbox-btn-badge">{unreadCount}</span>}
          </button>

          {/* Filter */}
          <div className="manager-filter">
            {(["all", "active", "completed"] as const).map((f) => (
              <button
                key={f}
                className={`manager-filter-btn ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : f === "active" ? `Active (${activeCount})` : "Done"}
              </button>
            ))}
          </div>

          {/* Spawn */}
          <button className="manager-spawn-btn" onClick={() => setShowSpawn(true)}>
            + Spawn Agent
          </button>
        </div>
      </div>

      {/* Inbox Sidebar */}
      {showInbox && (
        <InboxPanel
          notifications={notifications}
          onMarkRead={handleMarkRead}
          onNavigate={handleNavigate}
        />
      )}

      {/* Run health — stuck / waiting-approval / needs-repair, one-click recovery */}
      <RunHealthStrip runs={runs} onChanged={fetchRuns} />

      {/* Agent Grid */}
      <div className="manager-grid">
        {loading ? (
          <div className="manager-loading">
            {[1, 2, 3].map((i) => (
              <div key={i} className="manager-card-skeleton" />
            ))}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="manager-empty">
            <div className="manager-empty-icon"><span className="ms ms-lg">rocket_launch</span></div>
            <h3>No agents {filter === "active" ? "working" : filter === "completed" ? "completed" : ""}</h3>
            <p>
              {filter === "active"
                ? "Spawn an agent to get started."
                : "Click \"Spawn Agent\" to dispatch your first task."}
            </p>
            <button className="manager-spawn-btn" onClick={() => setShowSpawn(true)}>
              + Spawn Agent
            </button>
          </div>
        ) : (
          filteredRuns.map((run) => (
            <AgentCard
              key={run.id}
              run={run}
              onSelect={handleNavigate}
              onKill={handleKill}
            />
          ))
        )}
      </div>

      {/* Spawn Dialog */}
      {showSpawn && (
        <SpawnDialog onSpawn={handleSpawn} onClose={() => setShowSpawn(false)} />
      )}
    </div>
  );
}
