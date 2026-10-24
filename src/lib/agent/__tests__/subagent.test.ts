// subagent.test.ts — spawn_subagent mini-loop: sandbox, final answer, caps.
import { runSubagent, SUBAGENT_ALLOWED_TOOLS } from "../subagent";

// Markup built from pieces so the transcript itself never contains a literal
// tool-call tag sequence.
const TC_OPEN = "<" + "tool_call" + ">";
const TC_CLOSE = "<" + "/tool_call" + ">";

describe("runSubagent", () => {
  it("refuses an empty task honestly", async () => {
    const out = await runSubagent(
      { callModel: async () => ({ content: "noop" }), dispatch: async () => "unused" },
      { task: "" }
    );
    expect(out).toMatch(/requires a task/i);
  });

  it("treats model prose with no tool calls as the final answer", async () => {
    const out = await runSubagent(
      { callModel: async () => ({ content: "found 3 call sites" }), dispatch: async () => "unused" },
      { task: "find usages of X" }
    );
    expect(out).toBe("found 3 call sites");
  });

  it("dispatches discovery calls through the gate and folds results", async () => {
    const dispatched: string[] = [];
    const toolCallXml =
      TC_OPEN + JSON.stringify({ name: "search_code", query: "foo" }) + TC_CLOSE;
    let round = 0;
    const out = await runSubagent(
      {
        callModel: async () => {
          round++;
          return { content: round === 1 ? toolCallXml : "matches: src/a.ts:1" };
        },
        dispatch: async (call) => {
          dispatched.push(call.name);
          return '<tool_result name="search_code">matches: src/a.ts:1</tool_result>';
        },
      },
      { task: "where is foo" }
    );
    expect(dispatched).toEqual(["search_code"]);
    expect(out).toBe("matches: src/a.ts:1");
  }, 15000);

  it("refuses non-discovery tool names before they reach the parent", async () => {
    const dispatched: string[] = [];
    const bogusXml = TC_OPEN + JSON.stringify({ name: "write_file", path: "x.ts", content: "hi" }) + TC_CLOSE;
    const out = await runSubagent(
      {
        callModel: async () => ({ content: bogusXml }),
        dispatch: async (call) => {
          dispatched.push(call.name);
          return "<tool_result>should never happen</tool_result>";
        },
      },
      { task: "write a file" }
    );
    // The subagent gate refuses the call BEFORE the parent's dispatcher sees
    // it — the parent dispatch stays untouched (defense in depth).
    expect(dispatched).toEqual([]);
    expect(out).toMatch(/refused/);
  });

  it("reports the turn cap honestly when the model never answers", async () => {
    const out = await runSubagent(
      {
        callModel: async () => ({ content: "" }),
        dispatch: async () => "<tool_result>nothing</tool_result>",
      },
      { task: "research something", maxTurns: 2 }
    );
    expect(out).toMatch(/without a definitive answer|stopped after/i);
  }, 15000);

  it("the sandbox allowlist is genuinely read-only", async () => {
    expect(SUBAGENT_ALLOWED_TOOLS.has("write_file")).toBe(false);
    expect(SUBAGENT_ALLOWED_TOOLS.has("run_command")).toBe(false);
    expect(SUBAGENT_ALLOWED_TOOLS.has("spawn_subagent")).toBe(false);
    expect(SUBAGENT_ALLOWED_TOOLS.has("read_file")).toBe(true);
  });

  it("returns trailing prose from a markup-first turn instead of demanding refusal", async () => {
    const findings = "findings: the auth module caches tokens at src/auth.ts:12 and src/auth.ts:40";
    const mixedXml =
      TC_OPEN + JSON.stringify({ name: "write_file", path: "x.ts", content: "hi" }) + TC_CLOSE + "\n" + findings;
    const dispatched: string[] = [];
    const out = await runSubagent(
      {
        callModel: async () => ({ content: mixedXml }),
        dispatch: async (call) => {
          dispatched.push(call.name);
          return "<tool_result>nothing</tool_result>";
        },
      },
      { task: "explain auth" }
    );
    expect(out).toBe(findings);
  }, 15000);

  it("never leaks tool-call markup trailing real prose into findings", async () => {
    const dangling = "answer: it lives in src/auth.ts";
    const leaked = dangling + TC_OPEN + JSON.stringify({ name: "search_code", query: "auth" });
    let round = 0;
    const out = await runSubagent(
      {
        callModel: async () => {
          round++;
          return { content: round === 1 ? leaked : dangling };
        },
        dispatch: async () => "<tool_result>nothing</tool_result>",
      },
      { task: "where does it live" }
    );
    expect(out).not.toMatch(/tool_call/);
    expect(out).toBe(dangling);
  }, 15000);
});
