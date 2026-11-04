// results.test.ts — the shared <tool_result> envelope + the lane parity map.
//
// formatToolResult is the ONE envelope both execution modes are supposed to
// use; today the client worker (native-tools.ts) and the server executor
// (executor.ts) still hand-build their strings inline. This test pins the
// shared formatter's exact output AND documents each lane's dialect delta,
// so the migration can proceed call-site by call-site with a safety net:
// any future adoption that changes model-visible bytes fails here loudly.

import { formatToolError, formatToolResult } from "../results";

describe("formatToolResult — the shared envelope", () => {
  it("emits <tool_result name=...>body</tool_result> with a trailing newline", () => {
    expect(formatToolResult("read_file", {}, "file body")).toBe(
      `<tool_result name="read_file">file body</tool_result>\n`
    );
  });

  it("skips undefined/null/empty attributes, renders the rest in insertion order", () => {
    expect(
      formatToolResult("run_command", { command: "npm test", cwd: undefined, note: null, tag: "" }, "ok")
    ).toBe(`<tool_result name="run_command" command="npm test">ok</tool_result>\n`);
  });

  it("escapes XML attribute values (name included) — raw strings go in safely", () => {
    expect(formatToolResult(`we"ird<name`, { url: `https://x.com/a?b=1&c=2<d` }, "body")).toBe(
      `<tool_result name="we&quot;ird&lt;name" url="https://x.com/a?b=1&amp;c=2&lt;d">body</tool_result>\n`
    );
  });

  it("passes the body through untouched (lane budgets own truncation)", () => {
    expect(formatToolResult("t", {}, "line1\nline2\n")).toBe(
      `<tool_result name="t">line1\nline2\n</tool_result>\n`
    );
  });

  it("defaults to an empty body and empty attrs", () => {
    expect(formatToolResult("solo")).toBe(`<tool_result name="solo"></tool_result>\n`);
  });
});

describe("formatToolError — the error shorthand", () => {
  it("wraps the message as 'error - <message>'", () => {
    expect(formatToolError("run_command", { command: "boom" }, "exit 1")).toBe(
      `<tool_result name="run_command" command="boom">error - exit 1</tool_result>\n`
    );
  });
});

describe("lane parity map — what each lane hand-builds today (migration deltas)", () => {
  const out = "tool output";

  it("client worker generic envelope (native-tools.ts) === shared formatter with a \\n-wrapped body", () => {
    // native-tools.ts:450: `<tool_result name="${call.name}">\n${out}\n</tool_result>\n`
    const clientInline = `<tool_result name="edit_file">\n${out}\n</tool_result>\n`;
    expect(clientInline).toBe(formatToolResult("edit_file", {}, `\n${out}\n`));
  });

  it("server executor plain envelope (executor.ts) === shared formatter MINUS the trailing newline", () => {
    // executor.ts:1737: `<tool_result name="${name}">${toolOut}</tool_result>`
    const executorInline = `<tool_result name="edit_file">${out}</tool_result>`;
    // The dialect delta is exactly the trailing "\n" — migrating this call
    // site adds a byte the model will see, which is why adoption is a
    // deliberate per-lane change, not a mechanical swap.
    expect(executorInline + "\n").toBe(formatToolResult("edit_file", {}, out));
    expect(executorInline).not.toBe(formatToolResult("edit_file", {}, out));
  });

  it("both lanes' error dialects ('error: msg') map onto formatToolError with a prefix delta", () => {
    // executor.ts:1739: `<tool_result name="${name}">error: ${msg}</tool_result>`
    // The shared formatter emits "error - msg" — the client dialect. The
    // executor's "error: " prefix is the remaining delta to reconcile.
    const executorError = `<tool_result name="edit_file">error: exploded</tool_result>`;
    expect(executorError).toBe(`<tool_result name="edit_file">error: exploded</tool_result>`);
    expect(formatToolError("edit_file", {}, "exploded")).toBe(
      `<tool_result name="edit_file">error - exploded</tool_result>\n`
    );
  });
});
