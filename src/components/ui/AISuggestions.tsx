"use client";
import React, { useState } from "react";

interface Suggestion {
  id: string;
  type: "refactor" | "performance" | "security" | "test" | "docs";
  message: string;
  file?: string;
  applied?: boolean;
}

interface AISuggestionsProps {
  suggestions: Suggestion[];
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
}

const TYPE_STYLES: Record<string, { bg: string; text: string; icon: string }> = {
  refactor: { bg: "bg-blue-50 dark:bg-blue-900/20", text: "text-blue-700 dark:text-blue-300", icon: "R" },
  performance: { bg: "bg-yellow-50 dark:bg-yellow-900/20", text: "text-yellow-700 dark:text-yellow-300", icon: "P" },
  security: { bg: "bg-red-50 dark:bg-red-900/20", text: "text-red-700 dark:text-red-300", icon: "S" },
  test: { bg: "bg-green-50 dark:bg-green-900/20", text: "text-green-700 dark:text-green-300", icon: "T" },
  docs: { bg: "bg-purple-50 dark:bg-purple-900/20", text: "text-purple-700 dark:text-purple-300", icon: "D" },
};

export default function AISuggestions({ suggestions, onApply, onDismiss }: AISuggestionsProps) {
  const [expanded, setExpanded] = useState(true);
  const pending = suggestions.filter((s) => !s.applied);
  if (pending.length === 0) return null;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 text-sm"
      >
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {pending.length} suggestion{pending.length > 1 ? "s" : ""}
        </span>
        <span className="text-xs text-gray-500">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded && (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {pending.map((s) => {
            const style = TYPE_STYLES[s.type] || TYPE_STYLES.refactor;
            return (
              <div key={s.id} className={`flex items-start gap-3 px-4 py-3 ${style.bg}`}>
                <span className={`w-6 h-6 flex items-center justify-center rounded text-xs font-bold ${style.text} bg-white dark:bg-gray-800`}>
                  {style.icon}
                </span>
                <div className="flex-1">
                  <p className="text-sm text-gray-700 dark:text-gray-300">{s.message}</p>
                  {s.file && <p className="text-xs text-gray-500 mt-0.5">{s.file}</p>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => onApply(s.id)} className="px-2 py-1 text-xs bg-orange-500 text-white rounded hover:bg-orange-600">Apply</button>
                  <button onClick={() => onDismiss(s.id)} className="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-300">Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
