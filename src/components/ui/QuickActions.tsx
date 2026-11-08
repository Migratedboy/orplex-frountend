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
   fallbackSuggestions?: string[];
  /**
   * True while /api/chat/suggestions is generating → the five chip slots
   * render as skeleton pills with a three-dot wave animation instead of
   * text, then swap to the real suggestions when they arrive.
   */
  loadingSuggestions?: boolean;
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

/** Skeleton pill widths (px) — hint at where the real text will land. */
const LOADER_WIDTHS = [78, 96, 70, 88, 64];

export default function QuickActions({
  onAction,
  hasFiles,
  isRunning,
  suggestions,
  fallbackSuggestions,
  loadingSuggestions,
}: QuickActionsProps) {
  if (isRunning) return null;

  // Generating → five non-interactive skeleton chips, each pulsing a
  // three-dot wave for its slot. No text, nothing clickable.
  if (loadingSuggestions) {
    const widths = fallbackSuggestions?.length
      ? LOADER_WIDTHS.slice(0, fallbackSuggestions.length)
      : LOADER_WIDTHS;
    return (
      <div className="qa-bar" aria-busy="true">
        {widths.map((w, i) => (
          <span
            key={`qa-load-${i}`}
            className="qa-chip qa-chip--smart qa-chip--loading"
            style={{ width: w }}
          >
            <span className="qa-dot-wave" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </span>
        ))}
      </div>
    );
  }

  const useSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  const hasFallbackSuggestions = Array.isArray(fallbackSuggestions) && fallbackSuggestions.length > 0;
  const chips = useSuggestions
    ? suggestions.slice(0, 3).map((s, i) => ({ id: s, label: s, icon: "✦", key: `${i}:${s}` }))
    : hasFallbackSuggestions
      ? fallbackSuggestions.slice(0, 3).map((s, i) => ({ id: s, label: s, icon: "✦", key: `${i}:${s}` }))
      : STATIC_ACTIONS.map((a) => ({ ...a, key: a.id }));

  return (
    <div className="qa-bar">
      {chips.map((action) => (
        <button
          key={action.key}
          onClick={() => onAction(action.id)}
          disabled={!useSuggestions && !hasFallbackSuggestions && !hasFiles && !ALWAYS_AVAILABLE.has(action.id)}
          className={`qa-chip${useSuggestions || hasFallbackSuggestions ? " qa-chip--smart" : ""}`}
          title={useSuggestions ? "AI-suggested next step" : undefined}
        >
          <span className="qa-chip-badge">{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>
  );
}
