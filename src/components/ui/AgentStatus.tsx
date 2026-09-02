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

  const statusColors: Record<string, string> = {
    active: "bg-orange-500",
    waiting: "bg-gray-400",
    done: "bg-green-500",
    error: "bg-red-500",
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden mb-4">
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center justify-between">
        <span>Agent Status</span>
        <span className="text-xs text-gray-500">{agents.filter((a) => a.status === "active").length} active</span>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center gap-3 px-4 py-2">
            <span className={`w-2 h-2 rounded-full ${statusColors[agent.status]} ${agent.status === "active" ? "animate-pulse" : ""}`} />
            <span className="w-12 text-xs font-mono text-gray-500">{roleIcons[agent.role] || agent.role}</span>
            <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{agent.name}</span>
            {agent.currentTask && (
              <span className="text-xs text-gray-500 truncate max-w-48">{agent.currentTask}</span>
            )}
            {agent.progress !== undefined && (
              <div className="w-16 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${agent.progress}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
