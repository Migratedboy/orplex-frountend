"use client";
import React from "react";

interface QuickActionsProps {
  onAction: (action: string) => void;
  hasFiles: boolean;
  isRunning: boolean;
  /**
   * AI-generated follow-up prompts from /api/chat/suggestions, refreshed after
   * every finished message. Empty/absent → the static utility chips render so
   * the bar never goes blank (offline, cold key, before the first answer).
   */
  suggestions?: string[];
}

const STATIC_ACTIONS = [
  { id: "fix-bugs", label: "Fix bugs", icon: "W" },
  { id: "add-tests", label: "Add tests", icon: "T" },
  { id: "optimize", label: "Optimize", icon: "O" },
  { id: "export", label: "Export .zip", icon: "E" },
  { id: "regenerate", label: "Regenerate", icon: "R" },
];

/** Exports stay actionable regardless of context; the rest need files. */
const ALWAYS_AVAILABLE = new Set(["export", "regenerate"]);

export default function QuickActions({ onAction, hasFiles, isRunning, suggestions }: QuickActionsProps) {
  if (isRunning) return null;

  const useSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const chips = useSuggestions
    ? suggestions.slice(0, 5).map((s, i) => ({ id: s, label: s, icon: "✦", key: `${i}:${s}` }))
    : STATIC_ACTIONS.map((a) => ({ ...a, key: a.id }));

  return (
    <div className="qa-bar">
      {chips.map((action) => (
        <button
          key={action.key}
          onClick={() => onAction(action.id)}
          disabled={!useSuggestions && !hasFiles && !ALWAYS_AVAILABLE.has(action.id)}
          className={`qa-chip${useSuggestions ? " qa-chip--smart" : ""}`}
          title={useSuggestions ? "AI-suggested next step" : undefined}
        >
          <span className="qa-chip-badge">{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>
  );
}
