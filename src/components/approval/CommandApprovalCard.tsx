"use client";

/**
 * CommandApprovalCard — the "agent wants to run a command" card.
 *
 * Presentation only: the host owns polling, rule storage, resolution and the
 * dismiss timer. Visual contract is design/orplex-approval.html (330px card,
 * header bar, title, risk line, dark command box, Deny/Allow/Always allow),
 * minus its demo-only reset loop, replay hint and page background.
 */
import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { ApprovalChoice, DecisionState } from "@/lib/approval-decision";
import styles from "./CommandApprovalCard.module.css";

export interface CommandApprovalCardProps {
  /** The exact command text sent by the agent (already a string). */
  command: string;
  /** e.g. "Medium risk. Shell command execution." */
  riskLine: string;
  /** Always-allow is offered only for safe, non-plan-gate commands. */
  canAlwaysAllow: boolean;
  state: DecisionState;
  onDecide: (choice: ApprovalChoice) => void;
}

const RESULT_LABEL: Record<ApprovalChoice, string> = {
  allow: "Allowed",
  always: "Always allowed",
  deny: "Denied",
};

export default function CommandApprovalCard({
  command,
  riskLine,
  canAlwaysAllow,
  state,
  onDecide,
}: CommandApprovalCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const riskId = useId();
  const commandId = useId();
  // In the error phase the buttons stay live so the user can retry.
  const busy = state.phase === "submitting" || state.phase === "result";

  // Focus moves into the card when it opens.
  useEffect(() => {
    const first = cardRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
  }, []);

  const decide = useCallback(
    (choice: ApprovalChoice) => {
      if (state.phase !== "prompt") return;
      onDecide(choice);
    },
    [onDecide, state.phase]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (state.phase !== "prompt") return;
      if (event.key === "Escape") {
        event.preventDefault();
        decide("deny");
        return;
      }
      if (event.key === "Enter") {
        // Enter = Allow anywhere in the dialog, including over a focused button
        // (space still activates the focused button natively).
        event.preventDefault();
        decide("allow");
        return;
      }
      if (event.key === "Tab") {
        // Keep keyboard focus inside the dialog while it owns the decision.
        const buttons = Array.from(
          cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
        );
        if (buttons.length === 0) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (active === first || !cardRef.current?.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    [decide, state.phase]
  );

  const shortCommand = command.length > 64 ? `${command.slice(0, 61)}…` : command;

  if (state.phase === "result" && state.choice) {
    const denied = state.choice === "deny";
    return (
      <div className={styles.overlay} role="presentation">
        <div
          ref={cardRef}
          className={`${styles.card} ${styles.result} ${denied ? styles.denied : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={RESULT_LABEL[state.choice]}
        >
          <div className={styles.badge} aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path d={denied ? "M7 7l10 10M17 7L7 17" : "M5 12.5l5 5L19.5 7"} />
            </svg>
          </div>
          <div className={styles.label} role="status" aria-live="polite">
            {RESULT_LABEL[state.choice]}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay} role="presentation">
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={riskId}
        onKeyDown={onKeyDown}
      >
        <div className={styles.prompt}>
          <div className={styles.bar}>
            <span className={styles.brand}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 15px static app icon; next/image adds no value here */}
              <img className={styles.logo} src="/logo.png" alt="" width={15} height={15} />
              Orplex
            </span>
            <span className={styles.origin}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              orplex://approve
            </span>
          </div>

          <h2 id={titleId} className={styles.title} title={command}>
            <b>Orplex Code</b> wants to run {shortCommand}
          </h2>
          <p id={riskId} className={styles.risk}>{riskLine}</p>

          <div className={styles.detail}>
            <div className={styles.cmd} id={commandId} title={command} tabIndex={0} aria-label={`Command: ${command}`}>
              <span className={styles.cmdPrompt} aria-hidden="true">$</span>
              <span className={styles.cmdText}>{command}</span>
            </div>
          </div>

          {state.phase === "error" && state.error ? (
            <p className={styles.error} role="alert">{state.error}</p>
          ) : null}

          {canAlwaysAllow ? null : (
            <p className={styles.hint}>This command is too risky to allow automatically.</p>
          )}

          <div className={styles.actions}>
            <button type="button" className={`${styles.btn} ${styles.deny}`} onClick={() => decide("deny")} disabled={busy}>
              Deny
            </button>
            <button type="button" className={`${styles.btn} ${styles.allow}`} onClick={() => decide("allow")} disabled={busy}>
              Allow
            </button>
            {canAlwaysAllow ? (
              <button type="button" className={`${styles.btn} ${styles.always}`} onClick={() => decide("always")} disabled={busy}>
                Always allow
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
