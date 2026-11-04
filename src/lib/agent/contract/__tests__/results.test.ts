// results.test.ts — the shared <tool_result> envelope + the lane parity map.
//
// formatToolResult is the ONE envelope both execution modes are supposed to
// use; today the client worker (native-tools.ts) and the server executor
// (executor.ts) still hand-build their strings inline. This test pins the
// shared formatter's exact output AND documents each lane's dialect delta,
// so the migration can proceed call-site by call-site with a safety net:
// any future adoption that changes model-visible bytes fails here loudly.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("lane parity map — dialect deltas that the migration reconciled", () => {
  const out = "tool output";

  it("client worker generic envelope (native-tools.ts) === shared formatter with a \\n-wrapped body", () => {
    // native-tools.ts:450: `<tool_result name="${call.name}">\n${out}\n</tool_result>\n`
    const clientInline = `<tool_result name="edit_file">\n${out}\n</tool_result>\n`;
    expect(clientInline).toBe(formatToolResult("edit_file", {}, `\n${out}\n`));
  });

  it("server executor sites NOW use the shared formatter (migration done)", () => {
    // The executor's 14 inline templates were adopted onto formatToolResult /
    // formatToolError. Two deliberate model-visible byte changes came with it,
    // exactly as this map predicted: every result gained the trailing "\n",
    // and the "error: " prefix became the shared "error - " dialect.
    const executorInline = `<tool_result name="edit_file">${out}</tool_result>`;
    expect(executorInline + "\n").toBe(formatToolResult("edit_file", {}, out));
    expect(formatToolError("edit_file", {}, "exploded")).toBe(
      `<tool_result name="edit_file">error - exploded</tool_result>\n`
    );
  });

  it("GUARD: executor.ts must not hand-build tool_result envelopes anymore", () => {
    // Text-level regression guard (same technique as run-state-isolation):
    // a new inline `<tool_result ...>` template in the executor would silently
    // reintroduce the two-dialect problem this migration removed.
    const src = readFileSync(join(__dirname, "..", "..", "..", "server-executor", "executor.ts"), "utf8");
    expect(src).not.toMatch(/<tool_result/);
    expect(src).toMatch(/formatToolResult/);
  });
});
