"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type ToolCategory =
  | "file"
  | "edit"
  | "exec"
  | "search"
  | "web"
  | "media"
  | "reason"
  | "agent"
  | "bad"
  | "think"
  | "generic";
type ToolState = "running" | "done" | "failed" | "waiting";
type BodyRecord = Record<string, unknown>;

interface ToolDefinition {
  category: ToolCategory;
  icon: string;
  verbs: [string, string];
  extension?: boolean;
}

const ICON_PATHS: Record<string, ReactNode> = {
  file: <path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5ZM9 1.5V5h3.5" />,
  edit: <path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />,
  term: <path d="M3 4l4 4-4 4M8.5 12.5H13" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>,
  camera: <><rect x="2" y="4.5" width="12" height="8.5" rx="1.5" /><circle cx="8" cy="8.75" r="2.25" /><path d="M6 4.5l.7-1.5h2.6l.7 1.5" /></>,
  list: <path d="M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01" />,
  help: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.3-.8.7-.8 1.3M8 11.5h.01" /></>,
  note: <><path d="M3 2.5h10v11H3z" /><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" /></>,
  spark: <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" />,
  plug: <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />,
  cube: <><path d="M8 1.8l5.5 3v6.4l-5.5 3-5.5-3V4.8z" /><path d="M2.5 4.8L8 8l5.5-3.2M8 8v6.2" /></>,
  undo: <><path d="M5 3L2.5 5.5 5 8" /><path d="M2.5 5.5H10a3.5 3.5 0 0 1 0 7H6" /></>,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />,
  move: <path d="M2 8h12M10 4l4 4-4 4" />,
  archive: <><rect x="2" y="3" width="12" height="3" rx=".8" /><path d="M3 6v6.5h10V6M6.5 9h3" /></>,
  branch: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="6" r="1.5" /><path d="M4.5 5v6M11.5 7.5c0 2-3 2-7 3.5" /></>,
  cursor: <path d="M4 2l8 5.5-3.5 1 2 4.5-1.5.7-2-4.5L4 12z" />,
  keyboard: <><rect x="1.8" y="4" width="12.4" height="8" rx="1.5" /><path d="M4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 10h6" /></>,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" /></>,
  scroll: <path d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3" />,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  tabs: <><rect x="2" y="4.5" width="12" height="8.5" rx="1.5" /><path d="M2 7.5h12M5 4.5V3h3v1.5" /></>,
  bug: <path d="M5.5 5.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0zM2.5 7.5h3M10.5 7.5h3M3 4l2.5 2M13 4l-2.5 2M3 12l2.5-2M13 12l-2.5-2" />,
  net: <path d="M2 8h3l1.5-4 3 8L11 8h3" />,
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />,
  book: <path d="M3 2.5h7a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2zM3 11.5a2 2 0 0 1 2-2h7" />,
  hist: <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4M2.5 2.5v3h3M8 5v3.2l2 1.3" />,
  shield: <><path d="M8 1.8l5 2v4c0 3-2.2 5-5 6.4-2.8-1.4-5-3.4-5-6.4v-4z" /><path d="M5.8 8l1.6 1.6L10.5 6.5" /></>,
  download: <path d="M8 2v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10" />,
  play: <><rect x="2" y="3" width="12" height="9" rx="1.5" /><path d="M7 6l3 1.5L7 9zM5 14h6" /></>,
  sliders: <><path d="M2 5h12M2 11h12" /><circle cx="6" cy="5" r="1.6" /><circle cx="10.5" cy="11" r="1.6" /></>,
  key: <><rect x="2.5" y="4" width="11" height="8" rx="1.5" /><path d="M5.5 9.5h5" /></>,
  layers: <><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></>,
  nav: <><circle cx="8" cy="8" r="6" /><path d="M5.5 8h5M8.5 6l2 2-2 2" /></>,
  bulb: <path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.5.4.9 1 .9 1.6V11h3v-.1c0-.6.4-1.2.9-1.6A4.2 4.2 0 0 0 8 1.8zM6.5 13h3M7 14.5h2" />,
};

const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  read_file: { category: "file", icon: "eye", verbs: ["Read", "Reading"], extension: true },
  list_files: { category: "file", icon: "folder", verbs: ["Listed", "Listing"] },
  extract_archive: { category: "file", icon: "archive", verbs: ["Extracted", "Extracting"] },
  create_file: { category: "file", icon: "download", verbs: ["Created", "Creating"], extension: true },
  move_file: { category: "file", icon: "move", verbs: ["Moved", "Moving"] },
  delete_file: { category: "bad", icon: "trash", verbs: ["Deleted", "Deleting"], extension: true },
  write_file: { category: "edit", icon: "file", verbs: ["Wrote", "Writing"], extension: true },
  write_file_chunk: { category: "edit", icon: "layers", verbs: ["Wrote chunk", "Writing chunk"], extension: true },
  append_file: { category: "edit", icon: "layers", verbs: ["Appended", "Appending"], extension: true },
  edit_file: { category: "edit", icon: "edit", verbs: ["Edited", "Editing"], extension: true },
  batch_edit: { category: "edit", icon: "layers", verbs: ["Batch edited", "Batch editing"] },
  apply_edit_ops: { category: "edit", icon: "sliders", verbs: ["Applied ops", "Applying ops"], extension: true },
  undo_last_change: { category: "edit", icon: "undo", verbs: ["Undid change", "Undoing"], extension: true },
  run_command: { category: "exec", icon: "term", verbs: ["Ran", "Running"] },
  run_in_sandbox: { category: "exec", icon: "cube", verbs: ["Sandboxed", "Sandboxing"] },
  start_server: { category: "exec", icon: "play", verbs: ["Started", "Starting"] },
  verify_app: { category: "exec", icon: "shield", verbs: ["Verified", "Verifying"] },
  search_code: { category: "search", icon: "search", verbs: ["Searched", "Searching"] },
  code_search: { category: "search", icon: "code", verbs: ["Code search", "Code searching"] },
  web_search: { category: "search", icon: "globe", verbs: ["Searched web", "Searching web"] },
  playbook_search: { category: "search", icon: "book", verbs: ["Recalled playbook", "Checking playbook"] },
  session_search: { category: "search", icon: "hist", verbs: ["Searched sessions", "Searching sessions"] },
  browser_navigate: { category: "web", icon: "nav", verbs: ["Navigated", "Navigating"] },
  browser_read: { category: "web", icon: "eye", verbs: ["Read page", "Reading page"] },
  browser_find: { category: "web", icon: "target", verbs: ["Found", "Finding"] },
  browser_click: { category: "web", icon: "cursor", verbs: ["Clicked", "Clicking"] },
  browser_type: { category: "web", icon: "keyboard", verbs: ["Typed", "Typing"] },
  browser_select: { category: "web", icon: "sliders", verbs: ["Selected", "Selecting"] },
  browser_hover: { category: "web", icon: "cursor", verbs: ["Hovered", "Hovering"] },
  browser_press: { category: "web", icon: "key", verbs: ["Pressed", "Pressing"] },
  browser_scroll: { category: "web", icon: "scroll", verbs: ["Scrolled", "Scrolling"] },
  browser_wait_for: { category: "web", icon: "clock", verbs: ["Waited for", "Waiting for"] },
  browser_tabs: { category: "web", icon: "tabs", verbs: ["Tabs", "Tabs"] },
  browser_console: { category: "web", icon: "bug", verbs: ["Console", "Reading console"] },
  browser_network: { category: "web", icon: "net", verbs: ["Network", "Reading network"] },
  browser_screenshot: { category: "web", icon: "camera", verbs: ["Screenshot", "Capturing"] },
  browser_evaluate: { category: "web", icon: "code", verbs: ["Evaluated", "Evaluating"] },
  take_screenshot: { category: "media", icon: "camera", verbs: ["Captured", "Capturing"] },
  preview_browser: { category: "media", icon: "play", verbs: ["Previewed", "Opening preview"] },
  todo_list: { category: "reason", icon: "list", verbs: ["Updated todos", "Updating todos"] },
  ask_question: { category: "reason", icon: "help", verbs: ["Asked", "Asking"] },
  ask_clarification: { category: "reason", icon: "help", verbs: ["Clarifying", "Clarifying"] },
  scratchpad_update: { category: "reason", icon: "note", verbs: ["Scratchpad", "Updating scratchpad"] },
  skill_create: { category: "reason", icon: "spark", verbs: ["Created skill", "Creating skill"] },
  spawn_subagent: { category: "agent", icon: "branch", verbs: ["Subagent", "Subagent"] },
  mcp_call: { category: "agent", icon: "plug", verbs: ["Called MCP", "Calling MCP"] },
  memory_list: { category: "file", icon: "list", verbs: ["Listed memory", "Listing memory"] },
  memory_read: { category: "file", icon: "book", verbs: ["Read memory", "Reading memory"] },
  memory_write: { category: "edit", icon: "note", verbs: ["Wrote memory", "Writing memory"] },
  memory_str_replace: { category: "edit", icon: "edit", verbs: ["Edited memory", "Editing memory"] },
  memory_append: { category: "edit", icon: "layers", verbs: ["Appended memory", "Appending memory"] },
  memory_delete: { category: "bad", icon: "trash", verbs: ["Deleted memory", "Deleting memory"] },
  thinking: { category: "think", icon: "bulb", verbs: ["Thought", "Thinking"] },
};

const DEFAULT_TOOL: ToolDefinition = {
  category: "generic",
  icon: "plug",
  verbs: ["Used", "Using"],
};

function esc(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value) ?? String(value);
  return String(value);
}

function asRecord(value: unknown): BodyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as BodyRecord
    : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowsFromRecord(value: BodyRecord): Array<[string, string]> {
  return Object.entries(value).map(([key, item]) => [
    key,
    typeof item === "string" ? item : JSON.stringify(item),
  ]);
}

function splitStoredBody(raw: string | undefined): { args?: BodyRecord; result?: string } {
  if (!raw) return {};
  const separator = raw.indexOf("\n\n");
  if (separator >= 0) {
    const args = asRecord(parseJson(raw.slice(0, separator)));
    if (args) return { args, result: raw.slice(separator + 2) || undefined };
  }
  const parsed = asRecord(parseJson(raw));
  if (parsed) return { args: parsed };
  return { result: raw };
}

function extOf(target: string): string {
  return (target.split(".").pop() || "").slice(0, 4).toUpperCase();
}

function targetFromArgs(args: BodyRecord, category: ToolCategory): string {
  const keys = category === "search"
    ? ["query", "pattern"]
    : category === "exec"
      ? ["command", "cmd"]
      : category === "web"
        ? ["url", "path"]
        : ["path", "filename", "file", "task", "server", "query", "command"];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const first = Object.values(args).find((value) => typeof value === "string" && value.trim());
  return typeof first === "string" ? first.trim() : "";
}

function getToolDefinition(tool: string, title?: string): ToolDefinition {
  const registered = TOOL_REGISTRY[tool];
  if (registered) return registered;
  const normalized = tool.trim().toLowerCase().replace(/[-\s]+/g, "_");
  const alias = TOOL_REGISTRY[normalized];
  if (alias) return alias;
  if (title) {
    const titleAliases: Record<string, ToolDefinition> = {
      reading: { category: "file", icon: "eye", verbs: ["Read", "Reading"], extension: true },
      read: { category: "file", icon: "eye", verbs: ["Read", "Reading"], extension: true },
      listing: { category: "file", icon: "folder", verbs: ["Listed", "Listing"] },
      listed: { category: "file", icon: "folder", verbs: ["Listed", "Listing"] },
      writing: { category: "edit", icon: "file", verbs: ["Wrote", "Writing"], extension: true },
      wrote: { category: "edit", icon: "file", verbs: ["Wrote", "Writing"], extension: true },
      editing: { category: "edit", icon: "edit", verbs: ["Edited", "Editing"], extension: true },
      edited: { category: "edit", icon: "edit", verbs: ["Edited", "Editing"], extension: true },
      running: { category: "exec", icon: "term", verbs: ["Ran", "Running"] },
      ran: { category: "exec", icon: "term", verbs: ["Ran", "Running"] },
      searching: { category: "search", icon: "search", verbs: ["Searched", "Searching"] },
      searched: { category: "search", icon: "search", verbs: ["Searched", "Searching"] },
      thinking: TOOL_REGISTRY.thinking,
      thought: TOOL_REGISTRY.thinking,
    };
    const titleEntry = titleAliases[title.toLowerCase()];
    if (titleEntry) return titleEntry;
  }
  const words = tool.replace(/^mcp__/, "").replace(/__/g, " ").replace(/[_-]+/g, " ").trim();
  if (!words) return DEFAULT_TOOL;
  const done = words.charAt(0).toUpperCase() + words.slice(1);
  const active = /e$/.test(words) ? `${done.slice(0, -1)}ing` : `${done}ing`;
  return { ...DEFAULT_TOOL, verbs: [done, active] };
}

function highlightCode(source: string): ReactNode[] {
  const pattern = /(\/\/.*$)|('[^']*'|"[^"]*"|`[^`]*`)|\b(import|from|export|const|let|return|if|else|for|of|await|async|function|new)\b|\b(\d[\d_]*)\b|[&<>]/gm;
  const pieces: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) pieces.push(source.slice(last, at));
    const value = match[0];
    const className = match[1] ? "otc-comment"
      : match[2] ? "otc-string"
        : match[3] ? "otc-keyword"
          : match[4] ? "otc-number" : undefined;
    pieces.push(className ? <span className={className} key={index++}>{value}</span> : value);
    last = at + value.length;
  }
  if (last < source.length) pieces.push(source.slice(last));
  return pieces;
}

function highlightedJson(value: unknown): ReactNode[] {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  const pattern = /"([^"]+)":|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)/g;
  const pieces: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) pieces.push(text.slice(last, at));
    const cls = match[1] ? "otc-json-key" : match[2] ? "otc-string" : "otc-number";
    pieces.push(<span className={cls} key={index++}>{match[0]}</span>);
    last = at + match[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

function highlightedMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark className="otc-mark" key={index}>{part}</mark>
      : part
  );
}

function pairs(value: unknown): Array<[unknown, unknown, unknown?, unknown?]> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => Array.isArray(row) ? [row[0], row[1], row[2], row[3]] : [row, ""]);
}

function lineRecords(body: BodyRecord): Array<[unknown, unknown, unknown?, unknown?]> {
  if (Array.isArray(body.lines)) return pairs(body.lines);
  return String(body.text ?? body.content ?? "").split("\n").map((line, index) => [index + 1, line]);
}

function pathParts(path: string): { directory: string; file: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { directory: "", file: path }
    : { directory: path.slice(0, index + 1), file: path.slice(index + 1) };
}

function ToolIcon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="otc-icon-svg"
    >
      {ICON_PATHS[name] ?? ICON_PATHS.plug}
    </svg>
  );
}

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={`otc-chevron ${className}`}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="otc-check">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="otc-copy-icon">
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
    </svg>
  );
}

function statusClass(value: unknown): string {
  const status = String(value ?? "todo");
  return ({
    ok: "ok2",
    done: "ok2",
    bad: "bad",
    error: "bad",
    run: "todo",
    todo: "todo",
    skip: "skip",
  } as Record<string, string>)[status] ?? "todo";
}

function statusGlyph(value: unknown): string {
  const status = String(value ?? "todo");
  return ({
    ok: "✓",
    done: "✓",
    bad: "✗",
    error: "✗",
    run: "◔",
    todo: "○",
    skip: "–",
  } as Record<string, string>)[status] ?? "○";
}

function TermText({ text }: { text: string }) {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    const cls = /^(PASS|✓|ready|Compiled)/.test(line) ? "otc-green"
      : /^(FAIL|\s*✗|\s*Error|error)/.test(line) ? "otc-red"
        : /^(warn|WARN)/.test(line) ? "otc-yellow" : undefined;
    return <span className={cls} key={index}>{line}{index < lines.length - 1 ? "\n" : ""}</span>;
  });
}

function AskBody({ body }: { body: BodyRecord }) {
  const [selected, setSelected] = useState<number | null>(null);
  const options = Array.isArray(body.opts) ? body.opts : [];
  return (
    <div className="otc-ask">
      <div className="otc-question">{esc(body.q)}</div>
      {options.map((option, index) => {
        const [label, description] = pairs([option])[0] ?? ["", ""];
        return (
          <button
            type="button"
            className={`otc-option${selected === index ? " is-selected" : ""}`}
            onClick={() => setSelected(index)}
            key={index}
          >
            <b>{esc(label)}</b>{description ? <small>{esc(description)}</small> : null}
          </button>
        );
      })}
      {body.free ? <input className="otc-free" placeholder="Other…" aria-label="Other answer" /> : null}
    </div>
  );
}

function BodyView({ body, depth = 0 }: { body: BodyRecord; depth?: number }) {
  const kind = String(body.k ?? "kv");
  if (kind === "code" || kind === "diff") {
    return (
      <pre className="otc-pre">
        {lineRecords(body).map((line, index) => {
          const type = kind === "diff" ? String(line[0] ?? "") : "";
          const lineNumber = kind === "diff" ? line[1] : line[0];
          const text = kind === "diff" ? line[2] : line[1];
          const cls = type === "p" ? "otc-line-add" : type === "m" ? "otc-line-del" : "";
          return (
            <div className={`otc-line ${cls}`} key={index}>
              <i>{esc(lineNumber)}</i><span>{highlightCode(esc(text))}</span>
            </div>
          );
        })}
      </pre>
    );
  }

  if (kind === "term") {
    const output = String(body.out ?? "");
    return (
      <div className="otc-term">
        <span className="otc-purple">$</span> <span className="otc-command">{esc(body.cmd)}</span>
        {output ? <>{'\n'}<TermText text={output} /></> : null}
      </div>
    );
  }

  if (kind === "tree") {
    return (
      <div className="otc-tree">
        {pairs(body.items).map(([type, path, meta], index) => (
          <div className="otc-tree-row" key={index}>
            <ToolIcon name={type === "d" ? "folder" : "file"} size={12} />
            <span>{esc(path)}</span><span className="otc-meta">{esc(meta)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "hits") {
    return (
      <div className="otc-hits">
        {pairs(body.items).map(([file, line, text, score], index) => (
          <div className="otc-hit" key={index}>
            <span className="otc-hit-file">{esc(file)}</span>
            <span className="otc-hit-line">:{esc(line)}</span>
            <code>{highlightedMatch(esc(text), String(body.q ?? ""))}</code>
            {score ? <em>{esc(score)}</em> : null}
          </div>
        ))}
      </div>
    );
  }

  if (kind === "web") {
    return (
      <>
        {pairs(body.items).map(([title, url, description], index) => (
          <div className="otc-web-result" key={index}>
            <b>{esc(title)}</b><small>{esc(url)}</small><p>{esc(description)}</p>
          </div>
        ))}
      </>
    );
  }

  if (kind === "check") {
    return (
      <div className="otc-check-list">
        {pairs(body.items).map(([state, title, meta], index) => (
          <div className="otc-check-row" key={index}>
            <span className={`otc-check-glyph ${statusClass(state)}`}>{statusGlyph(state)}</span>
            <span className={state === "done" ? "otc-done-text" : ""}>{esc(title)}</span>
            {meta ? <em>{esc(meta)}</em> : null}
          </div>
        ))}
      </div>
    );
  }

  if (kind === "kv") {
    return (
      <div className="otc-kv">
        {pairs(body.rows).map(([key, value], index) => (
          <div key={index}><span>{esc(key)}</span><b>{esc(value)}</b></div>
        ))}
      </div>
    );
  }

  if (kind === "json") {
    return (
      <div className="otc-term">
        {body.args !== undefined
          ? <><span className="otc-purple">args</span>{'\n'}{highlightedJson(body.args)}{'\n'}</>
          : null}
        {body.res !== undefined
          ? <><span className="otc-green">result</span>{'\n'}{highlightedJson(body.res)}</>
          : null}
      </div>
    );
  }

  if (kind === "logs") {
    return (
      <div className="otc-logs">
        {pairs(body.rows).map(([level, text, meta], index) => (
          <div className="otc-log-row" key={index}>
            <span className={`otc-log-level ${String(level)}`}>{esc(level).toUpperCase()}</span>
            <span>{esc(text)}</span><span className="otc-log-meta">{esc(meta)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "card") {
    return (
      <div className="otc-card-content">
        <span className="otc-card-icon"><ToolIcon name="file" size={18} /></span>
        <div><b>{esc(body.name)}</b><small>{esc(body.size)} · lives in app memory · expires in {esc(body.ttl)}</small></div>
        <button type="button">Download</button>
      </div>
    );
  }

  if (kind === "prog") {
    return (
      <>
        <div className="otc-progress"><i style={{ width: `${Math.min(100, Math.max(0, Number(body.pct) || 0))}%` }} /></div>
        <div className="otc-caption">{esc(body.label)}</div>
      </>
    );
  }

  if (kind === "shot") {
    const viewport = String(body.vp ?? "desktop");
    const mobile = viewport === "mobile";
    const tablet = viewport === "tablet";
    return (
      <div className="otc-shot">
        <div className="otc-shot-frame" style={{ maxWidth: mobile ? 150 : tablet ? 260 : "100%" }}>
          <div className="otc-shot-bar"><i /><i /><i /><u>{esc(body.url)}</u></div>
          <div className="otc-shot-view">
            <s className="otc-shot-hero" /><s style={{ width: "70%" }} /><s style={{ width: "45%" }} />
            <div><s /><s /></div>{!mobile ? <><s /><s style={{ width: "60%" }} /></> : null}
          </div>
        </div>
        <div className="otc-shot-meta">{esc(body.vp)} · {esc(body.size)}</div>
      </div>
    );
  }

  if (kind === "note") {
    return (
      <>
        <div className="otc-note">
          {pairs(body.secs).map(([heading, text], index) => (
            <section key={index}><h5>{esc(heading)}</h5><p>{esc(text)}</p></section>
          ))}
        </div>
        <div className="otc-caption">kept {esc(body.kept)}</div>
      </>
    );
  }

  if (kind === "ask") return <AskBody body={body} />;

  if (kind === "els") {
    return (
      <div className="otc-tree">
        {pairs(body.els).map(([ref, role, name, selector], index) => (
          <div className="otc-tree-row" key={index}>
            <span className="otc-tool-label">{esc(ref)}</span><span>{esc(role)}</span>
            <span className="otc-els-name">“{esc(name)}”</span><span className="otc-meta">{esc(selector)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "tabs") {
    return (
      <div className="otc-tree">
        {pairs(body.tabs).map(([active, title, url], index) => (
          <div className="otc-tree-row" key={index}>
            <span className={active ? "otc-tab-active" : "otc-meta"}>{active ? "●" : "○"}</span>
            <span className="otc-tab-title">{esc(title)}</span><span className="otc-meta">{esc(url)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "eval") {
    return (
      <div className="otc-term">
        <span className="otc-purple">&gt;</span> <span className="otc-command">{esc(body.expr)}</span>
        {'\n'}<span className="otc-green">{esc(body.res)}</span>
      </div>
    );
  }

  if (kind === "think") {
    return (
      <div className="otc-think">
        {String(body.text ?? "").split("\n").map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    );
  }

  if (kind === "sub") {
    const items = Array.isArray(body.items) ? body.items : [];
    return (
      <>
        {items.length > 0 && depth < 2 ? (
          <div className="otc-subhost">
            {items.map((item, index) => {
              const child = asRecord(item) ?? {};
              return (
                <ToolCallRow
                  key={String(child.id ?? index)}
                  tool={String(child.id ?? child.tool ?? "tool")}
                  target={String(child.t ?? child.target ?? "")}
                  meta={String(child.m ?? child.meta ?? "")}
                  status={child.s === "run" ? "running" : "done"}
                  args={asRecord(child.args)}
                  result={String(child.result ?? child.output ?? "")}
                  rawBody={typeof child.body === "string" ? child.body : undefined}
                  bodyData={asRecord(child.body)}
                  depth={depth + 1}
                />
              );
            })}
          </div>
        ) : null}
        <div className="otc-answer"><b>Answer</b>{esc(body.answer)}</div>
      </>
    );
  }

  return (
    <div className="otc-kv">
      {pairs(body.rows).map(([key, value], index) => (
        <div key={index}><span>{esc(key)}</span><b>{esc(value)}</b></div>
      ))}
    </div>
  );
}

function structuredBody(value: unknown): BodyRecord | undefined {
  const body = asRecord(value);
  return body && typeof body.k === "string" ? body : undefined;
}

function getBody(
  tool: string,
  args: BodyRecord,
  result: string | undefined,
  rawBody: string | undefined,
  target: string,
  bodyData?: BodyRecord
): BodyRecord {
  if (bodyData && typeof bodyData.k === "string") return bodyData;
  const stored = splitStoredBody(rawBody);
  const mergedArgs = Object.keys(args).length ? args : stored.args ?? {};
  const output = stored.result || result || "";
  const resultValue = parseJson(output);
  const structured = structuredBody(resultValue) ?? structuredBody(mergedArgs.body);
  if (structured) return structured;

  const descriptor = asRecord(resultValue);
  if (descriptor && typeof descriptor.k === "string") return descriptor;
  const resultRecord = asRecord(resultValue);

  if (tool === "thinking") {
    return { k: "think", text: output || String(mergedArgs.text ?? "") };
  }
  if (tool === "read_file" && output) {
    return {
      k: "code",
      path: String(mergedArgs.path ?? target),
      lines: output.split("\n").map((line, index) => [index + 1, line]),
    };
  }
  if (tool === "list_files" || tool === "extract_archive") {
    const items = Array.isArray(resultRecord?.items)
      ? resultRecord.items
      : output.split("\n").map((line) => {
        const path = line.replace(/^\s*(?:[├└]──?\s*)/, "").trim();
        return path ? [path.endsWith("/") ? "d" : "f", path, ""] : null;
      }).filter(Boolean);
    if (items.length) return { k: "tree", items };
  }
  if (["write_file", "write_file_chunk", "append_file", "edit_file"].includes(tool)) {
    const newText = String(mergedArgs.new_text ?? mergedArgs.newText ?? mergedArgs.content ?? "");
    const oldText = String(mergedArgs.old_text ?? mergedArgs.oldText ?? "");
    if (newText || oldText) {
      const lines: Array<[string, number, string]> = [];
      oldText.split("\n").filter(Boolean).forEach((line, index) => lines.push(["m", index + 1, line]));
      newText.split("\n").forEach((line, index) => lines.push(["p", index + 1, line]));
      return { k: "diff", path: String(mergedArgs.path ?? target), lines };
    }
  }
  if (tool === "run_command" || tool === "run_in_sandbox" || tool === "start_server") {
    return { k: "term", cmd: String(mergedArgs.command ?? mergedArgs.cmd ?? target), out: output };
  }
  if (tool === "mcp_call") {
    return { k: "json", args: mergedArgs, ...(output ? { res: resultValue ?? output } : {}) };
  }
  if (tool === "spawn_subagent") {
    return {
      k: "sub",
      answer: String(resultRecord?.answer ?? output ?? mergedArgs.answer ?? ""),
      items: Array.isArray(resultRecord?.items)
        ? resultRecord.items
        : Array.isArray(mergedArgs.items)
          ? mergedArgs.items
          : [],
    };
  }
  if (["search_code", "code_search", "playbook_search", "session_search"].includes(tool)) {
    const items = Array.isArray(resultRecord?.items)
      ? resultRecord.items
      : output.split("\n").flatMap((line) => {
        const match = line.match(/^(.+?):(\d+):\s*(.*)$/);
        return match ? [[match[1], Number(match[2]), match[3]]] : [];
      });
    if (items.length) return { k: "hits", q: mergedArgs.query ?? mergedArgs.pattern ?? "", items };
  }
  if (tool === "web_search") {
    const items = resultRecord?.items ?? resultRecord?.results;
    if (Array.isArray(items)) {
      return {
        k: "web",
        items: items.map((item) => {
          const entry = asRecord(item);
          return entry
            ? [entry.title ?? entry.name ?? "", entry.url ?? "", entry.description ?? entry.snippet ?? ""]
            : item;
        }),
      };
    }
  }
  if (tool === "browser_console" || tool === "browser_network") {
    const rows = Array.isArray(resultRecord?.rows)
      ? resultRecord.rows
      : output.split("\n").flatMap((line) => {
        const match = line.match(/^(error|warn|info|log)\s*[:|-]\s*(.+)$/i);
        return match ? [[match[1].toLowerCase(), match[2], ""]] : [];
      });
    if (rows.length) return { k: "logs", rows };
  }
  if (tool === "browser_find" && Array.isArray(resultRecord?.els)) {
    return { k: "els", els: resultRecord.els };
  }
  if (tool === "browser_tabs" && Array.isArray(resultRecord?.tabs)) {
    return { k: "tabs", tabs: resultRecord.tabs };
  }
  if (tool === "browser_evaluate") {
    return { k: "eval", expr: mergedArgs.expression ?? mergedArgs.expr ?? target, res: output };
  }
  if (tool === "browser_screenshot" || tool === "take_screenshot" || tool === "preview_browser") {
    return {
      k: "shot",
      url: mergedArgs.url ?? target,
      vp: mergedArgs.viewport ?? "desktop",
      size: mergedArgs.size ?? "",
    };
  }
  if (tool === "verify_app" && Array.isArray(resultRecord?.items)) {
    return { k: "check", items: resultRecord.items };
  }
  if (tool === "create_file") {
    const content = String(mergedArgs.content ?? "");
    return {
      k: "card",
      name: mergedArgs.filename ?? target,
      size: `${new TextEncoder().encode(content).length} B`,
      ttl: "4h",
    };
  }
  if (tool === "ask_question" || tool === "ask_clarification") {
    const options = Array.isArray(mergedArgs.options) ? mergedArgs.options : mergedArgs.opts;
    if (Array.isArray(options)) return { k: "ask", q: mergedArgs.question ?? mergedArgs.q ?? target, opts: options };
  }
  if (tool === "todo_list" && Array.isArray(mergedArgs.items)) {
    return { k: "check", items: mergedArgs.items };
  }

  const rows = rowsFromRecord(mergedArgs);
  if (output) rows.push(["result", output]);
  if (rows.length === 0 && target) rows.push(["target", target]);
  return { k: "kv", rows };
}

function copyText(body: BodyRecord, target: string): string {
  return String(body.path ?? target ?? "");
}

function BodyPanel({
  tool,
  target,
  meta,
  body,
  copyValue,
  depth,
}: {
  tool: string;
  target: string;
  meta?: string;
  body: BodyRecord;
  copyValue: string;
  depth: number;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  const diffStats = body.k === "diff" && Array.isArray(body.lines)
    ? {
      add: body.lines.filter((line) => Array.isArray(line) && line[0] === "p").length,
      del: body.lines.filter((line) => Array.isArray(line) && line[0] === "m").length,
    }
    : undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setCopyFailed(false);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 1100);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopyFailed(false), 1800);
    }
  };

  return (
    <div className="otc-body">
      <div className="otc-path">
        <span className="otc-path-left">
          <em className="otc-tool-label">{tool}</em>
          {body.path ? (() => {
            const parts = pathParts(String(body.path));
            return <span>{parts.directory}<b>{parts.file}</b></span>;
          })() : null}
        </span>
        <span className="otc-path-right">
          {diffStats
            ? <><span className="otc-add-count">+{diffStats.add}</span><span className="otc-del-count">−{diffStats.del}</span></>
            : meta ? <span>{meta}</span> : null}
          <button type="button" className="otc-copy" onClick={copy} aria-live="polite">
            <CopyIcon />{copyFailed ? "Copy failed" : copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <BodyView body={body} depth={depth} />
    </div>
  );
}

export interface ToolCallRowProps {
  tool: string;
  target?: string;
  meta?: string;
  statusText?: string;
  status?: ToolState;
  args?: BodyRecord;
  result?: string;
  rawBody?: string;
  bodyData?: BodyRecord;
  thinkingText?: string;
  thinkingTokens?: number;
  startedAt?: number;
  endedAt?: number;
  now?: number;
  title?: string;
  depth?: number;
  entryDelay?: number;
}

export function ToolCallRow({
  tool,
  target = "",
  meta = "",
  statusText = "",
  status = "done",
  args = {},
  result,
  rawBody,
  bodyData,
  thinkingText,
  thinkingTokens,
  startedAt,
  endedAt,
  now,
  title,
  depth = 0,
  entryDelay = 0,
}: ToolCallRowProps) {
  const [open, setOpen] = useState(false);
  const definition = getToolDefinition(tool, title);
  const isThinking = tool === "thinking" || definition.category === "think";
  const [fallbackStartedAt] = useState(() => Date.now());
  const initialStart = useRef(startedAt || fallbackStartedAt);
  const start = startedAt || initialStart.current;
  const [localNow, setLocalNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "running" || now !== undefined) return;
    const timer = window.setInterval(() => setLocalNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [status, now]);

  const currentTime = now ?? localNow;
  const elapsed = status === "running"
    ? Math.max(0, currentTime - start) / 1000
    : endedAt !== undefined && startedAt !== undefined
      ? Math.max(0, endedAt - startedAt) / 1000
      : undefined;
  const rowTarget = isThinking
    ? status === "running" ? "" : elapsed !== undefined ? `for ${elapsed.toFixed(1)}s` : target
    : target;
  const body = getBody(tool, args, thinkingText ?? result, rawBody, rowTarget || target, bodyData);
  const count = thinkingTokens ?? Math.ceil((thinkingText ?? String(body.text ?? "")).length / 4);
  const rowMeta = status === "running"
    ? `${elapsed?.toFixed(1) ?? "0.0"}s`
    : isThinking
      ? `${count} tokens`
      : meta;
  const hasBody = status !== "running";
  const copyValue = copyText(body, rowTarget || target);
  const rightStatus = status === "running" ? null : statusText;

  return (
    <div
      className={`otc-row otc-cat-${definition.category}${status === "running" ? " is-running" : ""}${status === "failed" ? " is-failed" : ""}${status === "waiting" ? " is-waiting" : ""}${open && hasBody ? " is-open" : ""}`}
      style={{ animationDelay: `${entryDelay}ms` }}
    >
      <button
        type="button"
        className="otc-h"
        aria-expanded={hasBody ? open : undefined}
        aria-label={`${status === "running" ? definition.verbs[1] : definition.verbs[0]}${rowTarget ? ` ${rowTarget}` : ""}${hasBody ? `, ${open ? "collapse" : "expand"} details` : ""}`}
        onClick={() => hasBody && setOpen((value) => !value)}
        disabled={!hasBody}
      >
        <span className="otc-icon"><ToolIcon name={definition.icon} /></span>
        <span className="otc-verb">{status === "running" ? definition.verbs[1] : definition.verbs[0]}</span>
        {rowTarget ? (
          <code className="otc-target">
            {definition.extension ? <span className="otc-ext">{extOf(rowTarget)}</span> : null}
            <span>{rowTarget}</span>
          </code>
        ) : null}
        <span className="otc-spacer" />
        {status === "running" ? (
          <>
            <span className="otc-meta">{rowMeta}</span>
            <span className="otc-spinner" aria-label="In progress" />
          </>
        ) : (
          <>
            {rowMeta ? <span className={`otc-meta${isThinking ? " otc-token-count" : ""}`}>{rowMeta}</span> : null}
            {rightStatus ? <span className="otc-status">{rightStatus}</span> : null}
            {status === "done" ? <CheckIcon /> : null}
            {hasBody ? <Chevron className={open ? "is-open" : ""} /> : null}
          </>
        )}
      </button>
      {hasBody ? (
        <div className="otc-collapse" aria-hidden={!open}>
          <div className="otc-collapse-inner">
            <BodyPanel
              tool={tool}
              target={rowTarget || target}
              meta={meta}
              body={body}
              copyValue={copyValue}
              depth={depth}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface ToolCallProps {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  success?: boolean;
  status?: "running" | "success" | "error";
}

export default function ToolCallDisplay({ tool, args, result, success, status }: ToolCallProps) {
  const normalizedStatus: ToolState = status === "running" || (status === undefined && success === undefined)
    ? "running"
    : success === true || status === "success"
      ? "done"
      : success === false || status === "error"
        ? "failed"
        : "done";
  return (
    <div className="otc-feed">
      <ToolCallRow
        tool={tool}
        args={args}
        result={result}
        status={normalizedStatus}
        statusText={normalizedStatus === "failed" ? "failed" : ""}
        target={targetFromArgs(args ?? {}, getToolDefinition(tool).category)}
      />
    </div>
  );
}
