// user-hooks-spawn.test.ts — the hook runner for REAL: spawn, output capture,
// and the pre-tool exit-2 block.
//
// Written after an audit found that on Windows every hook command containing
// double quotes was mangled by Node's cmd.exe re-quoting: `node -e
// "process.exit(2)"` exited 0 with empty output, so `pre-tool` hooks installed
// by a plugin bundle could never block a call. The runner now passes the
// command line to cmd.exe verbatim.
jest.mock("@/lib/runtime-log", () => ({ recordRuntimeLog: jest.fn() }));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearUserHookCache, runUserHooks } from "@/lib/user-hooks";

/** A cross-platform hook command that runs JS through the current node binary. */
function nodeHook(js: string): string {
  // Node's own path is quoted because it can contain spaces on Windows; every
  // string literal inside `js` uses single quotes so no nested `"` is needed.
  return `"${process.execPath}" -e "${js}"`;
}

describe("runUserHooks (real child processes)", () => {
  let ws = "";

  const writeHooks = (hooks: unknown[]) => {
    fs.mkdirSync(path.join(ws, ".orplex"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".orplex", "hooks.json"), JSON.stringify({ hooks }), "utf8");
    clearUserHookCache();
  };

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "orplex-hook-spawn-"));
    process.env.ORPLEX_USER_HOOKS = "1";
    clearUserHookCache();
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.ORPLEX_USER_HOOKS;
  });

  it("blocks a pre-tool call when the hook exits 2", async () => {
    writeHooks([{ event: "pre-tool", match: "run_command", command: nodeHook("process.exit(2)") }]);
    const res = await runUserHooks(ws, "pre-tool", { tool: "run_command" });
    expect(res.ran).toBe(true);
    expect(res.blocked).toBe(true);
  });

  it("does not block when the hook exits 0", async () => {
    writeHooks([{ event: "pre-tool", match: "run_command", command: nodeHook("process.exit(0)") }]);
    const res = await runUserHooks(ws, "pre-tool", { tool: "run_command" });
    expect(res.ran).toBe(true);
    expect(res.blocked).toBe(false);
  });

  it("captures quoted-command output for post-tool hooks", async () => {
    writeHooks([{ event: "post-tool", command: nodeHook("console.log('post-ran')") }]);
    const res = await runUserHooks(ws, "post-tool", { tool: "write_file" });
    expect(res.ran).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.output).toContain("post-ran");
  });

  it("ignores hooks whose match does not cover the tool", async () => {
    writeHooks([{ event: "pre-tool", match: "run_command", command: nodeHook("process.exit(2)") }]);
    const res = await runUserHooks(ws, "pre-tool", { tool: "read_file" });
    expect(res).toEqual({ ran: false, blocked: false, output: "" });
  });
});
