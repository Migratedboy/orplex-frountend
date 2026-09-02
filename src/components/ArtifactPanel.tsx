"use client";

import { useState, useEffect } from "react";
import ArtifactCard from "./ArtifactCard";
import { estimateCostFromTotal, formatCost } from "@/lib/cost-estimator";

// === Types ===

interface Artifact {
  id: string;
  kind: string;
  name: string;
  content: string;
  mediaType: string;
  createdAt: string;
}

interface AgentTask {
  id: string;
  role: string;
  title: string;
  status: string;
  error?: string | null;
  artifacts: Artifact[];
  createdAt: string;
}

interface AgentRun {
  id: string;
  status: string;
  prompt: string;
  tasks: AgentTask[];
  tokenUsage?: number;
  createdAt: string;
}

interface ArtifactPanelProps {
  open: boolean;
  runId: string | null;
  onClose: () => void;
}

// === Role Config ===

const ROLE_ICONS: Record<string, string> = {
  code: "CODE",
  browser: "WEB",
  research: "DOC",
  architect: "ARCH",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-on-surface-variant",
  running: "text-primary-container animate-pulse",
  done: "text-emerald-500",
  failed: "text-red-400",
};

// === Component ===

export default function ArtifactPanel({ open, runId, onClose }: ArtifactPanelProps) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);

  // Fetch run data when panel opens
  useEffect(() => {
    if (!open || !runId) {
      setRun(null);
      return;
    }

    setLoading(true);
    fetch(`/api/agent/runs/${runId}`)
      .then((res) => res.json())
      .then((data) => {
        setRun(data.run || null);
        if (data.run?.tasks?.length > 0) {
          setSelectedTask(data.run.tasks[0].id);
        }
      })
      .catch(() => setRun(null))
      .finally(() => setLoading(false));
  }, [open, runId]);

  // Poll for updates while run is active
  useEffect(() => {
    if (!open || !runId || !run || run.status === "done" || run.status === "failed") return;

    const interval = setInterval(() => {
      fetch(`/api/agent/runs/${runId}`)
        .then((res) => res.json())
        .then((data) => setRun(data.run || null))
        .catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [open, runId, run?.status]);

  const selectedTaskData = run?.tasks?.find((t) => t.id === selectedTask);

  return (
    <div className={`artifact-panel ${open ? "open" : ""}`}>
      {/* Panel Header */}
      <div className="artifact-panel-header">
        <div className="artifact-panel-title">
          <span className="artifact-panel-icon" style={{fontSize: '11px', fontFamily: 'monospace', opacity: 0.6}}>[R]</span>
          <span>Agent Artifacts</span>
        </div>
        <button onClick={onClose} className="artifact-panel-close">
          ✕
        </button>
      </div>

      {/* Panel Content */}
      <div className="artifact-panel-body">
        {loading ? (
          <div className="artifact-panel-loading">Loading artifacts...</div>
        ) : !run ? (
          <div className="artifact-panel-empty">
            <span className="text-[11px] font-mono opacity-40">[R]</span>
            <p>No agent run selected.</p>
            <p className="text-on-surface-variant text-[11px]">
              Run an agent task to see artifacts here.
            </p>
          </div>
        ) : (
          <>
            {/* Run Summary */}
            <div className="artifact-panel-summary">
              <div className="artifact-panel-prompt">
                {run.prompt.slice(0, 100)}
                {run.prompt.length > 100 && "..."}
              </div>
              <div className="artifact-panel-status">
                <span className={`text-[10px] font-label ${STATUS_COLORS[run.status] || ""}`}>
                  {run.status}
                </span>
                {typeof run.tokenUsage === "number" && run.tokenUsage > 0 && (
                  <span
                    className="text-[9px] font-mono text-emerald-600 dark:text-emerald-400"
                    title={`~${run.tokenUsage.toLocaleString()} tokens`}
                  >
                    {formatCost(estimateCostFromTotal(run.tokenUsage))}
                  </span>
                )}
                <span className="text-[9px] text-on-surface-variant">
                  {new Date(run.createdAt).toLocaleTimeString()}
                </span>
              </div>
            </div>

            {/* Task Tabs */}
            <div className="artifact-panel-tabs">
              {run.tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => setSelectedTask(task.id)}
                  className={`artifact-panel-tab ${
                    selectedTask === task.id ? "active" : ""
                  }`}
                >
                  <span>{ROLE_ICONS[task.role] || "FILE"}</span>
                  <span className="artifact-panel-tab-label">
                    {task.title.slice(0, 20)}
                  </span>
                  <span className={`artifact-panel-tab-status ${STATUS_COLORS[task.status] || ""}`}>
                    {task.status === "done" ? "✓" : task.status === "failed" ? "✗" : task.status === "running" ? "○" : "·"}
                  </span>
                </button>
              ))}
            </div>

            {/* Selected Task Artifacts */}
            {selectedTaskData && (
              <div className="artifact-panel-artifacts">
                {selectedTaskData.artifacts.length === 0 ? (
                  <div className="artifact-panel-no-artifacts">
                    {selectedTaskData.status === "running"
                      ? "Task is running... artifacts will appear here."
                      : selectedTaskData.status === "failed"
                      ? `Task failed: ${selectedTaskData.error || "Unknown error"}`
                      : "No artifacts produced."}
                  </div>
                ) : (
                  (selectedTaskData.artifacts as Artifact[]).map((artifact) => (
                    <ArtifactCard key={artifact.id} artifact={artifact} />
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
