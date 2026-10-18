/**
 * tool-args.test.ts — one registry, derived schemas and name sets.
 *
 * The registry exists to stop the product's hand-maintained tool-name lists
 * from drifting (plan §Phase3 / finding §5.5: plan-gate gated move_file while
 * extract_archive was not). The tests pin both halves of the contract:
 *  - unknown tools must PASS THROUGH (a new tool never hard-breaks dispatch);
 *  - known tools must be validated against the published arg shape.
 */
import { READ_ONLY_TOOLS } from "../loop-detect";
import { STATE_CHANGING_TOOLS } from "../agent/contract/tools";
import {
  TOOL_ARG_SCHEMAS,
  MUTATING_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  validateToolArgs,
} from "../reliability/tool-args";
import { EDIT_OPS_TOOL_NAME, parseEditOp } from "../reliability/edit-ops";

describe("TOOL_ARG_SCHEMAS registry", () => {
  it("covers at least the tools the plan names", () => {
    const required = [
      "write_file",
      "edit_file",
      "batch_edit",
      "write_file_chunk",
      "read_file",
      "list_files",
      "run_command",
      "move_file",
      "delete_file",
      "extract_archive",
    ];
    for (const name of required) {
      expect(Object.keys(TOOL_ARG_SCHEMAS)).toContain(name);
      expect(typeof TOOL_ARG_SCHEMAS[name]?.safeParse).toBe("function");
    }
  });

  it("includes the structured-edit tool with the same union parseEditOp uses", () => {
    expect(TOOL_ARG_SCHEMAS[EDIT_OPS_TOOL_NAME]).toBeDefined();
    const ok = validateToolArgs(EDIT_OPS_TOOL_NAME, { op: "delete_file", path: "a.ts" });
    expect(ok.ok).toBe(true);
    const bad = validateToolArgs(EDIT_OPS_TOOL_NAME, { op: "delete_file" });
    expect(bad.ok).toBe(false);
    // Same model, same verdict.
    expect(parseEditOp({ op: "delete_file" }).ok).toBe(false);
  });
});

describe("validateToolArgs", () => {
  it("returns ok for UNKNOWN tools so a new tool can never hard-break dispatch", () => {
    expect(validateToolArgs("brand_new_tool", {}).ok).toBe(true);
    expect(validateToolArgs("mcp__supabase__list_tables", { nonsense: true }).ok).toBe(true);
  });

  it("validates write_file: path and content required, right types", () => {
    expect(validateToolArgs("write_file", { path: "a.ts", content: "" }).ok).toBe(true);
    expect(validateToolArgs("write_file", { path: "a.ts" }).ok).toBe(false);
    expect(validateToolArgs("write_file", { path: "a.ts", content: 42 }).ok).toBe(false);
    const noPath = validateToolArgs("write_file", { content: "x" });
    expect(noPath.ok).toBe(false);
    if (!noPath.ok) expect(noPath.error).toContain("path");
  });

  it("validates edit_file and batch_edit shapes", () => {
    expect(validateToolArgs("edit_file", { path: "a.ts", old_text: "x", new_text: "y" }).ok).toBe(true);
    expect(validateToolArgs("edit_file", { path: "a.ts", old_text: 1, new_text: "y" }).ok).toBe(false);

    expect(
      validateToolArgs("batch_edit", { edits: [{ path: "a.ts", old_text: "x", new_text: "y" }] }).ok,
    ).toBe(true);
    expect(validateToolArgs("batch_edit", { edits: "nope" }).ok).toBe(false);
    expect(validateToolArgs("batch_edit", { edits: [{ path: "a.ts" }] }).ok).toBe(false);
  });

  it("validates read-only tools without being stricter than the dispatcher", () => {
    expect(validateToolArgs("read_file", { path: "a.ts" }).ok).toBe(true);
    // The paged-read path the dispatcher already supports.
    expect(validateToolArgs("read_file", { path: "a.ts", offset: 10, limit: 50 }).ok).toBe(true);
    expect(validateToolArgs("read_file", {}).ok).toBe(false);

    expect(validateToolArgs("list_files", {}).ok).toBe(true);
    expect(validateToolArgs("list_files", { path: "." }).ok).toBe(true);

    // contract/tools.ts accepts query OR pattern for search_code.
    expect(validateToolArgs("search_code", { query: "foo" }).ok).toBe(true);
    expect(validateToolArgs("search_code", { pattern: "foo" }).ok).toBe(true);
    expect(validateToolArgs("search_code", {}).ok).toBe(false);
  });

  it("validates command, move, delete, extract", () => {
    expect(validateToolArgs("run_command", { command: "npm test" }).ok).toBe(true);
    expect(validateToolArgs("run_command", {}).ok).toBe(false);
    expect(validateToolArgs("run_in_sandbox", { command: "npm i", timeout: 30 }).ok).toBe(true);

    expect(validateToolArgs("move_file", { from: "a.ts", to: "b.ts" }).ok).toBe(true);
    expect(validateToolArgs("move_file", { from: "a.ts" }).ok).toBe(false);

    expect(validateToolArgs("delete_file", { path: "a.ts" }).ok).toBe(true);
    expect(validateToolArgs("delete_file", {}).ok).toBe(false);

    expect(validateToolArgs("extract_archive", { path: "x.zip" }).ok).toBe(true);
    expect(validateToolArgs("extract_archive", { path: "x.zip", dest: "out" }).ok).toBe(true);
    expect(validateToolArgs("extract_archive", {}).ok).toBe(false);
  });

  it("keeps the dispatcher's conditional requirements (browser, mcp)", () => {
    expect(validateToolArgs("browser_click", { selector: "#go" }).ok).toBe(true);
    expect(validateToolArgs("browser_click", { ref: "e3" }).ok).toBe(true);
    expect(validateToolArgs("browser_click", {}).ok).toBe(false);

    expect(validateToolArgs("browser_wait_for", { time: 300 }).ok).toBe(true);
    expect(validateToolArgs("browser_wait_for", {}).ok).toBe(false);

    expect(validateToolArgs("mcp_call", { serverId: "supabase", tool: "list_tables" }).ok).toBe(true);
    expect(validateToolArgs("mcp_call", { serverId: "supabase" }).ok).toBe(false);
  });

  it("never rejects extra unknown keys (schemas strip, not forbid)", () => {
    expect(
      validateToolArgs("write_file", { path: "a.ts", content: "x", model_hallucinated_field: 1 }).ok,
    ).toBe(true);
  });
});

describe("derived name sets (one source of truth)", () => {
  it("WRITE_TOOL_NAMES covers every file tool plus the shell (plan-gate semantics)", () => {
    for (const name of [
      "write_file",
      "write_file_chunk",
      "edit_file",
      "batch_edit",
      EDIT_OPS_TOOL_NAME,
      "undo_last_change",
      "move_file",
      "delete_file",
      "extract_archive",
      "run_command",
      "run_in_sandbox",
    ]) {
      expect(WRITE_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(WRITE_TOOL_NAMES.has("read_file")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("list_files")).toBe(false);
  });

  it("MUTATING_TOOL_NAMES is a superset of STATE_CHANGING_TOOLS and of WRITE_TOOL_NAMES", () => {
    for (const name of STATE_CHANGING_TOOLS) {
      expect(MUTATING_TOOL_NAMES.has(name)).toBe(true);
    }
    for (const name of WRITE_TOOL_NAMES) {
      expect(MUTATING_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(MUTATING_TOOL_NAMES.has("browser_click")).toBe(true);
    expect(MUTATING_TOOL_NAMES.has("mcp_call")).toBe(true);
  });

  it("MUTATING_TOOL_NAMES never marks a READ_ONLY tool mutating", () => {
    for (const name of READ_ONLY_TOOLS) {
      expect(MUTATING_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it("keeps the in-app note tools and verification out of both sets", () => {
    for (const name of ["todo_list", "scratchpad_update", "ask_question", "ask_clarification", "preview_browser", "verify_app"]) {
      expect(WRITE_TOOL_NAMES.has(name)).toBe(false);
      expect(MUTATING_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});
