/**
 * tool-chain.ts — display segments → the vertical tool-call chain.
 *
 * The transcript is plain text (`analysing [path]`, `running [cmd]`, then
 * `[OK] …` / `[FAIL] …` result lines), so the chat shows one connector line
 * running down the left through every tool call of a run. This module is the
 * pure half: it derives a row (icon kind, name, args, outcome, expandable
 * body) from a segment and groups consecutive tool/thinking segments into a
 * single chain. No React — kept out of ToolChain.tsx so the node-env Jest
 * suite can test it directly.
 */
import type { ContentSegment } from "./message-content";

export type ToolKind = "run" | "read" | "write" | "browser" | "search" | "other";
export type ToolRowState = "running" | "success" | "error" | "stopped";

export interface ToolRow {
  /** Medium-weight label: "Run", "Read", "Edit", "Web Search"… */
  name: string;
  /** Mono args: path / command / query / URL, elided in the row. */
  args: string;
  /** Which 16px glyph sits on the connector line. */
  kind: ToolKind;
  state: ToolRowState;
  /** Full text revealed by the expand chevron. */
  detail: string;
  /** Run is paused on an approval gate. */
  waiting?: boolean;
}

export type ChainItem =
  | { type: "thinking"; segment: ContentSegment; live: boolean }
  | { type: "tool"; row: ToolRow };

export type ChainGroup =
  | { type: "chain"; items: ChainItem[] }
  | { type: "solo"; segment: ContentSegment; live?: boolean };

// === Labels ===

/** Native tool name → (row label, glyph family). */
const TOOL_LABELS: Record<string, [string, ToolKind]> = {
  read_file: ["Read", "read"],
  list_files: ["List", "read"],
  search_code: ["Search", "search"],
  code_search: ["Search", "search"],
  web_search: ["Web Search", "search"],
  write_file: ["Write", "write"],
  write_file_chunk: ["Write", "write"],
  append_file: ["Write", "write"],
  create_file: ["Stage File", "write"],
  edit_file: ["Edit", "write"],
  batch_edit: ["Edit", "write"],
  undo: ["Undo", "write"],
  undo_file: ["Undo", "write"],
  run_command: ["Run", "run"],
  run_in_sandbox: ["Run", "run"],
  start_server: ["Run", "run"],
  take_screenshot: ["Screenshot", "browser"],
  preview_browser: ["Preview", "browser"],
  verify_app: ["Verify", "run"],
  todo_list: ["Todo", "other"],
  scratchpad_update: ["Scratchpad", "other"],
};

export function labelForTool(tool: string): [string, ToolKind] {
  const known = TOOL_LABELS[tool];
  if (known) return known;
  if (tool.startsWith("browser_")) return ["Browser", "browser"];
  if (tool.startsWith("mcp__")) return ["MCP", "other"];
  return [tool.replace(/_/g, " ").trim() || "Tool", "other"];
}

/** Status-line verb → (row label, glyph family). */
const VERB_LABELS: Array<[RegExp, string, ToolKind]> = [
  [/^(analysing|reading|read)$/, "Read", "read"],
  [/^listing$/, "List", "read"],
  [/^(writing|appending|overwriting)$/, "Write", "write"],
  [/^(editing|batch editing)$/, "Edit", "write"],
  [/^staging$/, "Stage File", "write"],
  [/^undoing$/, "Undo", "write"],
  [/^(running|sandbox)$/, "Run", "run"],
  [/^(searching|code_search)$/, "Search", "search"],
  [/^searching web$/, "Web Search", "search"],
  [/^browsing$/, "Browse", "browser"],
  [/^clicking$/, "Click", "browser"],
  [/^capturing$/, "Screenshot", "browser"],
  [/^previewing$/, "Preview", "browser"],
  [/^verifying app$/, "Verify", "run"],
  [/^asking$/, "Ask", "other"],
  [/^thinking$/, "Thinking", "other"],
  [/^mcp$/, "MCP", "other"],
];

function labelForVerb(verb: string): [string, ToolKind] {
  const v = verb.trim().toLowerCase();
  for (const [re, name, kind] of VERB_LABELS) if (re.test(v)) return [name, kind];
  return [v.replace(/_/g, " ") || "Tool", "other"];
}

/**
 * Result line → (row label, glyph family). Used when the worker REPLACED the
 * start line (`analysing [x]` → `[OK] Read \`x\``), so the verb only survives
 * inside the result text.
 */
const RESULT_LABELS: Array<[RegExp, string, ToolKind]> = [
  [/^Read `/i, "Read", "read"],
  [/^Listed/, "List", "read"],
  [/^(Wrote|Appended)/i, "Write", "write"],
  [/^Created `/, "Stage File", "write"],
  [/^(Edited|Failed to edit|Edit |Batch edit)/i, "Edit", "write"],
  [/^Undid/, "Undo", "write"],
  [/^code_search/, "Search", "search"],
  [/^Search /, "Search", "search"],
  [/^Web search/i, "Web Search", "search"],
  [/^Verif/, "Verify", "run"],
  [/^(Command|Sandbox|Server)/, "Run", "run"],
  [/^(Screenshot|Captured)/i, "Screenshot", "browser"],
  [/^Read "/i, "Browse", "browser"],
  [/^Preview/i, "Preview", "browser"],
  [/^Browser/, "Browse", "browser"],
  [/^(Clicked|Typed|Hovered|Selected|Evaluated|Navigated|Opened|Find|Wait|Tabs|Network|Console)/, "Browser", "browser"],
  [/^Todo/, "Todo", "other"],
  [/^Scratchpad/, "Scratchpad", "other"],
  [/^(User answered|Question|Asked)/, "Ask", "other"],
];

function labelForResult(detail: string): [string, ToolKind] {
  const d = detail.trim();
  for (const [re, name, kind] of RESULT_LABELS) if (re.test(d)) return [name, kind];
  return ["Tool", "other"];
}

// === Args ===

/** Pull the most useful string out of a result line for the row's mono arg. */
function extractArgs(detail: string): string {
  const d = detail.trim();
  if (!d) return "";
  const backtick = d.match(/`([^`]+)`/);
  if (backtick) return backtick[1];
  const url = d.match(/https?:\/\/\S+/);
  if (url) return url[0];
  const quoted = d.match(/"([^"]+)"/);
  if (quoted) return quoted[1];
  const afterColon = d.indexOf(": ");
  if (afterColon > 0 && afterColon < 48) return d.slice(afterColon + 2);
  const parts = d.split(/\s+[—–]\s+/);
  if (parts.length > 1) return parts.slice(1).join(" — ");
  return d;
}

/** Prefer the arg key the row should read as (path > command > query > …). */
const ARG_KEYS = ["path", "command", "query", "url", "target", "file", "pattern", "section"];

function extractToolArgs(parsed: Record<string, unknown>): string {
  for (const key of ARG_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "name" || key === "content") continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  }
  return "";
}

// === Row builders ===

/** A tool STARTED (`running [ls -la]`, `analysing [src/app.tsx]`). */
export function rowFromStatus(seg: ContentSegment): ToolRow {
  const verb = (seg.action || "").trim().toLowerCase();
  const path = (seg.path || "").trim();
  const tail = (seg.detail || "").trim();
  if (verb === "mcp") {
    // `mcp [server] tool_name` — server in the bracket, tool after it.
    return {
      name: "MCP",
      kind: "other",
      args: tail ? `${path}: ${tail}` : path,
      state: "running",
      detail: "",
    };
  }
  const [name, kind] = labelForVerb(verb);
  return {
    name,
    kind,
    args: path,
    state: "running",
    detail: tail,
    waiting: /awaiting approval/i.test(tail),
  };
}

/** A tool FINISHED (`[OK] Read \`x\``, `[FAIL] Command failed: \`y\``). */
export function rowFromResult(seg: ContentSegment): ToolRow {
  const detail = (seg.detail || seg.content || "").trim();
  const [name, kind] = labelForResult(detail);
  return {
    name,
    kind,
    args: extractArgs(detail),
    state: seg.type === "error" ? "error" : "success",
    detail,
  };
}

/** The model asked for a tool (`` fallback — native calls never land here). */
export function rowFromToolCall(seg: ContentSegment): ToolRow {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(seg.content || "{}");
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    /* keep {} — the raw text below is the fallback body */
  }
  const [name, kind] = labelForTool(String(seg.name || parsed.name || "tool"));
  const detail = Object.keys(parsed).length
    ? JSON.stringify(parsed, null, 2)
    : (seg.content || "").trim();
  return { name, kind, args: extractToolArgs(parsed), state: "running", detail };
}

/** A raw `<tool_result>` block with no matching call row in front of it. */
export function rowFromToolResult(seg: ContentSegment): ToolRow {
  const detail = (seg.content || "").trim();
  const failed = /^\s*(\[?TOOL ERROR\]?|\[?MCP ERROR\]?|BLOCKED|error|failed)/i.test(detail);
  return {
    name: "Tool",
    kind: "other",
    args: detail.split("\n")[0].slice(0, 160),
    state: failed ? "error" : "success",
    detail,
  };
}

function withResult(row: ToolRow, detail: string, failed: boolean): ToolRow {
  const body = detail.trim();
  return {
    ...row,
    state: failed ? "error" : "success",
    waiting: false,
    detail: row.detail ? `${row.detail}\n\n${body}` : body,
  };
}

/** Fold a result line into the running row it belongs to. */
function mergeResult(row: ToolRow, seg: ContentSegment): ToolRow {
  const detail = (seg.detail || seg.content || "").trim();
  return withResult(row, detail, seg.type === "error");
}

function mergeToolResult(row: ToolRow, seg: ContentSegment): ToolRow {
  const detail = (seg.content || "").trim();
  const failed = /^\s*(\[?TOOL ERROR\]?|\[?MCP ERROR\]?|BLOCKED)/i.test(detail);
  return withResult(row, detail, failed);
}

function rowForToolSegment(seg: ContentSegment): ToolRow {
  switch (seg.type) {
    case "status":
      return rowFromStatus(seg);
    case "success":
    case "error":
      return rowFromResult(seg);
    case "tool_call":
      return rowFromToolCall(seg);
    case "tool_result":
      return rowFromToolResult(seg);
    default:
      return { name: "Tool", kind: "other", args: "", state: "success", detail: seg.content };
  }
}

// === Grouping ===

const TOOL_SEGMENT_TYPES = new Set<ContentSegment["type"]>([
  "status",
  "success",
  "error",
  "tool_call",
  "tool_result",
]);

/**
 * Split parsed segments into renderable groups. Consecutive tool segments —
 * plus any thinking blocks sitting inside or immediately ahead of them —
 * collapse into ONE chain so a single connector line runs through the whole
 * run. Prose, notices and standalone reasoning stay outside the chain.
 */
export function buildChainGroups(
  segments: ContentSegment[],
  liveThinking = false
): ChainGroup[] {
  const out: ChainGroup[] = [];
  /** Reasoning held back while no chain is open yet — it joins the chain
   *  that follows, so one connector line runs through thinking + tools. */
  const held: Array<Extract<ChainItem, { type: "thinking" }>> = [];
  let chain: ChainItem[] = [];
  let chainTools = 0;

  const flushHeld = () => {
    for (const item of held) out.push({ type: "solo", segment: item.segment, live: item.live });
    held.length = 0;
  };

  const closeChain = () => {
    if (chain.length > 0 && chainTools > 0) {
      out.push({ type: "chain", items: chain });
    } else {
      // Never a chain on its own — reasoning without tools renders as-is.
      for (const item of chain) {
        if (item.type === "thinking") {
          out.push({ type: "solo", segment: item.segment, live: item.live });
        }
      }
    }
    chain = [];
    chainTools = 0;
  };

  segments.forEach((segment, index) => {
    if (TOOL_SEGMENT_TYPES.has(segment.type)) {
      // Reasoning that came before this tool sits at the head of the chain,
      // on the same connector line as the calls below it.
      if (held.length > 0) {
        if (chain.length === 0) chain.push(...held);
        else for (const item of held) out.push({ type: "solo", segment: item.segment, live: item.live });
        held.length = 0;
      }
      const last = chain[chain.length - 1];
      const running = last && last.type === "tool" && last.row.state === "running" ? last.row : null;
      if (running && (segment.type === "success" || segment.type === "error")) {
        chain[chain.length - 1] = { type: "tool", row: mergeResult(running, segment) };
        return;
      }
      if (running && segment.type === "tool_result") {
        chain[chain.length - 1] = { type: "tool", row: mergeToolResult(running, segment) };
        return;
      }
      chain.push({ type: "tool", row: rowForToolSegment(segment) });
      chainTools += 1;
      return;
    }

    if (segment.type === "thinking") {
      const item: Extract<ChainItem, { type: "thinking" }> = {
        type: "thinking",
        segment,
        live: liveThinking && index === segments.length - 1,
      };
      if (chain.length > 0) chain.push(item);
      else held.push(item);
      return;
    }

    // Prose / notices end the chain and release any held reasoning.
    if (chain.length > 0) closeChain();
    flushHeld();
    out.push({ type: "solo", segment });
  });

  if (chain.length > 0) closeChain();
  flushHeld();
  return out;
}
