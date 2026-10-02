"use client";

import { useCallback } from "react";
import {
  guidanceOrFallback,
  RECOVERY_ACTION_META,
  recoveryTarget,
  type ErrorGuidance,
  type RecoveryActionId,
} from "@/lib/error-guidance";
import LatticeLoader from "./LatticeLoader";

// StateViews.tsx — the shared loading / empty / error contract.
//
// Every major surface (Chat, Manager, RightPanel tabs, DiffView, Terminal)
// renders the same three primitives so the product reads as one app instead
// of five panels that each invented their own blank state. The error view is
// wired to lib/error-guidance: short actionable copy + one-click recovery,
// never a raw stack trace as the first thing the user sees.

export interface StateAction {
  label: string;
  onClick: () => void;
  /** Renders as the filled primary button. */
  primary?: boolean;
}

interface BaseProps {
  /** Material Symbols icon name (rendered via the `.ms` class). */
  icon?: string;
  title: string;
  hint?: string;
  actions?: StateAction[];
  className?: string;
}

function StateShell({ icon, title, hint, actions, className, tone }: BaseProps & { tone?: "error" }) {
  return (
    <div
      className={`state-view ${tone === "error" ? "state-view--error" : ""} ${className || ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {icon && (
        <div className={`state-view-icon ${tone === "error" ? "state-view-icon--error" : ""}`}>
          <span className="ms ms-lg">{icon}</span>
        </div>
      )}
      <div className="state-view-title">{title}</div>
      {hint && <div className="state-view-hint">{hint}</div>}
      {actions && actions.length > 0 && (
        <div className="state-view-actions">
          {actions.map((a, i) => (
            <button
              key={i}
              className={`state-view-btn ${a.primary ? "state-view-btn--primary" : ""}`}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared loading state — one LatticeLoader treatment everywhere. */
export function LoadingView({ label = "Working…", hint, className }: { label?: string; hint?: string; className?: string }) {
  return (
    <div className={`state-view state-view--loading ${className || ""}`} role="status" aria-live="polite">
      <LatticeLoader status="working" showTimer={false} cellSize={6} grid={3} />
      <div className="state-view-title">{label}</div>
      {hint && <div className="state-view-hint">{hint}</div>}
    </div>
  );
}

/** Shared empty state — icon + one-liner + optional next action. */
export function EmptyView(props: BaseProps) {
  return <StateShell {...props} />;
}

/** Dispatches the window event or navigates for a recovery action id. */
function useRecoveryRunner() {
  return useCallback((id: RecoveryActionId) => {
    const target = recoveryTarget(id);
    if (target.href) {
      // In-app deep link — same tab, keeps session state.
      window.location.assign(target.href);
      return;
    }
    if (target.event) {
      window.dispatchEvent(new CustomEvent(target.event));
    }
  }, []);
}

/**
 * Shared error state. Give it whatever raw error text you have (message,
 * terminal output, HTTP body); it matches known failure modes and renders
 * short copy + one-click recovery. Unknown errors get the honest generic
 * entry instead of jargon.
 */
export function ErrorView({
  error,
  title,
  retry,
  className,
}: {
  /** Raw error text (message / output / body). Matched against known failure modes. */
  error?: string | null;
  /** Overrides the matched/generic title (rare — prefer the guidance copy). */
  title?: string;
  /** Adds a first-class Retry button wired by the caller. */
  retry?: () => void;
  className?: string;
}) {
  const runRecovery = useRecoveryRunner();
  const g: ErrorGuidance = guidanceOrFallback(error);
  const actions: StateAction[] = [];
  if (retry) actions.push({ label: "Retry", onClick: retry, primary: true });
  for (const id of g.actions) {
    if (id === "retry" && retry) continue; // caller's Retry already covers it
    const meta = RECOVERY_ACTION_META[id];
    actions.push({ label: meta.label, onClick: () => runRecovery(id) });
  }
  return (
    <StateShell
      tone="error"
      icon={g === null ? "error" : "report"}
      title={title || g.title}
      hint={`${g.what} ${g.fix}`}
      actions={actions}
      className={className}
    />
  );
}

/** Compact inline error line for tight spaces (tool rows, board cards). */
export function ErrorInline({ error }: { error?: string | null }) {
  const g = guidanceOrFallback(error);
  return (
    <span className="state-inline-error" title={`${g.what} ${g.fix}`}>
      <span className="ms ms-sm" aria-hidden="true">report</span> {g.title}
    </span>
  );
}
