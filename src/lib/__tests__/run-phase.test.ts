/**
 * run-phase.test.ts — The UI's per-turn status model.
 *
 * Every run-status surface (end-of-stream tail, sidebar card, composer Stop)
 * derives from the task store through deriveRunPhase(), so these mappings are
 * the contract: thinking → running_tool → streaming → done | error | stopped,
 * with no path left hanging on an in-flight phase.
 */
import { deriveRunPhase, runPhaseLabel, type BackgroundTask, type TaskStatus } from "../background-chat";

function task(status: TaskStatus, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "bg-1",
    conversationId: null,
    userMessage: "do the thing",
    messages: [],
    displayContent: "",
    status,
    statusDetail: "",
    startedAt: 0,
    todos: [],
    question: null,
    stats: { filesChanged: 0, commandsRun: 0, toolCalls: 0, rejectedActions: 0, failedSteps: 0 },
    mode: "code",
    ...overrides,
  };
}

describe("deriveRunPhase", () => {
  it("is idle without a task", () => {
    expect(deriveRunPhase(null)).toBe("idle");
  });

  it("reads streaming with no answer text yet as thinking", () => {
    expect(deriveRunPhase(task("streaming", { displayContent: "" }))).toBe("thinking");
    expect(deriveRunPhase(task("streaming", { displayContent: "   \n " }))).toBe("thinking");
  });

  it("reads streaming once the answer has started arriving", () => {
    expect(deriveRunPhase(task("streaming", { displayContent: "Here's the plan…" }))).toBe("streaming");
  });

  // The worker writes each turn's reasoning CLOSED, then appends answer text or
  // runs tools — so "content ends in a reasoning block" is the only reliable
  // signal that the model is thinking RIGHT NOW on a later turn, where the
  // transcript already holds the previous answer.
  it("reads a trailing closed reasoning block as thinking, not streaming", () => {
    expect(
      deriveRunPhase(
        task("streaming", { displayContent: "[THINKING]Should I use the plan tool?[/THINKING]" })
      )
    ).toBe("thinking");
    expect(
      deriveRunPhase(
        task("streaming", { displayContent: "[THINKING]checking\n\nstill checking  [/THINKING]   \n" })
      )
    ).toBe("thinking");
  });

  it("reads an in-flight (unclosed) reasoning block as thinking", () => {
    expect(deriveRunPhase(task("streaming", { displayContent: "[THINKING]and then…" }))).toBe("thinking");
    // A closed block from a PRIOR turn, then new reasoning opened after it.
    expect(
      deriveRunPhase(
        task("streaming", {
          displayContent: "[THINKING]done earlier[/THINKING]\n\nAnswer.\n[THINKING]now…",
        })
      )
    ).toBe("thinking");
  });

  it("reads answer text after a closed reasoning block as streaming", () => {
    expect(
      deriveRunPhase(
        task("streaming", {
          displayContent: "[THINKING]plan[/THINKING]\n\nStep one: scaffold the route.",
        })
      )
    ).toBe("streaming");
  });

  it("keeps tool execution ahead of the content heuristic", () => {
    expect(
      deriveRunPhase(task("tool_executing", { displayContent: "[THINKING]still reasoning[/THINKING]" }))
    ).toBe("running_tool");
  });

  it("reads tool execution and pending approval as running_tool", () => {
    expect(deriveRunPhase(task("tool_executing"))).toBe("running_tool");
    expect(deriveRunPhase(task("awaiting_approval"))).toBe("running_tool");
  });

  it("resolves to done", () => {
    expect(deriveRunPhase(task("done"))).toBe("done");
  });

  it("resolves a plain failure to error", () => {
    expect(deriveRunPhase(task("error", { error: "provider down" }))).toBe("error");
  });

  it("resolves an aborted failure to stopped, not error", () => {
    expect(deriveRunPhase(task("error", { aborted: true, statusDetail: "Cancelled" }))).toBe("stopped");
  });

  it("falls back to idle for an unknown status", () => {
    expect(deriveRunPhase(task("idle" as TaskStatus))).toBe("idle");
  });

  it("never returns a live phase for a terminal task", () => {
    const terminal = [task("done"), task("error"), task("error", { aborted: true })];
    for (const t of terminal) {
      const phase = deriveRunPhase(t);
      expect(["done", "error", "stopped"]).toContain(phase);
    }
  });
});

describe("runPhaseLabel", () => {
  it("labels every phase", () => {
    expect(runPhaseLabel("thinking")).toBe("Thinking…");
    expect(runPhaseLabel("running_tool")).toBe("Working…");
    expect(runPhaseLabel("streaming")).toBe("Responding…");
    expect(runPhaseLabel("done")).toBe("Done");
    expect(runPhaseLabel("error")).toBe("Failed");
    expect(runPhaseLabel("stopped")).toBe("Stopped");
    expect(runPhaseLabel("idle")).toBe("");
  });
});
