import { captureActivityTiming, combineActivityGroups, formatActivityTime, type ActivityGroup } from "../activity";
import { parseContent } from "../message-content";

function activityGroups(content: string, live = false) {
  return parseContent(content, { activity: true, live, startedAt: 1000 })
    .filter((segment) => segment.type === "activity")
    .map((segment) => segment.activity!);
}

describe("chat activity parsing", () => {
  it("combines split activity groups into one message-level timeline and duration", () => {
    const groups: ActivityGroup[] = [
      {
        id: "activity-0",
        startedAt: 1000,
        endedAt: 1500,
        steps: [{
          id: "activity-0-step-0",
          kind: "think",
          title: "Thinking",
          status: "done",
          startedAt: 1000,
          endedAt: 1500,
        }],
      },
      {
        id: "activity-1",
        startedAt: 2000,
        endedAt: 2800,
        steps: [{
          id: "activity-1-step-0",
          kind: "read",
          title: "Read",
          status: "done",
          startedAt: 2000,
          endedAt: 2800,
        }],
      },
    ];

    expect(combineActivityGroups(groups)).toMatchObject({
      id: "activity-message",
      startedAt: 1000,
      endedAt: 2800,
      steps: [{ id: "activity-0-step-0" }, { id: "activity-1-step-0" }],
    });
  });

  it("keeps a combined timeline open when one activity group is still live", () => {
    const combined = combineActivityGroups([
      { id: "activity-0", startedAt: 1000, steps: [] },
      {
        id: "activity-1",
        startedAt: 1000,
        endedAt: 1500,
        steps: [{
          id: "activity-1-step-0",
          kind: "read",
          title: "Read",
          status: "done",
          startedAt: 1000,
          endedAt: 1500,
        }],
      },
    ]);

    expect(combined).not.toHaveProperty("endedAt");
  });

  it("groups adjacent activity and keeps prose outside the timeline", () => {
    const segments = parseContent(
      "listing [src]\n[SUCCESS] Listed 1 folder\nHere is the result.\nreading [src/a.ts]\n[OK] Read `src/a.ts` (lines 1-10)",
      { activity: true }
    );

    expect(segments.map((segment) => segment.type)).toEqual(["activity", "text", "activity"]);
    expect(segments[0].activity?.steps[0]).toMatchObject({
      kind: "list",
      title: "Listed",
      status: "done",
    });
    expect(segments[1].content).toBe("Here is the result.");
  });

  it("maps tool calls and results into an expandable step", () => {
    const group = activityGroups(
      '<tool_call>{"name":"search_code","query":"retry policy"}</tool_call>\n<tool_result>3 matches</tool_result>',
      true
    )[0];

    expect(group.steps).toHaveLength(1);
    expect(group.steps[0]).toMatchObject({
      kind: "search",
      title: "Searched",
      chip: "retry policy",
      meta: "3 matches",
      status: "done",
    });
    expect(group.steps[0].body).toContain('"name": "search_code"');
  });

  it("pairs parallel tool results with the matching path instead of FIFO order", () => {
    const group = activityGroups([
      "reading [src/a.ts]",
      "reading [src/b.ts]",
      "[OK] Read `src/b.ts`",
      "[OK] Read `src/a.ts`",
    ].join("\n"))[0];

    expect(group.steps).toHaveLength(2);
    expect(group.steps.map((step) => [step.chip, step.body])).toEqual([
      ["src/a.ts", "Read `src/a.ts`"],
      ["src/b.ts", "Read `src/b.ts`"],
    ]);
  });

  it("shows a live step until its result arrives and records elapsed time", () => {
    const initial = activityGroups("running [npm test]", true);
    expect(initial[0].steps[0].status).toBe("live");
    const timing = captureActivityTiming(
      parseContent("running [npm test]", { activity: true, live: true }),
      undefined,
      1000,
      false
    );
    const completed = parseContent("running [npm test]\n[OK] Tests passed", {
      activity: true,
      activityTiming: timing,
    });
    const completedTiming = captureActivityTiming(completed, timing, 1850, false);

    expect(completed[0].activity?.steps[0].status).toBe("done");
    expect(completedTiming.steps["activity-0-step-0"]).toEqual({ startedAt: 1000, endedAt: 1850 });
    expect(formatActivityTime(0)).toBe("");
    expect(formatActivityTime(50)).toBe("<0.1s");
    expect(formatActivityTime(850)).toBe("0.9s");
  });

  it("caps long output with an explicit truncation notice", () => {
    const result = `[OK] ${"output ".repeat(800)}`;
    const group = activityGroups(result)[0] as ActivityGroup;
    expect(group.steps[0].body).toHaveLength(4011);
    expect(group.steps[0].body?.endsWith("… truncated")).toBe(true);
  });

  it("leaves legacy parser consumers unchanged unless activity grouping is requested", () => {
    expect(parseContent("[OK] Read `file.ts`").map((segment) => segment.type)).toEqual(["success"]);
  });
});
