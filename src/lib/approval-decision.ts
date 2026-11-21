// approval-decision.ts — the command-approval decision state machine.
//
// Pure on purpose: the card host dispatches events, this module decides what
// the card shows next. `submit` is accepted ONLY from the prompt phase, which
// is what makes a double-click / rapid Enter harmless — the second event is
// dropped instead of resolving the request twice.

export type ApprovalChoice = "allow" | "deny" | "always";

export type DecisionPhase = "prompt" | "submitting" | "result" | "error";

export interface DecisionState {
  phase: DecisionPhase;
  /** The choice being sent, or the one that was accepted. */
  choice: ApprovalChoice | null;
  /** Inline error text; the card stays open so the user can retry. */
  error: string | null;
}

export type DecisionEvent =
  | { type: "submit"; choice: ApprovalChoice }
  | { type: "resolved" }
  | { type: "failed"; error: string }
  | { type: "retry" }
  | { type: "reset" };

export const initialDecisionState: DecisionState = { phase: "prompt", choice: null, error: null };

export function canDecide(state: DecisionState): boolean {
  return state.phase === "prompt";
}

export function reduceDecision(state: DecisionState, event: DecisionEvent): DecisionState {
  switch (event.type) {
    case "submit":
      if (state.phase !== "prompt") return state;
      return { phase: "submitting", choice: event.choice, error: null };
    case "resolved":
      if (state.phase !== "submitting") return state;
      return { phase: "result", choice: state.choice, error: null };
    case "failed":
      return {
        phase: "error",
        choice: null,
        error: event.error.trim() || "Something went wrong. Try again.",
      };
    case "retry":
      return state.phase === "error" ? { ...initialDecisionState } : state;
    case "reset":
      return { ...initialDecisionState };
    default:
      return state;
  }
}
