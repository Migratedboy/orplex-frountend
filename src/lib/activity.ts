import type { ContentSegment } from "./message-content";

export type StepKind =
  | "think"
  | "list"
  | "search"
  | "read"
  | "edit"
  | "run"
  | "browser"
  | "agent"
  | "mcp"
  | "other";

export type StepStatus = "live" | "done" | "error" | "approval";

export interface ActivityStep {
  id: string;
  kind: StepKind;
  tool?: string;
  title: string;
  chip?: string;
  meta?: string;
  detail?: string;
  body?: string;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
}

function shortLabel(value: string): string {
  const text = value.trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export interface ActivityGroup {
  id: string;
  steps: ActivityStep[];
  startedAt: number;
  endedAt?: number;
}

export function combineActivityGroups(groups: ActivityGroup[]): ActivityGroup | undefined {
  if (groups.length === 0) return undefined;
  if (groups.length === 1) return groups[0];

  const starts = groups.flatMap((group) => [
    ...(group.startedAt > 0 ? [group.startedAt] : []),
    ...group.steps.flatMap((step) => step.startedAt > 0 ? [step.startedAt] : []),
  ]);
  const ends = groups.flatMap((group) => [
    ...(group.endedAt ? [group.endedAt] : []),
    ...group.steps.flatMap((step) => step.endedAt ? [step.endedAt] : []),
  ]);
  const allEnded = groups.every((group) =>
    group.endedAt !== undefined ||
    (group.steps.length > 0 && group.steps.every((step) => step.status === "done" || step.status === "error"))
  );
  const startedAt = starts.length ? Math.min(...starts) : 0;
  const endedAt = allEnded && ends.length ? Math.max(...ends) : undefined;

  return {
    id: "activity-message",
    steps: groups.flatMap((group) => group.steps),
    startedAt,
    ...(endedAt ? { endedAt } : {}),
  };
}

export interface ActivityTiming {
  groups: Record<string, { startedAt: number; endedAt?: number }>;
  steps: Record<string, { startedAt: number; endedAt?: number }>;
}

export type ActivitySourceSegment = Pick<ContentSegment, "type" | "content"> &
  Partial<Pick<ContentSegment, "name" | "path" | "action" | "detail" | "live">>;

export interface GroupActivityOptions {
  live?: boolean;
  startedAt?: number;
  timing?: ActivityTiming;
}

const BODY_LIMIT = 4000;
const TOOL_KIND: Record<string, StepKind> = {
  list_files: "list",
  search_code: "search",
  code_search: "search",
  web_search: "search",
  playbook_search: "search",
  session_search: "search",
  read_file: "read",
  write_file: "edit",
  write_file_chunk: "edit",
  create_file: "edit",
  append_file: "edit",
  edit_file: "edit",
  batch_edit: "edit",
  undo_last_change: "edit",
  run_command: "run",
  run_in_sandbox: "run",
  take_screenshot: "browser",
  preview_browser: "browser",
  verify_app: "browser",
  launch_and_screenshot: "browser",
  check_console_errors: "browser",
  record_page: "browser",
  spawn_subagent: "agent",
  mcp_call: "mcp",
};

const SKIP_TOOLS = new Set([
  "todo_list",
  "ask_question",
  "ask_clarification",
  "scratchpad_update",
]);

const ACTIVITY_TYPES = new Set([
  "thinking",
  "status",
  "tool_call",
  "tool_result",
  "success",
  "error",
]);

function capped(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  return text.length > BODY_LIMIT
    ? `${text.slice(0, BODY_LIMIT)}… truncated`
    : text || undefined;
}

function safeTime(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 0;
}

function nameFromVerb(action: string): { kind: StepKind; title: string } {
  const verb = action.toLowerCase().replace(/[-_]/g, " ");
  if (verb === "listing") return { kind: "list", title: "Listed" };
  if (verb.includes("search")) return { kind: "search", title: "Searched" };
  if (verb === "analysing" || verb === "reading" || verb === "read") return { kind: "read", title: "Read" };
  if (verb === "writing" || verb === "appending" || verb === "overwriting" || verb === "editing" || verb === "batch editing" || verb === "staging") {
    return { kind: "edit", title: "Edited" };
  }
  if (verb === "undoing") return { kind: "edit", title: "Undid" };
  if (verb === "running" || verb === "sandbox") return { kind: "run", title: "Ran" };
  if (/^(browsing|clicking|capturing|previewing|verifying app)$/.test(verb)) {
    return { kind: "browser", title: verb === "verifying app" ? "Verified" : "Browsed" };
  }
  if (verb === "mcp") return { kind: "mcp", title: "Called" };
  if (verb === "asking") return { kind: "other", title: "Asked" };
  return { kind: "other", title: verb ? verb[0].toUpperCase() + verb.slice(1) : "Used" };
}

function toolTitle(tool: string): { kind: StepKind; title: string } {
  const kind = TOOL_KIND[tool] ??
    (tool.startsWith("browser_") ? "browser" : tool.startsWith("mcp__") ? "mcp" : "other");
  if (tool === "create_file") return { kind, title: "Created" };
  if (tool === "undo_last_change") return { kind, title: "Undid" };
  const title: Record<StepKind, string> = {
    think: "Thought",
    list: "Listed",
    search: "Searched",
    read: "Read",
    edit: "Edited",
    run: "Ran",
    browser: tool === "verify_app" ? "Verified" : "Browsed",
    agent: "Delegated",
    mcp: "Called",
    other: shortLabel(tool.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())) || "Used",
  };
  return { kind, title: title[kind] };
}

function toolCallData(segment: ActivitySourceSegment): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(segment.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function chipFromArgs(args: Record<string, unknown>, kind: StepKind): string | undefined {
  const preferred = kind === "search"
    ? ["query", "pattern"]
    : kind === "run"
      ? ["command"]
      : kind === "browser"
        ? ["url", "path"]
        : ["path", "filename", "file", "task", "server"];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return shortLabel(value);
  }
  const first = Object.values(args).find((value) => typeof value === "string" && value.trim());
  return typeof first === "string" ? shortLabel(first) : undefined;
}

function metaFromResult(kind: StepKind, result: string): string | undefined {
  if (kind === "list") return result.match(/\b\d+\s+items?\b/i)?.[0];
  if (kind === "search") return result.match(/\b\d+\s+(?:matches|results)\b/i)?.[0];
  if (kind === "read") {
    const lines = result.match(/\blines?\s+(\d+)\s*[-–]\s*(\d+)/i);
    return lines ? `lines ${lines[1]}–${lines[2]}` : undefined;
  }
  if (kind === "edit") {
    const diff = result.match(/\+\s*\d+\s*[−-]\s*\d+/);
    return diff?.[0];
  }
  if (kind === "run") return result.match(/\bexit(?: code)?\s*-?\d+\b/i)?.[0];
  if (kind === "agent") return "read-only";
  return undefined;
}

function resultKind(segment: ActivitySourceSegment): StepStatus {
  const content = `${segment.detail ?? ""} ${segment.content}`;
  if (segment.type === "error" || /\b(?:error|failed|blocked)\b/i.test(content)) return "error";
  return "done";
}

function makeStep(
  groupId: string,
  index: number,
  fields: Omit<ActivityStep, "id" | "startedAt" | "endedAt">,
  timing?: ActivityTiming
): ActivityStep {
  const id = `${groupId}-step-${index}`;
  const saved = timing?.steps[id];
  return {
    ...fields,
    id,
    startedAt: safeTime(saved?.startedAt),
    ...(saved?.endedAt ? { endedAt: saved.endedAt } : {}),
  };
}

function buildGroup(
  id: string,
  source: ActivitySourceSegment[],
  options: GroupActivityOptions
): ActivityGroup {
  const steps: ActivityStep[] = [];
  const pending: number[] = [];
  const add = (step: Omit<ActivityStep, "id" | "startedAt" | "endedAt">) => {
    const created = makeStep(id, steps.length, step, options.timing);
    steps.push(created);
    return steps.length - 1;
  };
  const finishPending = (segment: ActivitySourceSegment) => {
    const body = capped(segment.detail || segment.content);
    const failed = resultKind(segment) === "error";
    let pendingIndex = segment.name
      ? pending.findIndex((stepIndex) => steps[stepIndex].tool === segment.name)
      : -1;
    const resultPath = (segment.detail || segment.content).match(/`([^`]+)`/)?.[1];
    if (pendingIndex < 0 && resultPath) {
      pendingIndex = pending.findIndex((stepIndex) => steps[stepIndex].chip === resultPath);
    }
    let index = pending.splice(pendingIndex < 0 ? 0 : pendingIndex, 1)[0];
    if (index === undefined) {
      const label = segment.detail || segment.content;
      const kind = /listed/i.test(label) ? "list"
        : /search/i.test(label) ? "search"
          : /read/i.test(label) ? "read"
            : /command|sandbox/i.test(label) ? "run" : "other";
      const title = kind === "list" ? "Listed" : kind === "search" ? "Searched" : kind === "read" ? "Read" : kind === "run" ? "Ran" : "Used";
      const chipMatch = label.match(/`([^`]+)`/);
      index = add({
        kind,
        title,
        chip: chipMatch ? shortLabel(chipMatch[1]) : undefined,
        body,
        status: failed ? "error" : "done",
      });
    } else {
      const step = steps[index];
      step.status = failed ? "error" : "done";
      step.body = capped([step.body, body].filter(Boolean).join("\n\n"));
      step.meta = metaFromResult(step.kind, body || "");
    }
    return index;
  };

  for (const segment of source) {
    if (segment.type === "thinking") {
      const [title, ...rest] = segment.content.trim().split(/\r?\n/);
      add({
        kind: "think",
        title: shortLabel(title || "Thinking"),
        detail: capped(rest.join("\n")),
        body: capped(segment.content),
        status: segment.live && options.live ? "live" : "done",
      });
      continue;
    }
    if (segment.type === "status") {
      const tool = nameFromVerb(segment.action || "");
      const approval = /awaiting approval/i.test(segment.detail || "");
      const index = add({
        kind: tool.kind,
        title: tool.title,
        chip: segment.path ? shortLabel(segment.path) : undefined,
        detail: capped(segment.detail),
        status: approval ? "approval" : options.live ? "live" : "done",
      });
      pending.push(index);
      continue;
    }
    if (segment.type === "tool_call") {
      const args = toolCallData(segment);
      const tool = String(args.name || segment.name || "tool");
      if (SKIP_TOOLS.has(tool)) continue;
      const label = toolTitle(tool);
      const chip = chipFromArgs(args, label.kind);
      const body = capped(JSON.stringify(args, null, 2));
      const index = add({
        kind: label.kind,
        tool: shortLabel(tool),
        title: label.title,
        chip,
        detail: tool === "spawn_subagent" && typeof args.task === "string" ? capped(args.task) : undefined,
        body,
        status: options.live ? "live" : "done",
      });
      pending.push(index);
      continue;
    }
    if (segment.type === "success" || segment.type === "error" || segment.type === "tool_result") {
      const result = finishPending(segment);
      if (options.live && steps[result].status === "live") pending.push(result);
    }
  }

  const groupTiming = options.timing?.groups[id];
  const firstStep = steps.find((step) => step.startedAt > 0);
  const startedAt = safeTime(groupTiming?.startedAt) || firstStep?.startedAt || safeTime(options.startedAt);
  const endedAt = groupTiming?.endedAt;
  return { id, steps, startedAt, ...(endedAt ? { endedAt } : {}) };
}

export function groupActivitySegments(
  segments: ContentSegment[],
  options: GroupActivityOptions = {}
): ContentSegment[] {
  const output: ContentSegment[] = [];
  let run: ActivitySourceSegment[] = [];
  let groupIndex = 0;
  const flush = () => {
    if (run.length === 0) return;
    const id = `activity-${groupIndex++}`;
    output.push({
      type: "activity",
      content: "",
      activity: buildGroup(id, run, options),
    });
    run = [];
  };

  for (const segment of segments) {
    if (ACTIVITY_TYPES.has(segment.type)) {
      run.push(segment);
    } else {
      flush();
      output.push(segment);
    }
  }
  flush();
  return output;
}

export function captureActivityTiming(
  segments: ContentSegment[],
  previous: ActivityTiming | undefined,
  now: number,
  terminal: boolean
): ActivityTiming {
  const next: ActivityTiming = {
    groups: { ...(previous?.groups ?? {}) },
    steps: { ...(previous?.steps ?? {}) },
  };

  for (const segment of segments) {
    if (segment.type !== "activity" || !segment.activity) continue;
    const group = segment.activity;
    const groupTiming = { ...(next.groups[group.id] ?? { startedAt: now }) };
    for (const step of group.steps) {
      const timing = { ...(next.steps[step.id] ?? { startedAt: now }) };
      if ((step.status === "done" || step.status === "error") && !timing.endedAt) {
        timing.endedAt = now;
      } else if (terminal && !timing.endedAt) {
        timing.endedAt = now;
      }
      next.steps[step.id] = timing;
    }
    const hasPendingStep = group.steps.some((step) => step.status === "live" || step.status === "approval");
    if (hasPendingStep && !terminal) {
      delete groupTiming.endedAt;
    } else if (terminal || group.steps.every((step) => step.status === "done" || step.status === "error")) {
      groupTiming.endedAt ??= now;
    }
    next.groups[group.id] = groupTiming;
  }
  return next;
}

export function formatActivityTime(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 100) return "<0.1s";
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

export function activitySummary(steps: ActivityStep[]): string {
  const counts = new Map<StepKind, number>();
  for (const step of steps) {
    if (step.kind !== "think" && step.kind !== "other" && step.status !== "approval") {
      counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  const add = (kind: StepKind, unit: string) => {
    const count = counts.get(kind) ?? 0;
    if (count) parts.push(`${kind === "list" ? "Listed" : kind === "search" ? "Searched" : kind === "read" ? "Read" : kind === "edit" ? "Edited" : kind === "run" ? "Ran" : kind === "browser" ? "Browsed" : kind === "agent" ? "Delegated" : "Called"} ${count} ${unit}${count === 1 ? "" : "s"}`);
  };
  add("list", "folder");
  add("search", "pattern");
  add("read", "file");
  add("edit", "file");
  add("run", "command");
  add("browser", "page");
  add("agent", "task");
  add("mcp", "tool");
  if (parts.length === 0) return "Finished thinking";
  return `${parts.slice(0, 5).join(", ")}${parts.length > 5 ? ", …" : ""}`;
}

export function appendLiveToolSteps(
  segments: ContentSegment[],
  calls: Array<{ id: string; tool: string; args: Record<string, unknown>; startedAt?: number }>,
  startedAt: number
): ContentSegment[] {
  if (calls.length === 0) return segments;
  const next = [...segments];
  const last = next[next.length - 1];
  let group = last?.type === "activity" ? last.activity : undefined;
  if (!group) {
    group = { id: `activity-${next.filter((s) => s.type === "activity").length}`, steps: [], startedAt };
    next.push({ type: "activity", content: "", activity: group });
  }
  const existing = new Set(group.steps.map((step) => step.id));
  const steps = [...group.steps];
  for (const call of calls) {
    if (existing.has(call.id)) continue;
    const label = toolTitle(call.tool);
    const chip = chipFromArgs(call.args, label.kind);
    if (steps.some((step) =>
      step.status === "live" &&
      step.kind === label.kind &&
      step.chip === chip &&
      (!step.tool || step.tool === call.tool)
    )) continue;
    steps.push({
      id: call.id,
      kind: label.kind,
      tool: call.tool,
      title: label.title,
      chip,
      body: capped(JSON.stringify(call.args, null, 2)),
      status: "live",
      startedAt: call.startedAt || startedAt,
    });
    existing.add(call.id);
  }
  const updated = { ...group, steps };
  next[next.length - 1] = { type: "activity", content: "", activity: updated };
  return next;
}
