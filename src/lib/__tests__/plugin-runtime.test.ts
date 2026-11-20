// plugin-runtime.test.ts — the built-in plugin HOOKS, exercised through the
// same two-step the app performs (activate closure + registry.activatePlugin).
//
// Two plugins were registered, enabled by default, and did nothing useful:
//   - path-traversal early-returned unless a workspace root had been set, and
//     nothing ever set it;
//   - response-cache answered a hit with `continue: false` and no payload, so
//     the agent received an empty "BLOCKED by plugin".
import { activatePathTraversal, isEscapingPath } from "../plugins/builtin/path-traversal-plugin";
import { activateResponseCache } from "../plugins/builtin/response-cache-plugin";
import { afterToolCall, beforeToolCall, pluginRegistry } from "../plugins/registry";

describe("path-traversal plugin", () => {
  beforeAll(async () => {
    await activatePathTraversal();
    await pluginRegistry.activatePlugin("path-traversal");
  });

  it("recognises every escaping shape without needing a workspace root", () => {
    for (const p of ["../secret", "a/../../b", "/etc/passwd", "C:\\Windows\\win.ini", "C:/Windows", "\\\\server\\share\\x"]) {
      expect(isEscapingPath(p)).toBe(true);
    }
    for (const p of ["src/app/page.tsx", "a..b.ts", "src/a..b/c.ts", "./notes.md"]) {
      expect(isEscapingPath(p)).toBe(false);
    }
  });

  it("blocks a write that leaves the workspace and says why", async () => {
    const out = await beforeToolCall("write_file", { path: "../outside.txt", content: "x" });
    expect(out._blocked).toBe(true);
    expect(out._reason).toMatch(/leaves the workspace/);
  });

  it("allows ordinary relative paths and non-path tools", async () => {
    expect((await beforeToolCall("write_file", { path: "src/app/page.tsx", content: "x" }))._blocked).toBe(false);
    expect((await beforeToolCall("run_command", { command: "npm test" }))._blocked).toBe(false);
  });
});

describe("response-cache plugin", () => {
  beforeAll(async () => {
    await activateResponseCache();
    await pluginRegistry.activatePlugin("response-cache");
  });

  it("returns the cached payload on a hit instead of an empty block", async () => {
    const args = { path: "cached-file.ts" };
    expect((await beforeToolCall("read_file", args))._blocked).toBe(false);
    await afterToolCall("read_file", args, "CACHED BODY");

    const hit = await beforeToolCall("read_file", args);
    expect(hit._blocked).toBe(true);
    expect(hit._response).toBe("CACHED BODY");
  });

  it("does not serve one tool's cached result to another tool", async () => {
    const args = { path: "shared-args" };
    await beforeToolCall("read_file", args);
    await afterToolCall("read_file", args, "READ RESULT");

    const other = await beforeToolCall("write_file", args);
    expect(other._blocked).toBe(false);
    expect(other._response).toBeUndefined();
  });

  it("treats different arguments as different entries", async () => {
    expect((await beforeToolCall("read_file", { path: "other-file.ts" }))._blocked).toBe(false);
  });
});
