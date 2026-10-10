// contract/results.ts — Shared result-formatting contract (Step A).
//
// ONE function owns the `<tool_result>` XML envelope every tool result is
// wrapped in, for BOTH execution modes. Previously the client worker
// (native-tools.ts) and the server executor (executor.ts) each hand-built
// these strings with slightly different shapes — the model saw two dialects.
// New code must call formatToolResult; migrated lanes are noted below.

/** Escape XML attribute values (callers pass raw strings). */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Build `<tool_result name="..." k="v">body</tool_result>\n`.
 * - name: tool name (required).
 * - attrs: string attributes only (command, url, selector, ...). Undefined/null skipped.
 * - body: inner text (already truncated by the caller to lane budgets).
 */
export function formatToolResult(
  name: string,
  attrs: Record<string, string | undefined | null> = {},
  body: string = ""
): string {
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join("");
  return `<tool_result name="${escAttr(name)}"${attrStr}>${body}</tool_result>\n`;
}

/** Error-result shorthand: `<tool_result name="...">error - msg</tool_result>`. */
export function formatToolError(
  name: string,
  attrs: Record<string, string | undefined | null> = {},
  message: string
): string {
  return formatToolResult(name, attrs, `error - ${message}`);
}
