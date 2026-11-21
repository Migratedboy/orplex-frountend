/**
 * Decision state machine: allow / deny / always, cancel, and the double-submit
 * guard. Pure reducer, no DOM.
 */
import {
  canDecide,
  initialDecisionState,
  reduceDecision,
  type DecisionState,
} from "../approval-decision";

function submit(state: DecisionState, choice: "allow" | "deny" | "always") {
  return reduceDecision(state, { type: "submit", choice });
}

function resolved(state: DecisionState) {
  return reduceDecision(state, { type: "resolved" });
}

describe("approval decision state machine", () => {
  it("starts in the prompt phase", () => {
    expect(initialDecisionState).toEqual({ phase: "prompt", choice: null, error: null });
    expect(canDecide(initialDecisionState)).toBe(true);
  });

  it.each(["allow", "deny", "always"] as const)("submits and resolves %s", (choice) => {
    const submitted = submit(initialDecisionState, choice);
    expect(submitted.phase).toBe("submitting");
    expect(submitted.choice).toBe(choice);
    expect(canDecide(submitted)).toBe(false);

    const done = resolved(submitted);
    expect(done.phase).toBe("result");
    expect(done.choice).toBe(choice);
  });

  it("ignores a double submit (rapid click / Enter twice)", () => {
    const first = submit(initialDecisionState, "allow");
    const second = submit(first, "deny");
    expect(second).toBe(first);

    const afterResult = submit(resolved(first), "deny");
    expect(afterResult.phase).toBe("result");
    expect(afterResult.choice).toBe("allow");
  });

  it("ignores a resolution that was not submitted", () => {
    expect(resolved(initialDecisionState)).toBe(initialDecisionState);
  });

  it("keeps the card open on failure and retries from the prompt phase", () => {
    const failed = reduceDecision(submit(initialDecisionState, "always"), {
      type: "failed",
      error: "Could not save the allow rule: QuotaExceededError",
    });
    expect(failed.phase).toBe("error");
    expect(failed.choice).toBeNull();
    expect(failed.error).toMatch(/Could not save/);
    expect(canDecide(failed)).toBe(false);

    const retried = reduceDecision(failed, { type: "retry" });
    expect(retried).toEqual(initialDecisionState);
    expect(submit(retried, "always").phase).toBe("submitting");
  });

  it("falls back to readable copy for an empty error", () => {
    const failed = reduceDecision(submit(initialDecisionState, "allow"), { type: "failed", error: "  " });
    expect(failed.error).toBe("Something went wrong. Try again.");
  });

  it("resets to the prompt phase when a request is cancelled or replaced", () => {
    const submitted = submit(initialDecisionState, "deny");
    expect(reduceDecision(submitted, { type: "reset" })).toEqual(initialDecisionState);
    expect(reduceDecision(resolved(submitted), { type: "reset" })).toEqual(initialDecisionState);
  });
});
