/**
 * dispatch-surface.test.ts — THE contract that makes any native-tools split
 * safe (Operation Modularity prerequisite).
 *
 * native-tools.ts is a single 42-branch if-chain. Splitting it into capability
 * modules risks a tool silently falling through to the unknown-tool refusal —
 * which no per-branch test would catch. These tests pin the SURFACE:
 *
 *  1. every tool name in M3_TOOL_DEFINITIONS (the 42-tool source of truth)
 *     routes through dispatchToolCall without throwing and produces a
 *     well-formed envelope naming that tool;
 *  2. the incomplete-args recognition map (REQUIRED_NATIVE_TOOL_ARGS) stays
 *     in sync with the roster — a known tool with missing args gets the
 *     honest "INCOMPLETE" refusal (blocked: true), never the roster message;
 *  3. the ONLY roster tools allowed to reach the unknown-tool refusal with
 *     empty args are the two documented fall-throughs (apply_edit_ops is
 *     gate-gated on `ops`; spawn_subagent is a server-lane tool with no
 *     client-lane branch).
 *
 * All calls use EMPTY args on purpose: routing is exercised without running
 * execs, network calls, or browser launches.
 */
import { dispatchToolCall, type ToolContext } from "../native-tools";
import { M3_TOOL_DEFINITIONS } from "../../tool-definitions";
import type { ToolCall } from "../../stream-reader";

jest.mock("@/lib/api-base", () => ({
  // If a branch ever reaches the network in these tests, fail loudly instead
  // of hanging on a real request.
  apiFetch: jest.fn(() => {
    throw new Error("dispatch-surface test reached the network — args were supposed to route to a local refusal");
  }),
  withApiBase: (p: string) => p,
  API_BASE: "",
}));

const TOOL_NAMES: string[] = M3_TOOL_DEFINITIONS.map((d: any) => d.function?.name ?? "").filter(Boolean);

/** Minimal ToolContext — no filesystem, fake store, no scratchpad writes. */
function makeCtx(): ToolContext {
  const displays: string[] = [];
  let display = "";
  const written = new Map<string, string>();
  let totalWrites = 0;
  return {
    mode: "code",
    readFiles: new Map<string, number>(),
    contextFiles: new Map<string, string>(),
    readResults: new Map<string, string>(),
    abortSignal: null,
    fs: { readFile: null, writeFile: null, editFile: null, directoryName: "" },
    counters: {
      writtenFiles: written,
      getTotalWrites: () => totalWrites,
      setTotalWrites: (n: number) => { totalWrites = n; },
      setFilesChanged: () => {},
      bumpStat: () => {},
    },
    fileTree: [],
    fileContents: {},
    store: {
      setTodos: () => {},
      completeTodo: () => {},
      clearTodos: () => {},
      setQuestion: () => {},
      answerQuestion: () => {},
    },
    stats: { commandRun: () => {}, failedStep: () => {}, rejectedAction: () => {} },
    hooks: { fileWritten: () => {}, fileEdited: () => {} },
    scratchpad: {
      get: () => ({ sections: {} }) as never,
      update: () => {},
    },
    getDisplay: () => display,
    appendDisplay: (t: string) => { display += t; },
    replaceStatus: () => {},
    syncDisplay: () => { displays.push(display); },
    setStatus: () => {},
    waitForAnswer: async () => "(test)",
  } as unknown as ToolContext;
}

const emptyCall = (name: string): ToolCall => ({ name } as ToolCall);

describe("dispatch surface — every defined tool routes (the split-safety contract)", () => {
  it("M3_TOOL_DEFINITIONS still exposes 42 tools (the source of truth)", () => {
    expect(TOOL_NAMES).toHaveLength(42);
  });

  it.each(TOOL_NAMES)("routes %s without throwing and names it in the envelope", async (name) => {
    const outcome = await dispatchToolCall(emptyCall(name), makeCtx());
    expect(typeof outcome.resultXml).toBe("string");
    expect(outcome.resultXml).toContain(`name="${name}"`);
  });
});

describe("incomplete-args recognition stays in sync with the roster", () => {
  // The dispatcher's own map — mirrored here so a drift breaks a test instead
  // of shipping a mangled-args call as "tool not available".
  //
  // NOTE: the write-family (write_file, write_file_chunk, edit_file,
  // batch_edit, undo_last_change) checks the no-folder gate BEFORE its arg
  // check, so with empty args those names produce the truthful "no folder is
  // open" refusal — the workspace-gate tests (no-workspace-write.test.ts) pin
  // that. Only the read/search/exec/preview family reaches the INCOMPLETE map.
  const REQUIRED_ARGS_TOOLS = [
    "read_file", "extract_archive", "create_file", "search_code", "code_search",
    "web_search", "run_command", "run_in_sandbox", "take_screenshot", "preview_browser",
  ];

  it.each(REQUIRED_ARGS_TOOLS)("%s with missing args gets the honest INCOMPLETE refusal", async (name) => {
    const outcome = await dispatchToolCall(emptyCall(name), makeCtx());
    expect(outcome.resultXml).toMatch(/INCOMPLETE/);
    expect(outcome.blocked).toBe(true);
  });

  it("write-family tools gate on the workspace BEFORE args (no-folder refusal with empty args)", async () => {
    for (const name of ["write_file", "write_file_chunk", "edit_file", "batch_edit", "undo_last_change"]) {
      const outcome = await dispatchToolCall(emptyCall(name), makeCtx());
      expect(outcome.resultXml).toMatch(/no folder is open/);
      expect(outcome.resultXml).not.toMatch(/not available in this environment/);
    }
  });

  it("every tool in the recognition map is a real roster tool (no ghosts)", () => {
    // If a name is removed from M3_TOOL_DEFINITIONS but stays in the map, the
    // map is lying about the environment.
    for (const name of [...REQUIRED_ARGS_TOOLS, "write_file", "write_file_chunk", "edit_file", "batch_edit", "undo_last_change"]) {
      expect(TOOL_NAMES).toContain(name);
    }
  });
});

describe("no roster tool silently falls through to the unknown-tool refusal", () => {
  // Documented fall-through with empty args (shipped behavior):
  //  - spawn_subagent: server-lane tool — the client dispatcher has no branch
  //    (the worker runs subagents in its own mini-loop; the executor gates it
  //    before generic dispatch).
  // apply_edit_ops ROUTES even with empty args (its no-folder gate fires), so
  // it is covered by the surface test above, not this allowlist.
  const FALL_THROUGH_ALLOWLIST = new Set(["spawn_subagent"]);

  it.each(TOOL_NAMES.filter((n) => !FALL_THROUGH_ALLOWLIST.has(n)))(
    "%s never lands on the roster refusal",
    async (name) => {
      const outcome = await dispatchToolCall(emptyCall(name), makeCtx());
      expect(outcome.resultXml).not.toMatch(/not available in this environment/);
    }
  );

  it("the two documented fall-throughs still refuse via the roster message", async () => {
    for (const name of FALL_THROUGH_ALLOWLIST) {
      const outcome = await dispatchToolCall(emptyCall(name), makeCtx());
      expect(outcome.resultXml).toMatch(/not available in this environment/);
    }
  });
});
