// contract/tools.ts — Shared tool-surface contract (Step A).
//
// Single import point for tool schemas + argument validation shared by BOTH
// execution modes. The canonical OpenAI function schemas live in
// ../../tool-definitions (client tool belt); the server executor's
// buildNativeToolDefs owns the worktree-lane roster. This module does NOT
// duplicate either roster — it owns the CROSS-CUTTING rules both lanes share:
// required-arg checks that must fire before dispatch, and the tool-name sets
// that classify loop/read-only policy.

/** Tools that never mutate state — the single set, owned by loop-detect. */
export { READ_ONLY_TOOLS } from "../../loop-detect";

/** Tools that mutate state — subject to streak caps + approval gating. */
export const STATE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "batch_edit",
  "run_command",
  "run_in_sandbox",
  "browser_click",
  "browser_type",
  "browser_evaluate",
]);

/**
 * Required-argument check shared by both dispatchers. Returns an error
 * string, or null when the call is well-formed. (Deep schema validation stays
 * with the lane schemas; this is the cheap gate before any side effect.)
 */
export function validateToolArgs(name: string, call: Record<string, unknown>): string | null {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "read_file":
    case "write_file":
      if (!s(call.path)) return "path required";
      if (name === "write_file" && typeof call.content !== "string") return "content required";
      return null;
    case "edit_file":
      if (!s(call.path) || typeof call.old_text !== "string" || typeof call.new_text !== "string")
        return "path, old_text and new_text required";
      return null;
    case "list_files":
      return null;
    case "search_code":
      return s(call.query) || s(call.pattern) ? null : "query required";
    case "run_command":
    case "run_in_sandbox":
      return s(call.command) ? null : "command required";
    case "undo_last_change":
      return null;
    case "todo_list":
      return null;
    case "ask_question":
      return null;
    case "scratchpad_update":
      if (!s(call.section) || typeof call.content !== "string") return "section and content required";
      return ["plan", "hypotheses", "findings", "next"].includes(s(call.section))
        ? null
        : "section must be plan | hypotheses | findings | next";
    default:
      return null;
  }
}
