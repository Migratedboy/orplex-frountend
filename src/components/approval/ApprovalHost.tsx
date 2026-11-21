"use client";

/**
 * ApprovalHost — the single owner of pending tool approvals in the renderer.
 *
 * It replaces ApprovalDialog: one poll of the SDK approval store (the worker
 * runs in this same realm, so the store IS the source of truth), one queue, one
 * decision path. Command approvals render as CommandApprovalCard; every other
 * approval (file writes/edits, MCP tools) keeps its existing card.
 *
 * "Always allow" rules are app-owned (src/lib/approval-rules.ts), scoped to the
 * exact command and the current workspace. A matching command is resolved here
 * before it is ever shown, so the card is skipped and the agent loop continues
 * normally — the command still appears in the tool-call log because the tool
 * call itself is unchanged.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveRequest,
  approveRequestAlways,
  getPendingApprovals,
  rejectRequest,
  type PendingApproval,
} from "@/lib/approval-store";
import { classifyRisk } from "@/lib/risk-classifier";
import { apiFetch } from "@/lib/api-base";
import {
  addRule,
  canAlwaysAllow,
  describeCommandRisk,
  findRule,
  migrateLegacyCommandRules,
  normalizeCommand,
  normalizeWorkspace,
} from "@/lib/approval-rules";
import {
  initialDecisionState,
  reduceDecision,
  type ApprovalChoice,
  type DecisionState,
} from "@/lib/approval-decision";
import { useFileSystemContext } from "../FileSystemProvider";
import CommandApprovalCard from "./CommandApprovalCard";
import ActionApprovalCard from "./ActionApprovalCard";

const POLL_MS = 400;
/** How long the Allowed/Denied badge stays up before the card dismisses itself. */
const RESULT_MS = 1200;

function isPlanGate(approval: PendingApproval): boolean {
  return approval.details?.planGate === true;
}

function commandOf(approval: PendingApproval): string {
  return normalizeCommand(approval.details?.command);
}

export default function ApprovalHost() {
  const { directoryName } = useFileSystemContext();
  const workspaceRef = useRef(normalizeWorkspace(null));
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [current, setCurrent] = useState<PendingApproval | null>(null);
  const [decision, setDecision] = useState<DecisionState>(initialDecisionState);

  const currentRef = useRef<PendingApproval | null>(null);
  const decisionRef = useRef<DecisionState>(initialDecisionState);
  const resolvingRef = useRef(false);
  const resultTimerRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    decisionRef.current = decision;
  }, [decision]);

  // Workspace identity for rule scoping, plus the one-time migration of the old
  // SDK command rules (which were unscoped and prefix-matched).
  useEffect(() => {
    workspaceRef.current = normalizeWorkspace(directoryName);
    try {
      migrateLegacyCommandRules(workspaceRef.current);
    } catch {
      /* storage unavailable — rules simply do not apply; the card still works */
    }
  }, [directoryName]);

  const clearResultTimer = useCallback(() => {
    if (resultTimerRef.current !== null) {
      window.clearTimeout(resultTimerRef.current);
      resultTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearResultTimer(), [clearResultTimer]);

  // One poll for the whole app: rule matches are resolved before they are ever
  // shown, everything else goes to the (stable-identity) queue.
  useEffect(() => {
    let alive = true;

    const tick = () => {
      if (!alive) return;
      const pending = getPendingApprovals();
      const ws = workspaceRef.current;
      const shown: PendingApproval[] = [];

      for (const approval of pending) {
        const command = commandOf(approval);
        if (
          approval.type === "run_command" &&
          command &&
          !isPlanGate(approval) &&
          findRule(command, ws)
        ) {
          // Already allowed for this workspace: run it, no card.
          approveRequest(approval.id);
          continue;
        }
        shown.push(approval);
      }

      setQueue((prev) => {
        if (prev.length === shown.length && prev.every((a, i) => a.id === shown[i].id)) return prev;
        return shown;
      });

      // The open request vanished (Stop/cancel/timeout/session end) — close it.
      const open = currentRef.current;
      if (
        open &&
        decisionRef.current.phase === "prompt" &&
        !shown.some((a) => a.id === open.id)
      ) {
        setCurrent(null);
        setDecision({ ...initialDecisionState });
        resolvingRef.current = false;
      }
    };

    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // Show exactly one approval at a time.
  useEffect(() => {
    if (current) return;
    const next = queue[0];
    if (!next) return;
    setCurrent(next);
    setDecision({ ...initialDecisionState });
    resolvingRef.current = false;
  }, [queue, current]);

  // Focus: capture where the user was when the card opens, and return to the
  // prompt input when it closes.
  useEffect(() => {
    if (current) {
      if (!previousFocusRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
      }
      return;
    }
    if (!previousFocusRef.current) return;
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    const prompt = document.querySelector<HTMLElement>(".prompt-bar__input");
    if (prompt && document.contains(prompt)) prompt.focus();
    else if (previous && document.contains(previous)) previous.focus();
  }, [current]);

  const dismiss = useCallback(
    (approval: PendingApproval) => {
      setQueue((prev) => prev.filter((a) => a.id !== approval.id));
      setCurrent(null);
      setDecision({ ...initialDecisionState });
      resolvingRef.current = false;
    },
    []
  );

  const decide = useCallback(
    (choice: ApprovalChoice) => {
      const approval = currentRef.current;
      if (!approval) return;
      // Double-clicks and rapid key presses land here after the first one has
      // already started resolving — drop them.
      if (resolvingRef.current) return;
      if (decisionRef.current.phase !== "prompt" && decisionRef.current.phase !== "error") return;
      resolvingRef.current = true;

      setDecision((prev) =>
        reduceDecision(
          prev.phase === "error" ? reduceDecision(prev, { type: "retry" }) : prev,
          { type: "submit", choice }
        )
      );

      const command = commandOf(approval);

      try {
        if (choice === "always" && approval.type === "run_command") {
          if (isPlanGate(approval) || !canAlwaysAllow(command)) {
            throw new Error("This command is too risky to allow automatically.");
          }
          // Persist FIRST: if storage is unavailable the user sees the error
          // and the request stays open instead of silently not being remembered.
          addRule(command, workspaceRef.current);
        }

        let accepted: boolean;
        if (choice === "deny") {
          accepted = rejectRequest(approval.id);
        } else if (choice === "always" && approval.type !== "run_command") {
          accepted = approveRequestAlways(approval.id);
        } else {
          accepted = approveRequest(approval.id);
        }
        if (!accepted) throw new Error("This request is no longer pending.");

        // Server-side parity for the /api/agent/approve fallback list. The
        // local store is the authority (worker + dialog share this realm), so a
        // failure here cannot lose the decision.
        void apiFetch("/api/agent/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: approval.id, action: choice === "deny" ? "reject" : "approve" }),
        }).catch(() => {});

        setDecision((prev) => reduceDecision(prev, { type: "resolved" }));

        if (approval.type === "run_command") {
          // Play the result badge once, then dismiss and show the next request.
          clearResultTimer();
          resultTimerRef.current = window.setTimeout(() => {
            resultTimerRef.current = null;
            dismiss(approval);
          }, RESULT_MS);
        } else {
          dismiss(approval);
        }
      } catch (err) {
        resolvingRef.current = false;
        const message = err instanceof Error ? err.message : "Could not complete the decision. Try again.";
        setDecision((prev) => reduceDecision(prev, { type: "failed", error: message }));
      }
    },
    [clearResultTimer, dismiss]
  );

  if (!current) return null;

  if (current.type !== "run_command") {
    return (
      <ActionApprovalCard
        approval={current}
        busy={decision.phase === "submitting" || decision.phase === "result"}
        onDecide={decide}
      />
    );
  }

  const command = commandOf(current);
  const risk = current.riskReason
    ? { level: current.risk, reason: current.riskReason }
    : classifyRisk("run_command", { command });
  const showAlways = !isPlanGate(current) && canAlwaysAllow(command);

  return (
    <CommandApprovalCard
      command={command}
      riskLine={describeCommandRisk(risk.level, risk.reason)}
      canAlwaysAllow={showAlways}
      state={decision}
      onDecide={decide}
    />
  );
}
