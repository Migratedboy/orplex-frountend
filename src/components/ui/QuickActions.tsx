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
    <div className="flex flex-wrap gap-2 mb-3">
      {actions.map((action) => (
        <button
          key={action.id}
          onClick={() => onAction(action.id)}
          disabled={!hasFiles && action.id !== "regenerate"}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="w-4 h-4 flex items-center justify-center bg-gray-200 dark:bg-gray-600 rounded text-[10px] font-bold">
            {action.icon}
          </span>
          {action.label}
        </button>
      ))}
    </div>
  );
}
