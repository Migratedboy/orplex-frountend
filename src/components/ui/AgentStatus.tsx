"use client";
import React from "react";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: "active" | "waiting" | "done" | "error";
  currentTask?: string;
  progress?: number;
}

interface AgentStatusProps {
  agents: Agent[];
  visible: boolean;
}

export default function AgentStatus({ agents, visible }: AgentStatusProps) {
  if (!visible || agents.length === 0) return null;

  const roleIcons: Record<string, string> = {
    coordinator: "C",
    planner: "P",
    coder: "< />",
    reviewer: "R",
    tester: "T",
  };

  const statusClass: Record<string, string> = {
    active: "as-dot--active",
    waiting: "",
    done: "as-dot--done",
    error: "as-dot--error",
  };

  return (
    <div className="as-card">
      <div className="as-head">
        <span>Agent Status</span>
        <span className="as-count">{agents.filter((a) => a.status === "active").length} active</span>
      </div>
      <div className="as-list">
        {agents.map((agent) => (
          <div key={agent.id} className="as-row">
            <span className={`as-dot ${statusClass[agent.status] ?? ""}`} />
            <span className="as-role">{roleIcons[agent.role] || agent.role}</span>
            <span className="as-name">{agent.name}</span>
            {agent.currentTask && <span className="as-task">{agent.currentTask}</span>}
            {agent.progress !== undefined && (
              <div className="as-track">
                <div className="as-fill" style={{ width: `${agent.progress}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
