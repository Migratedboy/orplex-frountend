"use client";
import React from "react";

interface QuickActionsProps {
  onAction: (action: string) => void;
  hasFiles: boolean;
  isRunning: boolean;
}

export default function QuickActions({ onAction, hasFiles, isRunning }: QuickActionsProps) {
  if (isRunning) return null;

  const actions = [
    { id: "fix-bugs", label: "Fix bugs", icon: "W" },
    { id: "add-tests", label: "Add tests", icon: "T" },
    { id: "optimize", label: "Optimize", icon: "O" },
    { id: "export", label: "Export .zip", icon: "E" },
    { id: "regenerate", label: "Regenerate", icon: "R" },
  ];

  return (
    <div className="qa-bar">
      {actions.map((action) => (
        <button
          key={action.id}
          onClick={() => onAction(action.id)}
          disabled={!hasFiles && action.id !== "regenerate"}
          className="qa-chip"
        >
          <span className="qa-chip-badge">{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>
  );
}
