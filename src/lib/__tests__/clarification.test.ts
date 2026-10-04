/**
 * clarification.test.ts — The ask_clarification contract.
 *
 * The tool pauses the run (status waiting_for_input), the UI shows the
 * message-stream ClarificationCard, and the answered exchange is folded back
 * into the display transcript as a `[CLARIFIED]:{json}` marker so the compact
 * record survives saveConversation + reload. These tests pin the three seams:
 * marker parsing, the run-phase mapping while waiting, and the tool roster.
 */
import { parseContent } from "../message-content";
import { CLARIFICATION_SKIP, deriveRunPhase, type BackgroundTask, type TaskStatus } from "../background-chat";
import { M3_TOOL_DEFINITIONS, GROQ_TOOL_NAMES } from "../tool-definitions";

function markerLine(payload: Record<string, unknown>): string {
  return `[CLARIFIED]:${JSON.stringify(payload)}`;
}

function clarifiedOf(raw: string) {
  return parseContent(raw).find((s) => s.type === "clarified");
}

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

describe("[CLARIFIED] marker parsing", () => {
  it("parses a full record into a clarified segment with question, context and answer", () => {
    const raw = [
      "clarifying [commit message]",
      markerLine({ q: "Ship the commit as-is?", c: "Commit message reads 'fix stuff'", a: "Yes, ship it" }),
      "[OK] wrote [src/app/page.tsx]",
    ].join("\n");

    expect(clarifiedOf(raw)).toMatchObject({
      type: "clarified",
      data: { q: "Ship the commit as-is?", c: "Commit message reads 'fix stuff'", a: "Yes, ship it" },
    });
  });

  it("keeps a record without context as q/a only", () => {
    const segment = clarifiedOf(markerLine({ q: "Two variants?", a: "Variant B" }));
    expect(segment?.type).toBe("clarified");
    if (segment?.type !== "clarified" || !segment.data) throw new Error("expected clarified segment");
    expect(segment.data.a).toBe("Variant B");
    expect("c" in segment.data).toBe(false);
  });

  it("round-trips answers and questions containing quotes, slashes and newlines", () => {
    const q = 'Say "go"\nThen: C:\\Users\\test';
    const a = 'He said "yes" \\ then \'done\'';
    const segment = clarifiedOf(markerLine({ q, c: "multi\nline context", a }));
    expect(segment).toMatchObject({ data: { q, c: "multi\nline context", a } });
  });

  it("drops malformed markers instead of rendering the raw payload", () => {
    expect(clarifiedOf(`[CLARIFIED]:definitely not json\nprose after`)).toBeUndefined();
    expect(clarifiedOf(`[CLARIFIED]:${JSON.stringify({ q: "no answer" })}`)).toBeUndefined();
    expect(clarifiedOf(`[CLARIFIED]:${JSON.stringify({ a: "no question" })}`)).toBeUndefined();
    expect(parseContent(`[CLARIFIED]:bad\nstill here`).some((s) => s.type === "text" && s.content.includes("still here"))).toBe(true);
  });

  it("leaves the marker line out of the surrounding text segments", () => {
    const raw = `Before the ask.\n${markerLine({ q: "Continue?", a: "Yes" })}\nAfter the answer.`;
    const segments = parseContent(raw);
    expect(segments.filter((s) => s.type === "clarified")).toHaveLength(1);
    // The raw marker only lives on the clarified segment (which renders from
    // its parsed `data`); no text segment echoes it back to the user.
    expect(segments.filter((s) => s.type !== "clarified").some((s) => s.content.includes("[CLARIFIED]"))).toBe(false);
    expect(segments.some((s) => s.content.includes("Before the ask."))).toBe(true);
    expect(segments.some((s) => s.content.includes("After the answer."))).toBe(true);
  });
});

describe("waiting_for_input run phase", () => {
  it("derives running_tool while the run is parked on a clarification", () => {
    expect(deriveRunPhase(task("waiting_for_input"))).toBe("running_tool");
    expect(
      deriveRunPhase(
        task("waiting_for_input", {
          question: { question: "Which one?", options: [], allowFreeText: true, answered: false, kind: "clarification" },
        }),
      ),
    ).toBe("running_tool");
  });

  it("resolves terminal statuses to terminal phases", () => {
    expect(deriveRunPhase(task("done"))).toBe("done");
    expect(deriveRunPhase(task("error"))).toBe("error");
  });
});

describe("tool roster", () => {
  it("advertises ask_clarification on the M3 roster with question+context required", () => {
    const def = M3_TOOL_DEFINITIONS.find((t: any) => t.function?.name === "ask_clarification");
    expect(def).toBeDefined();
    expect(def?.function?.parameters?.required).toEqual(["question", "context"]);
    expect(GROQ_TOOL_NAMES).toContain("ask_clarification");
  });

  it("exports a skip sentinel distinct from any real answer", () => {
    expect(CLARIFICATION_SKIP).toBe("__orplex_clarification_skip__");
  });
});
