// executor.ts — The server-side run executor.
//
// Manager-spawned runs no longer depend on an open browser tab: a persistent
// Node process (Next.js instrumentation hook, see instrumentation.ts) leases
// pending runs from the DB, isolates the user's workspace into a git worktree,
// runs a full tool loop against the provider adapter, records artifacts/events,
// and checkpoints terminal state. Merging the agent's branch back is EXPLICIT
// (POST /api/agent/runs/[id]/merge) after review.
//
// Approvals: server runs use the DB ApprovalRequest table (not the browser
// in-memory store). An approval-needing action parks the run in
// "waiting_approval" and the loop pauses until the request is decided via
// POST /api/agent/runs/[id]/approve (the Manager board surfaces these).

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getWorkspaceCwdForUser, resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { parseToolCalls, parseBareJsonToolCalls } from "@/lib/tool-text";
import { isCommandAllowed } from "@/lib/exec-guard";
import { createProviderAdapter, createAdapterForProvider, type AIProviderAdapter, type NativeToolDef, type NativeToolCall } from "@/lib/ai-providers";
import { isRateLimitError, isTransientError } from "@/lib/retry";
import { withVerifySlot, verifyPortForRun } from "./verify-gate";
import { isClaimsPaused, isMemoryPressureHigh } from "@/lib/hardware";
import {
  newAutoCheckpointState,
  shouldAutoCheckpoint,
  recordAutoCheckpoint,
  accumulateDelta,
  type AutoCheckpointState,
} from "../auto-checkpoint";
import { projectMemoryBlock } from "@/lib/project-memory";
import { loadUserSkills, renderSkillRoster, skillBody } from "@/lib/user-skills";
import { recordRuntimeLog } from "@/lib/runtime-log";
import { runtimeState } from "@/lib/runtime-state";
import { maxConcurrentRuns, parseFailoverChain } from "./executor-config";
import { getMcpServerForRun, ensureMcpReaper, mcpToolName, parseMcpToolName, type McpToolDef, type McpServerConfig as McpRunConfig } from "../mcp-client";
import { collectMcpServerConfigs, MAX_MCP_SERVERS_PER_RUN } from "../mcp-accounts";
import { getMcpCatalogEntry } from "../mcp-catalog";
import { mcpUsageBlock, mcpServerSummaries } from "../mcp-prompt";
import { grepSearch, codeSearch } from "@/lib/grep-search";
import {
  createScratchpad,
  seedScratchpad,
  updateScratchpadSection,
  renderScratchpadBlock,
  type ScratchpadState,
  type ScratchpadSection,
} from "@/lib/scratchpad";
import type { VerifyResult } from "@/lib/browser-verification";
import { loadToolHooks, evaluateDenyRules, matchesNotifyRules, type CompiledHooks } from "@/lib/tool-hooks";
import { runUserHooks } from "@/lib/user-hooks";
import { recordProviderEvent } from "@/lib/provider-uptime";
import { acquireTokens, estimateTokensOfMessages, reportUsage } from "@/lib/tpm-pacer";
import { createIsolatedContext, type WorktreeContext } from "./worktree";
import type { RuntimeArtifact } from "@/lib/agent/runtime/types";

const POLL_INTERVAL_MS = 4000;
const TURN_LIMIT = 60;
const MAX_TOKENS = 8192;
// Transcript budget for compaction — mirrors the worker's free-tier math.
const MSG_BUDGET_TOKENS = 8000 - 400 - 2000 - 2500;
const APPROVAL_WAIT_TIMEOUT_MS = 10 * 60_000;
const APPROVAL_POLL_MS = 2000;
const TOOL_WHITELIST = new Set([
  "write_file",
  "edit_file",
  "read_file",
  "list_files",
  "search_code",
  "run_command",
  // Browser-as-sensor: navigate/read/click/type/console/screenshot plus the
  // advanced ops (find/wait/hover/select/tabs/network/evaluate) — the run
  // adapts mid-task from what the page shows (SSRF-guarded session below).
  "browser_navigate",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_console",
  "browser_screenshot",
  "browser_find",
  "browser_wait_for",
  "browser_hover",
  "browser_select",
  "browser_tabs",
  "browser_network",
  "browser_evaluate",
  "use_skill",
  "scratchpad_update",
]);

interface QueuedRun {
  id: string;
  userId: string;
  prompt: string;
  workspace: string;
  autonomyPolicy: string;
  modelOverride?: string | null;
}

// ── Concurrency (RAM-aware) — implementation lives in executor-config.ts ──────────────────────────────────────────────────
// ── Native (OpenAI function-calling) tool definitions ──────────────────────
// Weak models drop the XML wrapper and emit bare JSON (live-observed); the
// text-protocol fallbacks stay, but native tool calling removes that whole
// bug class on models that support it.

export function buildNativeToolDefs(mcpTools: McpToolDef[]): NativeToolDef[] {
  const obj = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
    type: "object",
    properties: props,
    required,
  });
  const defs: NativeToolDef[] = [
    { name: "write_file", description: "Create or overwrite a file in the worktree.", parameters: obj({ path: { type: "string", description: "Relative path" }, content: { type: "string" } }, ["path", "content"]) },
    { name: "edit_file", description: "Replace an exact substring in a file.", parameters: obj({ path: { type: "string", description: "Relative path" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["path", "old_text", "new_text"]) },
    { name: "read_file", description: "Read a file from the worktree. Large files: pass offset (1-based line) and limit (line count) to read an exact window without loading the whole file — page forward with offset=<last_end+1>.", parameters: obj({ path: { type: "string", description: "Relative path" }, offset: { type: "number", description: "1-based starting line (pagination)" }, limit: { type: "number", description: "Max lines to return per call (default 2000, cap 200000 chars)" } }, ["path"]) },
    { name: "list_files", description: "List files under a worktree path.", parameters: obj({ path: { type: "string", description: "Relative path, optional" } }, []) },
    { name: "search_code", description: "Search the worktree (ripgrep-backed).", parameters: obj({ query: { type: "string" } }, ["query"]) },
    { name: "code_search", description: "Search with context: grouped per-file matching-line snippets plus a ready-made read_file offset/limit hint per match — locate regions without reading whole files.", parameters: obj({ query: { type: "string" }, context: { type: "number", description: "Context lines around each match (0-10, default 3)" } }, ["query"]) },
    { name: "use_skill", description: "Load the full instructions of a listed skill by name.", parameters: obj({ name_of_skill: { type: "string", description: "Skill name from the roster" } }, ["name_of_skill"]) },
    { name: "scratchpad_update", description: "Write to your private scratchpad (plan, hypotheses, findings, next move). Re-shown every turn, never a deliverable. Never store secrets.", parameters: obj({ section: { type: "string", description: "plan | hypotheses | findings | next" }, content: { type: "string", description: "New section content" } }, ["section", "content"]) },
    { name: "run_command", description: "Run a shell command in the worktree (screened; dangerous commands are refused).", parameters: obj({ command: { type: "string" } }, ["command"]) },
    { name: "browser_navigate", description: "Open a URL in the agent's SSRF-guarded headless browser. Returns HTTP status, title, and page summary.", parameters: obj({ url: { type: "string", description: "Full URL to load" } }, ["url"]) },
    { name: "browser_read", description: "Read the active tab: URL, title, text, headings, interactive elements with selectors.", parameters: obj({}, []) },
    { name: "browser_find", description: "Find clickable/fillable elements with refs (e1, e2, …). Pass ref to click/type/hover/select instead of a CSS selector.", parameters: obj({ text: { type: "string", description: "Filter by name/label substring" }, role: { type: "string", description: "Filter: link, button, textbox, combobox, heading" } }, []) },
    { name: "browser_click", description: "Click an element by selector or browser_find ref.", parameters: obj({ selector: { type: "string" }, ref: { type: "string", description: "Ref from browser_find, e.g. e3" } }, []) },
    { name: "browser_type", description: "Type text into an input by selector or browser_find ref (clears first).", parameters: obj({ selector: { type: "string" }, ref: { type: "string", description: "Ref from browser_find" }, text: { type: "string" } }, ["text"]) },
    { name: "browser_press", description: "Press a key (Enter, Escape, Tab) in the active tab.", parameters: obj({ key: { type: "string" } }, ["key"]) },
    { name: "browser_scroll", description: "Scroll the page (pixels, default 600).", parameters: obj({ amount: { type: "number" } }, []) },
    { name: "browser_wait_for", description: "Wait for text to appear, a selector to become visible, or a fixed delay (ms) — use after SPA clicks.", parameters: obj({ text: { type: "string" }, selector: { type: "string" }, time: { type: "number" }, timeoutMs: { type: "number" } }, []) },
    { name: "browser_hover", description: "Hover an element (selector or ref) to trigger menus/tooltips.", parameters: obj({ selector: { type: "string" }, ref: { type: "string", description: "Ref from browser_find" } }, []) },
    { name: "browser_select", description: "Pick an <option> in a <select> (value or label).", parameters: obj({ selector: { type: "string" }, ref: { type: "string", description: "Ref from browser_find" }, value: { type: "string" } }, ["value"]) },
    { name: "browser_tabs", description: "Manage tabs: list | new (optionally url) | switch (index) | close (index). Ops act on the active tab.", parameters: obj({ action: { type: "string" }, url: { type: "string" }, index: { type: "number" } }, []) },
    { name: "browser_console", description: "Console messages (errors/warnings/logs) since session start.", parameters: obj({}, []) },
    { name: "browser_network", description: "Failed requests (HTTP 4xx/5xx + aborted) since session start — diagnose blank pages / missing data.", parameters: obj({}, []) },
    { name: "browser_screenshot", description: "Capture the active tab; optionally fullPage or a named viewport (desktop/tablet/mobile) for responsive checks.", parameters: obj({ fullPage: { type: "boolean" }, viewpoint: { type: "string", description: "desktop | tablet | mobile" } }, []) },
    { name: "browser_evaluate", description: "Run JavaScript in the page and get the JSON result (bare expression or multi-statement IIFE auto-wrapped).", parameters: obj({ code: { type: "string", description: "Expression or statements, e.g. document.title or const n = document.images.length; n" } }, ["code"]) },
  ];
  for (const t of mcpTools.slice(0, 20)) {
    const schema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
      ? (t.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
    defs.push({
      name: mcpToolName(t.server, t.name),
      description: t.description.slice(0, 300),
      parameters: schema,
    });
  }
  return defs;
}

// ── Failover chain (opt-in, executor only) ───────────────────────────────────────
// AI_FAILOVER="groq,openrouter" — tried in order after the configured primary
// when it fails with a rate/quota error. Filtering (primary, unknown,
// keyless) lives in executor-config.ts where it is unit-testable.

function parseFailoverChainEnv(): string[] {
  return parseFailoverChain(process.env.AI_FAILOVER, process.env.AI_PROVIDER || "nvidia", process.env);
}

function buildSystemPrompt(mcpTools: McpToolDef[], nativeMode: boolean, memoryBlock = "", skillRoster = "", mcpServers?: Array<{ name: string; description: string; toolCount: number }>): string {
  const lines = [
    `You are the Orplex Server Agent, executing a task in an isolated git worktree of the user's workspace.`,
    nativeMode
      ? `Call tools through the provided function-calling interface. Available tools:`
      : `Reply with tool calls in <tool_call>{...}</tool_call> XML format. Available tools:`,
    `- write_file { "name": "write_file", "path": "...", "content": "..." }`,
    `- edit_file { "name": "edit_file", "path": "...", "old_text": "...", "new_text": "..." }`,
    `- read_file { "name": "read_file", "path": "..." }`,
    `- list_files { "name": "list_files", "path": "..." }`,
    `- search_code { "name": "search_code", "query": "..." }`,
    `- code_search { "name": "code_search", "query": "..." } (grouped snippets + read_file hints — preferred for locating code)`,
    `- run_command { "name": "run_command", "command": "..." } (screened; dangerous commands are refused)`,
    `- scratchpad_update { "name": "scratchpad_update", "section": "plan|hypotheses|findings|next", "content": "..." } (private working memory, re-shown every turn — record plan, findings, next move; never store secrets)`,
    `Keep a private scratchpad via scratchpad_update as you learn — todo discipline still applies; the scratchpad holds reasoning, not checkmarks.`,
  ];
  if (skillRoster) {
    lines.push(``, `Skills available (call use_skill { "name": "use_skill", "name_of_skill": "<name>" } to load the full instructions):`, skillRoster);
  }
  if (memoryBlock) {
    lines.push(``, `Project memory (user-authored conventions from orplex.md — follow these):`, memoryBlock);
  }
  if (mcpTools.length > 0) {
    lines.push(``, `External MCP tools (call like any other tool):`);
    for (const t of mcpTools.slice(0, 20)) {
      lines.push(`- ${mcpToolName(t.server, t.name)} — ${t.description.slice(0, 160)}`);
    }
    if (mcpServers && mcpServers.length > 0) {
      lines.push(``, `Connected MCP services:`, mcpServerSummaries(mcpServers));
    }
    lines.push(``, mcpUsageBlock(mcpTools.length));
  }
  lines.push(
    ``,
    `Rules: complete the task with as few turns as possible. Verify your work (read files back, run quick commands). When the task is done, finish with a plain-text summary and NO further tool calls.`,
  );
  if (nativeMode) {
    lines.push(`If function calling is unavailable, fall back to <tool_call>{...}</tool_call> XML.`);
  }
  return lines.join("\n");
}

// ── Lease (CAS — same arbitration as the client claimer) ──────────────────

async function leaseOneRun(): Promise<QueuedRun | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await prisma.agentRun.findFirst({
      where: {
        status: "pending",
        executionTarget: "server",
        // Morning-PR-queue scheduling: a run queued for later is invisible to
        // the lease loop until its time arrives.
        OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }],
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      select: { id: true, userId: true, prompt: true, workspace: true, autonomyPolicy: true, modelOverride: true },
    });
    if (!candidate) return null;
    const claimed = await prisma.agentRun.updateMany({
      where: {
        id: candidate.id,
        status: "pending",
        OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }],
      },
      data: { status: "executing" },
    });
    if (claimed.count > 0) return candidate as QueuedRun;
  }
  return null;
}

async function emit(runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const latest = await prisma.runEvent.findFirst({
      where: { runId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await prisma.runEvent.create({
      data: { runId, sequence: (latest?.sequence ?? -1) + 1, type, payload: payload as Prisma.InputJsonValue },
    });
  } catch {}
}

async function artifact(
  runId: string,
  kind: string,
  name: string,
  content: string,
  mediaType = "text/plain",
  taskId?: string
): Promise<void> {
  try {
    await prisma.agentArtifact.create({
      data: { runId, kind, name, mediaType, content: content.slice(0, 200_000), ...(taskId ? { taskId } : {}) },
    });
  } catch {}
}

// ── Tool execution inside the worktree ────────────────────────────────────

async function readLocalFile(root: string, rel: string): Promise<string> {
  const { readFile } = await import("fs/promises");
  const { resolve, sep, isAbsolute } = await import("path");
  const p = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const rootR = resolve(root);
  if (p !== rootR && !p.startsWith(rootR + sep)) throw new Error("path escapes workspace");
  return readFile(p, "utf8");
}

// Paged read: stream ONLY the byte range covering the requested line window
// (plus a small byte cap per page). A 74 MB log read at offset=700000
// touches ~200 KB of disk, not 74 MB — the native replacement for the
// sed -n 'X,Yp' workaround. Returns null when the file doesn't exist.
async function readLocalFilePage(
  root: string,
  rel: string,
  offsetLine: number,
  limitLines: number
): Promise<{ text: string; startLine: number; endLine: number; totalLines: number; hasMore: boolean } | null> {
  const fs = await import("fs/promises");
  const { createReadStream } = await import("fs");
  const { createInterface } = await import("readline");
  const { resolve, sep, isAbsolute } = await import("path");
  const p = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const rootR = resolve(root);
  if (p !== rootR && !p.startsWith(rootR + sep)) throw new Error("path escapes workspace");

  // Contained, bounded line stream: skip offset-1 lines, collect up to a
  // byte ceiling worth of pages. Max total lines discovered is bounded too
  // (we stop counting after the window ends — totalLines is then approximate).
  const MAX_PAGE_BYTES = 200_000;
  const stream = createReadStream(p, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let lineNo = 0;
    let bytes = 0;
    let out: string[] = [];
    let sawEnd = false;
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offsetLine) continue;
      if (out.length >= limitLines || bytes > MAX_PAGE_BYTES) { sawEnd = true; break; }
      out.push(line);
      bytes += line.length + 1;
    }
    if (!sawEnd) {
      // consumed to EOF — lineNo is the true total
    }
    if (lineNo < offsetLine && out.length === 0) return null; // offset past EOF
    return {
      text: out.join("\n"),
      startLine: offsetLine,
      endLine: offsetLine - 1 + out.length,
      totalLines: lineNo,
      hasMore: sawEnd || lineNo > offsetLine - 1 + out.length,
    };
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function listLocalFiles(root: string, rel = ""): Promise<string[]> {
  const { readdir } = await import("fs/promises");
  const { join, resolve, sep, isAbsolute } = await import("path");
  const dir = rel ? (isAbsolute(rel) ? resolve(rel) : resolve(root, rel)) : resolve(root);
  const rootR = resolve(root);
  if (dir !== rootR && !dir.startsWith(rootR + sep)) throw new Error("path escapes workspace");
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".orplex-workspaces"]);
  const out: string[] = [];
  const walk = async (d: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length >= 400) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const relPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), relPath, depth + 1);
      else out.push(relPath);
    }
  };
  await walk(dir, rel, 0);
  return out;
}

async function executeTool(
  call: { name: string; [k: string]: unknown },
  ctx: WorktreeContext,
  requiresApproval: boolean,
  runId: string,
  writtenFiles?: Set<string>,
  hooks?: CompiledHooks,
  autoCp?: AutoCheckpointState,
  mcpRunConfigs?: Record<string, McpRunConfig>,
  scratchpad?: {
    get(): ScratchpadState;
    update(section: ScratchpadSection, content: string): void;
  }
): Promise<string> {
  const name = call.name;

  // Pre-write auto checkpoint: BEFORE the first mutating write to a file
  // (and after cooldown/cap/RAM gates), snapshot the tree so rewind can
  // restore the exact pre-write state. Best-effort by contract — any
  // failure here never blocks the write.
  if (
    autoCp &&
    (name === "write_file" || name === "edit_file") &&
    typeof call.path === "string" &&
    call.path.trim()
  ) {
    const relPath = String(call.path).replace(/\\/g, "/");
    // Delta-aware cooldown: the size of THIS write counts toward the
    // cheap-diff threshold, so small edit bursts checkpoint every time
    // while repeated large rewrites of one file stay on the 15s cooldown.
    const incomingBytes =
      name === "write_file" && typeof call.content === "string"
        ? Buffer.byteLength(call.content, "utf8")
        : name === "edit_file" && typeof call.new_text === "string"
        ? Buffer.byteLength(call.new_text, "utf8")
        : 0;
    accumulateDelta(autoCp, incomingBytes);
    const decision = shouldAutoCheckpoint(autoCp, relPath, Date.now());
    if (decision.take) {
      try {
        const { createCheckpoint } = await import("../checkpoints");
        const cp = await createCheckpoint(ctx.rootDir, runId, `auto: before ${name} ${relPath.slice(0, 60)}`, []);
        await prisma.runCheckpoint.create({
          data: { runId, sequence: cp.n >= 0 ? cp.n : 0, kind: cp.kind, ref: cp.ref, label: cp.label, filesCount: cp.files.length },
        }).catch(() => {});
        await emit(runId, "checkpoint-created", { sequence: cp.n, kind: cp.kind, label: cp.label, auto: true });
        recordAutoCheckpoint(autoCp, relPath, Date.now());
      } catch {
        // checkpointing is best-effort — the write proceeds
      }
    }
  }

  // Config-driven tool hooks: deny rules block with a reason the agent can
  // read; notify rules emit a runtime event the Manager timeline shows.
  if (hooks) {
    const deny = evaluateDenyRules(hooks, name, call);
    if (deny.blocked) {
      await emit(runId, "tool-denied", { tool: name, reason: deny.reason }).catch(() => {});
      return `blocked: ${deny.reason}`;
    }
    if (matchesNotifyRules(hooks, name, call)) {
      await emit(runId, "tool-notify", { tool: name }).catch(() => {});
    }
  }

  // User-authored process hooks (.orplex/hooks.json, opt-in via env): a
  // pre-tool hook exits 2 → block the call; output streams into the result.
  const pre = await runUserHooks(ctx.rootDir, "pre-tool", { tool: name }).catch(() => null);
  if (pre?.blocked) {
    await emit(runId, "tool-denied", { tool: name, reason: "pre-tool hook" }).catch(() => {});
    return `blocked by pre-tool hook: ${pre.output.slice(0, 300)}`;
  }

  // ── MCP tools (mcp__<server>__<tool>) — dispatched through the hooks gate ──
  if (name.startsWith("mcp__")) {
    const parsed = parseMcpToolName(name);
    if (!parsed) return `error: malformed MCP tool name "${name.slice(0, 80)}"`;
    if (!mcpRunConfigs || Object.keys(mcpRunConfigs).length === 0) {
      return `error: no MCP servers are connected for this run — the user can add connectors in Settings → Connectors`;
    }
    try {
      const handle = await getMcpServerForRun(parsed.server, mcpRunConfigs);
      return await handle.callTool(parsed.tool, call as Record<string, unknown>);
    } catch (err) {
      return `error: ${(err as Error).message.slice(0, 500)}`;
    }
  }

  // use_skill: inject the full body of a discovered skill into the
  // transcript (the roster in the system prompt carries only descriptions).
  if (name === "use_skill" && typeof call.name_of_skill === "string") {
    return (call.__skillBody as string) || `error: skill "${String(call.name_of_skill).slice(0, 80)}" not found`;
  }

  // scratchpad_update: the run's private working memory (plan, hypotheses,
  // findings, next). State lives in the run scope; this case only validates
  // and routes. Unknown sections fail loudly so the model adapts.
  if (name === "scratchpad_update") {
    const section = typeof call.section === "string" ? call.section : "";
    const content = typeof call.content === "string" ? call.content : JSON.stringify(call.content ?? "");
    if (!scratchpad) {
      return `error: no scratchpad in this environment; keep reasoning in the reply text instead.`;
    }
    if (!["plan", "hypotheses", "findings", "next"].includes(section)) {
      return `error: section must be one of: plan, hypotheses, findings, next.`;
    }
    scratchpad.update(section as ScratchpadSection, content.slice(0, 2000));
    return `recorded ${section} (${content.length} chars). It will be re-shown every turn.`;
  }

  if (name === "read_file" && typeof call.path === "string") {
    // Paged path: offset (1-based line) and/or limit present → stream only
    // that window from disk (never materializes the whole file).
    const wantsPage = call.offset !== undefined || call.limit !== undefined;
    try {
      if (wantsPage) {
        const page = await readLocalFilePage(
          ctx.worktreeDir,
          call.path,
          Math.max(1, Math.floor(Number(call.offset)) || 1),
          Math.max(1, Math.min(2000, Math.floor(Number(call.limit)) || 2000))
        );
        if (!page) return `error: offset ${call.offset} is past end of file`;
        const body =
          page.text +
          (page.hasMore
            ? `\n\n[…page continues — read_file ${call.path} offset=${page.endLine + 1} for the next section; ${page.totalLines.toLocaleString()}+ lines total]`
            : `\n\n[end of file — ${page.totalLines.toLocaleString()} lines total]`);
        return body;
      }
      return await readLocalFile(ctx.worktreeDir, call.path);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (name === "list_files") {
    try {
      const files = await listLocalFiles(ctx.worktreeDir, typeof call.path === "string" ? call.path : "");
      return files.length ? files.join("\n") : "(no files)";
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (name === "search_code" && typeof call.query === "string") {
    try {
      // Real tree search via the shared chain (rg → git grep → node scan).
      // The worktree is the containment boundary — no per-user cwd here.
      const result = await grepSearch(ctx.worktreeDir, call.query);
      if (!result) throw new Error("no search engine available");
      return result.output || `No matches for "${call.query}"`;
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (name === "code_search" && typeof call.query === "string") {
    try {
      // Snippet mode: grouped context + read_file offset/limit hints.
      const result = await codeSearch(ctx.worktreeDir, call.query, {
        context: typeof call.context === "number" ? call.context : undefined,
      });
      if (!result) throw new Error("no search engine available");
      return result.output || `No matches for "${call.query}"`;
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (name === "write_file" && typeof call.path === "string" && typeof call.content === "string") {
    try {
      const { writeFile, mkdir } = await import("fs/promises");
      const { dirname, resolve, sep, isAbsolute, relative } = await import("path");
      const p = isAbsolute(call.path) ? resolve(call.path) : resolve(ctx.worktreeDir, call.path);
      const rootR = resolve(ctx.worktreeDir);
      if (p !== rootR && !p.startsWith(rootR + sep)) return "error: path escapes workspace";
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, call.content, "utf8");
      writtenFiles?.add(relative(rootR, p).replace(/\\/g, "/"));
      return "ok";
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (
    name === "edit_file" &&
    typeof call.path === "string" &&
    typeof call.old_text === "string" &&
    typeof call.new_text === "string"
  ) {
    try {
      const { writeFile } = await import("fs/promises");
      const { resolve, sep, isAbsolute } = await import("path");
      const p = isAbsolute(call.path) ? resolve(call.path) : resolve(ctx.worktreeDir, call.path);
      const rootR = resolve(ctx.worktreeDir);
      if (p !== rootR && !p.startsWith(rootR + sep)) return "error: path escapes workspace";
      const { readFile: rf } = await import("fs/promises");
      const current = await rf(p, "utf8");
      if (!current.includes(call.old_text)) return "error: old_text not found";
      await writeFile(p, current.replace(call.old_text, call.new_text), "utf8");
      return "ok";
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  // ── browser_* — server session, called directly (no HTTP hop) ──────────
  if (typeof name === "string" && name.startsWith("browser_")) {
    const { runBrowserOp } = await import("@/lib/agent-browser-session");
    const opMap: Record<string, { op: string; args: Record<string, unknown> }> = {
      browser_navigate: { op: "navigate", args: { url: call.url } },
      browser_read: { op: "read", args: {} },
      browser_click: { op: "click", args: { selector: call.selector, ref: call.ref } },
      browser_type: { op: "type", args: { selector: call.selector, ref: call.ref, text: call.text } },
      browser_press: { op: "press", args: { key: call.key } },
      browser_scroll: { op: "scroll", args: { dy: typeof call.amount === "number" ? call.amount : 600 } },
      browser_console: { op: "console", args: {} },
      browser_screenshot: { op: "screenshot", args: { fullPage: !!call.fullPage, viewpoint: call.viewpoint } },
      browser_find: { op: "find", args: { text: call.text, role: call.role } },
      browser_wait_for: { op: "wait_for", args: { text: call.text, selector: call.selector, time: call.time, timeoutMs: call.timeoutMs } },
      browser_hover: { op: "hover", args: { selector: call.selector, ref: call.ref } },
      browser_select: { op: "select", args: { selector: call.selector, ref: call.ref, value: call.value } },
      browser_tabs: { op: "tabs", args: { tabAction: call.action, url: call.url, index: call.index } },
      browser_network: { op: "network", args: {} },
      browser_evaluate: { op: "evaluate", args: { code: call.code } },
    };
    const mapped = opMap[name];
    if (!mapped) return `error: ${name} is not supported in server runs`;
    const r = await runBrowserOp(
      `run:${runId}`, // session scoped to this run — isolated per execution
      mapped.op,
      mapped.args as never
    );
    if (!r.ok) return `error: ${r.error}`;
    const d = (r.data || {}) as Record<string, unknown>;
    switch (mapped.op) {
      case "navigate":
        return `HTTP ${String(d.status ?? "?")} — now on "${String(d.title || d.url)}" (${String(d.url)}). Use browser_read for content.`;
      case "read":
        return [
          `URL: ${String(d.url)}`, `Title: ${String(d.title)}`, ``, `PAGE TEXT:`, String(d.text || "").slice(0, 6000), ``,
          `HEADINGS:`, (d.headings as string[] || []).join("\n"), ``,
          `INTERACTIVE:`, ((d.interactives as string[]) || []).slice(0, 25).join("\n"),
        ].join("\n");
      case "click":
        return `clicked — page now "${String(d.title || d.url)}". Use browser_read to see the result.`;
      case "type":
        return `typed ${String(d.length ?? 0)} chars into ${String(call.selector || call.ref || "")}`;
      case "press":
        return `key sent: ${String(call.key)}`;
      case "find": {
        const list = ((d.matches as any[]) || []).slice(0, 25).map((m) => `${m.ref}: ${m.role} "${m.name}" [${m.selector}]${m.enabled ? "" : " (disabled)"}`).join("\n");
        return `MATCHES (${((d.matches as any[]) || []).length} of ${String(d.total)}):\n${list || "none"}\n\n${String(d.hint || "")}`;
      }
      case "wait_for":
        return `condition met after ${String(d.waitedMs)}ms — now on "${String(d.title || d.url)}"`;
      case "hover":
        return `hovered ${String(d.hovered)}`;
      case "select":
        return `selected "${String(d.selected)}" in ${String(d.in)}`;
      case "tabs": {
        const tabs = ((d.tabs as any[]) || []).map((t) => `${t.active ? "→" : " "}[${t.index}] ${t.title || "(untitled)"} — ${t.url}`).join("\n");
        return tabs || "no tabs";
      }
      case "network": {
        const events = ((d.events as any[]) || []).map((e) => `${e.status ? `HTTP ${e.status}` : "ABORTED"} ${e.method} ${e.url}${e.error ? ` (${e.error})` : ""}`).join("\n");
        return events || "No failed requests (no 4xx/5xx responses, no aborted requests).";
      }
      case "evaluate":
        return `result: ${String(d.result ?? "undefined")}`;
      case "scroll":
        return `scrolled ${String(d.scrolled)}px`;
      case "console": {
        const msgs = ((d.messages as any[]) || []).map((m: any) => `[${m.type}] ${m.text}`).join("\n");
        return msgs || "No console messages — no JS errors.";
      }
      case "screenshot":
        return `screenshot captured (${String(d.url)}) — saved as run artifact`;
      default:
        return "ok";
    }
  }

  if (name === "run_command" && typeof call.command === "string") {
    const verdict = isCommandAllowed(call.command);
    if (!verdict.allowed) return `refused: ${verdict.reason}`;
    // Approval gate (DB-backed for server runs).
    if (requiresApproval) {
      const decision = await requestUserApproval(runId, `run_command: ${call.command.slice(0, 200)}`, {
        command: call.command,
      });
      if (!decision) return "refused by user";
    }
    try {
      const { execFile } = await import("child_process");
      // Single command string → route through the shell but WITHOUT injecting
      // anything; the exec-guard screened it above.
      const proc = await import("child_process");
      return await new Promise<string>((resolve) => {
        proc.exec(
          call.command as string,
          { cwd: ctx.worktreeDir, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env } },
          (err, stdout, stderr) => {
            if (err && !stdout && !stderr) resolve(`error: ${err.message.slice(0, 300)}`);
            else resolve([stdout, stderr].filter(Boolean).join("\n").slice(0, 8000) || "(no output)");
          }
        );
      });
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  return `error: unknown tool "${name}"`;
}

// ── DB-backed approval gate ───────────────────────────────────────────────

async function requestUserApproval(runId: string, action: string, payload: Record<string, unknown>): Promise<boolean> {
  const request = await prisma.approvalRequest
    .create({
      data: {
        runId,
        action: action.slice(0, 200),
        payload: payload as object,
        status: "pending",
        expiresAt: new Date(Date.now() + APPROVAL_WAIT_TIMEOUT_MS),
      },
    })
    .catch(() => null);
  if (!request) return false; // fail-closed: no DB, no risky action

  await prisma.agentRun.update({ where: { id: runId }, data: { status: "waiting_approval" } }).catch(() => {});
  await emit(runId, "approval-requested", { action });

  const deadline = Date.now() + APPROVAL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
    const row = await prisma.approvalRequest
      .findUnique({ where: { id: request.id }, select: { status: true } })
      .catch(() => null);
    if (row?.status === "approved") {
      await prisma.agentRun.update({ where: { id: runId }, data: { status: "executing" } }).catch(() => {});
      return true;
    }
    if (row?.status === "rejected" || row?.status === "expired") return false;
  }
  return false;
}

// ── The tool loop for one run ─────────────────────────────────────────────

export interface ExecutorResult {
  status: "completed" | "failed";
  summary: string;
  turns: number;
  worktreeId: string | null;
  worktreeDir: string | null;
  branch: string | null;
  /** Provider that actually served the run (failover may differ from config). */
  provider: string;
  /** Token metering when the provider reported usage; null = unknown. */
  tokenUsage: { promptTokens: number; completionTokens: number } | null;
}

export async function executeRun(run: QueuedRun): Promise<ExecutorResult> {
  const adapter = createProviderAdapter(run.modelOverride);
  // Durable resolution: session Map → DB (survives server restarts).
  const workDir = (await resolveWorkspaceCwd(run.userId)) || process.cwd();
  let ctx: WorktreeContext | null = null;
  let transcript: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: run.prompt.slice(0, 100_000) },
  ];
  let turns = 0;
  let summary = "";
  // Scratchpad: claimed runs do real multi-step work, so start seeded. The
  // block is re-rendered fresh into every turn's results message (stale copies
  // compact away harmlessly; the live one is always in the latest message).
  let scratch: ScratchpadState = seedScratchpad(run.prompt);
  // Paths written this run (for the verification lane + artifacts).
  const writtenFiles = new Set<string>();
  // Auto-checkpoint state: pre-write checkpoints with cooldown + per-run cap.
  const autoCp: AutoCheckpointState = newAutoCheckpointState();
  // Token metering (native function-calling turns only; text-protocol turns
  // carry no counts and are reported honestly as unknown).
  const usageTotal = { promptTokens: 0, completionTokens: 0 };
  let usageKnown = false;
  // Failover state lives at function scope: the catch block reports which
  // provider actually served the run before it failed.
  let currentAdapter: AIProviderAdapter = adapter;
  let servedProvider = process.env.AI_PROVIDER || "nvidia";
  // Flips when the provider rejects the function-calling request shape —
  // the rest of the run then uses the text protocol.
  let nativeBroken = false;

  try {
    ctx = await createIsolatedContext(workDir, run.id);
    await emit(run.id, "worktree-created", { dir: ctx.worktreeDir, branch: ctx.branch, isGitRepo: ctx.isGitRepo });

    // Baseline checkpoint: the workspace exactly as the run found it. Best-
    // effort — a checkpoint failure must never fail the run. The worktree's
    // parent (the real workspace) is what gets checkpointed.
    try {
      const { createCheckpoint } = await import("../checkpoints");
      const cp = await createCheckpoint(workDir, run.id, `baseline: ${run.prompt.slice(0, 60)}`, []);
      await prisma.runCheckpoint.create({
        data: { runId: run.id, sequence: cp.n >= 0 ? cp.n : 0, kind: cp.kind, ref: cp.ref, label: cp.label, filesCount: cp.files.length },
      }).catch(() => {});
      await emit(run.id, "checkpoint-created", { sequence: cp.n, kind: cp.kind, label: cp.label });
    } catch { /* checkpointing is best-effort */ }

    // Config-driven tool hooks from the workspace's orplex.config.json.
    const hooks = await loadToolHooks(workDir);

    // MCP tools: merge the user's account connectors with any workspace
    // orplex.config.json mcpServers (workspace wins on name conflicts), cap
    // at MAX_MCP_SERVERS_PER_RUN, and load their tools into the roster.
    let mcpTools: McpToolDef[] = [];
    const mcpRunConfigs: Record<string, McpRunConfig> = {};
    try {
      const mcp = await import("../mcp-client");
      const workspaceCfg = mcp.loadMcpConfig(workDir);
      const accountCfg = await collectMcpServerConfigs(run.userId);
      const merged = { ...accountCfg, ...workspaceCfg };
      const serverNames = Object.keys(merged).slice(0, MAX_MCP_SERVERS_PER_RUN);
      for (const serverName of serverNames) {
        mcpRunConfigs[serverName] = merged[serverName];
      }
      if (Object.keys(mcpRunConfigs).length > 0) {
        ensureMcpReaper();
        for (const serverName of Object.keys(mcpRunConfigs)) {
          try {
            const handle = await getMcpServerForRun(serverName, mcpRunConfigs);
            const tools = await handle.listTools();
            mcpTools = mcpTools.concat(tools);
          } catch (err) {
            await emit(run.id, "mcp-server-error", { server: serverName, error: (err as Error).message.slice(0, 300) }).catch(() => {});
          }
        }
        if (mcpTools.length > 0) {
          await emit(run.id, "mcp-tools-loaded", { count: mcpTools.length, servers: Object.keys(mcpRunConfigs) });
        }
      }
    } catch {}

    // Project memory (orplex.md hierarchy) + user skills: the user-owned
    // context layer, injected ahead of the transcript every turn via
    // buildSystemPrompt.
    const [memoryBlock, skills] = await Promise.all([
      projectMemoryBlock(workDir, "full").catch(() => ""),
      loadUserSkills(workDir).catch(() => []),
    ]);
    const skillRoster = renderSkillRoster(skills);

    // Summarizing compaction for server runs (see compaction.ts): evicted
    // turns become a <context_so_far> block instead of being truncated away.
    // Evicted context is ALSO distilled into workspace memory (compaction-
    // memory.ts) so the next run in this workspace remembers durable facts.
    const { createTranscriptCompactor } = await import("../compaction");
    const { captureFromCompaction } = await import("../compaction-memory");
    const compactor = createTranscriptCompactor(async (prompt) => {
      const adapterText = await currentAdapter.complete([{ role: "user", content: prompt }]);
      void captureFromCompaction({ directoryName: run.workspace, summary: adapterText }).catch(() => 0);
      return adapterText;
    });

    const nativeDefs = buildNativeToolDefs(mcpTools);

    // Failover chain: primary adapter first, then the opt-in chain on
    // rate/quota errors (retries already exhausted inside the adapter).
    const failoverChain = parseFailoverChainEnv();
    let chainIdx = -1;
    // Uptime telemetry: every model call is attributed to the provider that
    // served it (or failed), so the reliability view reflects server runs.
    const callT0 = () => Date.now();
    async function callModel<T>(invoke: (a: AIProviderAdapter) => Promise<T>): Promise<T> {
      for (;;) {
        const t0 = callT0();
        try {
          const out = await invoke(currentAdapter);
          recordProviderEvent({
            userId: run.userId,
            lane: "server_run",
            provider: servedProvider,
            model: run.modelOverride || "(auto)",
            ok: true,
            latencyMs: Date.now() - t0,
          });
          return out;
        } catch (err) {
          recordProviderEvent({
            userId: run.userId,
            lane: "server_run",
            provider: servedProvider,
            model: run.modelOverride || "(auto)",
            ok: false,
            errorMessage: String((err as Error).message),
            latencyMs: Date.now() - t0,
          });
          const next = failoverChain[chainIdx + 1];
          if (!next || !isRateLimitError(err)) throw err;
          chainIdx++;
          const from = servedProvider;
          currentAdapter = createAdapterForProvider(next, run.modelOverride);
          servedProvider = next;
          await emit(run.id, "provider-failover", { from, to: next, reason: String((err as Error).message).slice(0, 200) }).catch(() => {});
        }
      }
    }

    for (turns = 1; turns <= TURN_LIMIT; turns++) {
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "executing" } }).catch(() => {});

      // Compact before the call when the transcript is over budget.
      const transcriptTokens = transcript.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
      const budget = Math.floor(MSG_BUDGET_TOKENS);
      if (transcriptTokens > budget) {
        const compacted = await compactor.compact(transcript, budget).catch(() => null);
        if (compacted) {
          transcript.length = 0;
          transcript.push(...(compacted as Array<{ role: "user" | "assistant"; content: string }>));
          await emit(run.id, "compacted", { turns, tokensBefore: transcriptTokens });
        }
      }

      // Native function-calling when the adapter supports it (kills the whole
      // bare-JSON bug class); text protocol otherwise, with XML parsing and
      // bare-JSON recovery as the fallbacks. A provider that rejects the
      // tools param (400/404 on the request shape) degrades to text mode for
      // the rest of the run instead of failing the run.
      const nativeMode = typeof adapter.completeWithTools === "function" && !nativeBroken;
      const messages = [
        { role: "system", content: buildSystemPrompt(
          mcpTools,
          nativeMode,
          memoryBlock,
          skillRoster,
          Object.keys(mcpRunConfigs).map((serverId) => ({
            name: getMcpCatalogEntry(serverId)?.name ?? serverId,
            description: getMcpCatalogEntry(serverId)?.description ?? "user-connected MCP server",
            toolCount: mcpTools.filter((t) => t.server === serverId).length,
          }))
        ) },
        ...(transcript as Array<{ role: "user" | "assistant"; content: string }>),
      ] as never;
      // Global TPM pacing: one account-wide bucket across ALL runs so two
      // concurrent runs share the 8k/min budget instead of 429-cascading.
      await acquireTokens(estimateTokensOfMessages(messages as never)).catch(() => {});
      let text = "";
      let nativeCalls: NativeToolCall[] = [];
      try {
        if (nativeMode) {
          const r = await callModel((a) => a.completeWithTools!(messages, nativeDefs));
          text = r.text;
          nativeCalls = r.toolCalls;
          if (r.usage) {
            usageTotal.promptTokens += r.usage.promptTokens;
            usageTotal.completionTokens += r.usage.completionTokens;
            usageKnown = true;
            reportUsage(r.usage.promptTokens + r.usage.completionTokens);
            await emit(run.id, "usage", { turn: turns, ...r.usage }).catch(() => {});
          } else {
            usageKnown = false;
          }
        } else {
          text = await callModel((a) => a.complete(messages));
          usageKnown = false; // text protocol carries no token counts
        }
      } catch (err) {
        if (nativeMode && /\b(400|404|422)\b/.test(String((err as Error).message))) {
          nativeBroken = true;
          await emit(run.id, "native-tools-unsupported", { error: String((err as Error).message).slice(0, 200) }).catch(() => {});
          turns--; // retry this turn in text mode (loop's for-increment re-applies it)
          continue;
        }
        throw new Error(`model call failed: ${(err as Error).message}`);
      }
      transcript.push({
        role: "assistant",
        content: text || (nativeCalls.length > 0 ? `[tool calls: ${nativeCalls.map((c) => c.name).join(", ")}]` : ""),
      });

      const calls = nativeCalls.length > 0
        ? nativeCalls.map((c) => ({ name: c.name, ...c.args }))
        : parseToolCalls(text)
            // Bare-JSON recovery: weak OpenAI-compatible models sometimes drop the
            // XML wrapper and emit a tool-call JSON object instead (live-observed:
            // `{"name":"read_file",...}` became the run "summary"). Only tried
            // when XML found nothing, and gated to tool-call-shaped JSON.
            .concat(parseToolCalls(text).length === 0 ? parseBareJsonToolCalls(text) : [])
            .filter((c) => TOOL_WHITELIST.has(String(c.name)) || String(c.name).startsWith("mcp__"));
      if (calls.length === 0) {
        summary = text.slice(0, 20_000);
        break; // plain-text answer = done
      }

      const results: string[] = [];
      for (const call of calls) {
        // use_skill resolves against the discovered skill list before dispatch.
        if (String(call.name) === "use_skill") {
          (call as Record<string, unknown>).__skillBody = skillBody(skills, String((call as Record<string, unknown>).name_of_skill ?? "")) ?? "";
        }
        const out = await executeTool(call as never, ctx, run.autonomyPolicy !== "auto", run.id, writtenFiles, hooks, autoCp, mcpRunConfigs, {
          get: () => scratch,
          update: (section, content) => {
            scratch = updateScratchpadSection(scratch, section, content, turns);
          },
        });
        results.push(`<tool_result name="${String(call.name)}">${out}</tool_result>`);
      }
      const scratchBlock = renderScratchpadBlock(scratch);
      transcript.push({ role: "user", content: results.join("\n") + (scratchBlock ? `\n${scratchBlock}` : "") });
    }

    if (usageKnown) {
      await emit(run.id, "usage-total", { ...usageTotal }).catch(() => {});
    }

    // post-run user hooks (opt-in) — fire after the loop, before verify.
    await runUserHooks(workDir, "post-run", {}).catch(() => {});

    if (!summary) {
      summary = `Turn limit (${TURN_LIMIT}) reached; work is committed on branch ${ctx.branch} for review.`;
    }

    // === Browser verification lane (parity with the client worker) ===
    // UI-shaped work gets rendered and console-checked before the run
    // finishes; console errors drive one repair turn. Runs in the executor
    // process — no browser tab involved. Skipped honestly when node_modules
    // can't be linked into the worktree (modulesReady === false).
    const { looksLikeUiWork, pickDevCommand } = await import("../ui-paths");
    const { join } = await import("path");
    const writtenPaths = [...writtenFiles];

    // Low-spec verify: never `npm install` per worktree (8GB RAM, slow
    // disks). Reuse the workspace's node_modules via an NTFS junction
    // (native, no admin rights); if neither exists, skip verify honestly.
    let modulesReady = false;
    try {
      const wtModules = join(ctx.worktreeDir, "node_modules");
      const wsModules = join(ctx.rootDir, "node_modules");
      const { stat: stWt, symlink: sym } = await import("fs/promises");
      const wtExists = await stWt(wtModules).then(() => true).catch(() => false);
      const wsExists = await stWt(wsModules).then(() => true).catch(() => false);
      if (wtExists) {
        modulesReady = true;
      } else if (wsExists) {
        // 'junction' needs no privileges on Windows; on POSIX it creates a
        // directory symlink, which is fine for dev servers.
        await sym(wsModules, wtModules, "junction").catch(() => {});
        modulesReady = await stWt(wtModules).then(() => true).catch(() => false);
      }
    } catch {}

    if (
      writtenPaths.length > 0 &&
      looksLikeUiWork(writtenPaths) &&
      ctx.isGitRepo &&
      modulesReady &&
      !isMemoryPressureHigh()
    ) {
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "verifying" } }).catch(() => {});
      const { verifyUI } = await import("@/lib/browser-verification");
      const { readFile: rf, stat: st } = await import("fs/promises");
      const pkgRaw = await rf(join(ctx.worktreeDir, "package.json"), "utf8").catch(() => null);
      const hasIndex = await st(join(ctx.worktreeDir, "index.html")).then(() => true).catch(() => false);
      // Global verify slot: at most ONE verify dev server exists machine-wide
      // (+0.5-1 GB each — two concurrent boots would blow the 8 GB budget),
      // with a per-run port as defense-in-depth for any stray second slot.
      const verifyPort = verifyPortForRun(run.id);
      const wtDir: string = ctx.worktreeDir; // narrowed here; closures lose it
      const verifyResult = (await withVerifySlot(() =>
        verifyUI({
          workDir: wtDir,
          devCommand: pickDevCommand(pkgRaw, hasIndex, verifyPort),
          port: verifyPort,
          path: "/",
          recordVideo: false,
        }).catch(() => null),
      )) as VerifyResult | null;

      const consoleErrors: string[] = Array.isArray(verifyResult?.consoleErrors)
        ? verifyResult.consoleErrors
        : [];

      // Evidence preservation: the worktree is deleted after merge/discard,
      // so any frame/screenshot paths inside it are copied to a durable
      // location under the user's workspace first, and the walkthrough's
      // frame paths are rewritten to the durable copies.
      const preserveEvidence = async (): Promise<{ dir: string; map: Map<string, string> } | null> => {
        try {
          const ws = (await resolveWorkspaceCwd(run.userId)) || getWorkspaceCwdForUser(run.userId);
          if (!ws) return null;
          const fs = await import("fs/promises");
          const path = await import("path");
          const evDir = path.join(ws, ".orplex", "verify-evidence", run.id.slice(0, 12));
          await fs.mkdir(evDir, { recursive: true });
          const map = new Map<string, string>();
          const sources = new Set<string>();
          for (const a of verifyResult?.artifacts ?? []) {
            if (a.mediaType === "image/png" || a.mediaType === "video/webm") sources.add(a.content);
          }
          for (const step of verifyResult?.timeline ?? []) {
            if (step.screenshotPath) sources.add(step.screenshotPath);
          }
          let idx = 0;
          for (const src of sources) {
            if (!src || !ctx || !src.startsWith(ctx.worktreeDir)) continue; // only copy evidence inside the worktree
            const dest = path.join(evDir, `frame-${String(idx++).padStart(2, "0")}-${path.basename(src)}`);
            await fs.copyFile(src, dest).catch(() => {});
            map.set(src, dest);
          }
          return { dir: evDir, map };
        } catch {
          return null;
        }
      };
      const evidence = await preserveEvidence();
      const mapFrame = (p: string): string | null => evidence?.map.get(p) ?? null;

      // Build the walkthrough from the verify session's timeline, with frame
      // paths rewritten to durable copies. Even a failed session records
      // what happened up to the failure — that's the part worth replaying.
      try {
        const { buildWalkthrough, rewriteFramePaths } = await import("@/lib/walkthrough");
        let wt = buildWalkthrough({
          timeline: verifyResult?.timeline ?? [],
          success: !!verifyResult?.success,
          url: null as unknown as string | undefined,
          durationMs: verifyResult?.durationMs ?? 0,
          consoleErrors,
          consoleWarnings: Array.isArray(verifyResult?.consoleWarnings) ? verifyResult.consoleWarnings : [],
        });
        wt = rewriteFramePaths(wt, mapFrame);
        await artifact(
          run.id,
          "walkthrough",
          "Browser verification walkthrough",
          JSON.stringify(wt),
          "application/json"
        );
      } catch {}

      await artifact(
        run.id,
        "timeline",
        "Browser verification",
        JSON.stringify({
          success: !!verifyResult?.success,
          consoleErrors: consoleErrors.slice(0, 10),
          durationMs: verifyResult?.durationMs ?? null,
        }, null, 2),
        "application/json"
      );

      if (!verifyResult?.success && consoleErrors.length > 0) {
        // One repair turn: hand the errors back to the model with the same
        // directive shape the client worker uses.
        const { browserRepairDirective } = await import("@/lib/master-prompt");
        const reasons = consoleErrors.slice(0, 8).join("\n").slice(0, 1200);
        transcript.push({
          role: "user",
          content: `${browserRepairDirective(reasons)}\n
(Files you wrote this run: ${writtenPaths.join(", ").slice(0, 2000)}. Fix and rewrite them with write_file.)`,
        });
        const repairText = await currentAdapter.complete(transcript as never).catch(() => "");
        const repairCalls = parseToolCalls(repairText).filter((c) => String(c.name) === "write_file");
        const repairResults: string[] = [];
        for (const call of repairCalls) {
          const out = await executeTool(call as never, ctx, run.autonomyPolicy !== "auto", run.id, writtenFiles, hooks, autoCp, mcpRunConfigs);
          repairResults.push(`<tool_result name="${String(call.name)}">${out}</tool_result>`);
        }
        if (repairCalls.length > 0) {
          transcript.push({ role: "user", content: repairResults.join("\n") });
          await emit(run.id, "verify-repaired", { fixes: repairCalls.length });
          summary += `\n\nBrowser verification failed and was repaired (${repairCalls.length} file fix(es)).`;
        } else {
          summary += `\n\nBrowser verification failed (console errors) — see the verification artifact for review.`;
        }
      } else if (verifyResult?.success) {
        summary += `\n\nBrowser verification passed (rendered without console errors).`;
      }

      // Post-verify checkpoint: the verified (or repaired) state of the
      // worktree — the natural restore point. Best-effort, serial lane.
      if (writtenPaths.length > 0 && ctx.isGitRepo) {
        try {
          const { createCheckpoint } = await import("../checkpoints");
          const cp = await createCheckpoint(ctx.worktreeDir, run.id, `verified: ${writtenPaths.length} file(s)`, []);
          await prisma.runCheckpoint.create({
            data: { runId: run.id, sequence: cp.n >= 0 ? cp.n : 0, kind: cp.kind, ref: cp.ref, label: cp.label, filesCount: cp.files.length },
          }).catch(() => {});
          await emit(run.id, "checkpoint-created", { sequence: cp.n, kind: cp.kind, label: cp.label });
        } catch { /* best-effort */ }
      }
    }

    const sha = await ctx.commit(`Orplex agent run ${run.id}`).catch(() => null);
    const changed = await ctx.diffFiles();
    await artifact(run.id, "report", "Run summary", summary, "text/markdown");
    if (changed.length) {
      await artifact(run.id, "diff", "Changed files", changed.join("\n"), "text/plain");
      // Reviewable unified patch for the mission-control drawer.
      const patch = await ctx.patchText().catch(() => "");
      if (patch) {
        await artifact(run.id, "patch", "Branch patch", patch, "text/x-diff");
      }
    }

    // Morning-PR-queue finishing: push the branch and surface a review link.
    // Both steps are best-effort — a run with no remote still completes with
    // its branch locally, and a failed push never fails the run. Opt-in via
    // ORPLEX_PUSH_BRANCH=1 so a repo with no remote never sees failed pushes.
    if (process.env.ORPLEX_PUSH_BRANCH === "1" && ctx.isGitRepo && ctx.branch) {
      const push = await ctx.pushBranch();
      await emit(run.id, "branch-pushed", push.pushed ? { ref: push.ref } : { error: push.error });
      if (push.pushed) {
        const pr = await ctx.prLink();
        if (pr.url) {
          await emit(run.id, "pr-opened", { via: pr.via, url: pr.url });
        }
      }
    }

    await emit(run.id, "run-finished", { turns, changedFiles: changed.length, sha, provider: servedProvider });

    return {
      status: "completed",
      summary,
      turns,
      worktreeId: ctx.id,
      worktreeDir: ctx.worktreeDir,
      branch: ctx.branch || null,
      provider: servedProvider,
      tokenUsage: usageKnown ? { ...usageTotal } : null,
    };
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000);
    summary = summary || `Run failed: ${message}`;
    await artifact(run.id, "log", "Failure log", summary, "text/plain");
    await emit(run.id, "run-failed", { error: message });
    // on-fail user hooks (opt-in) — best-effort, never mask the failure.
    await runUserHooks(workDir, "on-fail", {}).catch(() => {});
    return {
      status: "failed",
      summary,
      turns,
      worktreeId: ctx?.id ?? null,
      worktreeDir: ctx?.worktreeDir ?? null,
      branch: ctx?.branch ?? null,
      provider: servedProvider,
      tokenUsage: usageKnown ? { ...usageTotal } : null,
    };
  } finally {
    // Keep the worktree for review when the run produced a branch; otherwise
    // clean up immediately.
    if (ctx && !ctx.branch) await ctx.cleanup().catch(() => {});
  }
}

// ── The persistent loop ───────────────────────────────────────────────────

let running = false;

/** Runs in flight — the concurrency window lives here, not in a queue. */
const inFlight = new Set<Promise<void>>();

export function startServerExecutor(): void {
  if (running) return;
  running = true;
  // Cross-bundle status singleton (dev-mode bundles would otherwise hide
  // module-level state from the /api/admin/system route).
  const st = runtimeState.executor;
  st.running = true;
  st.startedAt = new Date().toISOString();
  recordRuntimeLog("executor", "info", "executor started");
  void (async () => {
    await requeueOrphanedRuns();
    await loop();
  })();
}

export function isServerExecutorRunning(): boolean {
  return running;
}

/** Process-lifetime stats for the admin System page (from the shared state). */
export function getExecutorStatus() {
  return { ...runtimeState.executor, inFlight: inFlight.size };
}

/**
 * Startup recovery for runs orphaned by a crash/restart. The executor is
 * single-instance, so at startup ANY run still in a live status was being
 * processed by a process that no longer exists — no timestamps needed.
 * The run is requeued, not resumed mid-transcript (honest scope: the agent
 * re-plans from the original prompt). 3 requeues and it fails honestly.
 */
export async function requeueOrphanedRuns(): Promise<number> {
  const MAX_REQUEUES = 3;
  try {
    const stuck = await prisma.agentRun.findMany({
      where: { executionTarget: "server", status: { in: ["executing", "verifying", "waiting_approval"] } },
      select: { id: true, retries: true },
    });
    let requeued = 0;
    for (const r of stuck) {
      if (r.retries >= MAX_REQUEUES) {
        await prisma.agentRun
          .update({
            where: { id: r.id },
            data: {
              status: "failed",
              result: { summary: `Failed after ${r.retries} executor restarts — repeatedly interrupted mid-run.` },
              completedAt: new Date(),
            },
          })
          .catch(() => {});
        await emit(r.id, "run-failed", { error: `exceeded ${MAX_REQUEUES} restart requeues` }).catch(() => {});
        continue;
      }
      await prisma.agentRun
        .update({ where: { id: r.id }, data: { status: "pending", retries: { increment: 1 } } })
        .catch(() => {});
      await emit(r.id, "requeued-after-restart", { requeue: r.retries + 1 }).catch(() => {});
      requeued++;
    }
    if (requeued > 0) {
      console.log(`[executor] requeued ${requeued} orphaned run(s) from a previous process`);
      recordRuntimeLog("executor", "warn", `requeued ${requeued} orphaned run(s) from a previous process`);
    }
    return requeued;
  } catch {
    return 0;
  }
}

async function loop(): Promise<void> {
  while (running) {
    try {
      runtimeState.executor.lastPollAt = new Date().toISOString();
      // RAM admission control: under high/critical memory pressure the
      // executor stops claiming NEW runs (in-flight runs continue; queued
      // runs stay queued). Nothing is lost — the poll resumes when the
      // watchdog reports recovery.
      if (isClaimsPaused() || inFlight.size >= maxConcurrentRuns(process.env.ORPLEX_MAX_CONCURRENT_RUNS)) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const run = await leaseOneRun();
      if (!run) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      runtimeState.executor.claimed++;
      recordRuntimeLog("executor", "info", `claimed run ${run.id.slice(-6)}`);
      await emit(run.id, "claimed", { by: "server-executor" });
      const p = executeRun(run)
        .then(async (result) => {
          if (result.status === "completed") {
            runtimeState.executor.completed++;
            recordRuntimeLog("executor", "info", `run ${run.id.slice(-6)} completed (turns: ${result.turns ?? "?"})`);
          } else {
            runtimeState.executor.failed++;
            recordRuntimeLog("executor", "warn", `run ${run.id.slice(-6)} ended as ${result.status}`);
          }
          await prisma.agentRun
            .update({
              where: { id: run.id },
              data: {
                status: result.status,
                result: {
                  summary: result.summary,
                  turns: result.turns,
                  branch: result.branch,
                  // Which provider actually served it (failover-aware).
                  provider: result.provider,
                  // Metering (null when the provider reported no usage).
                  tokenUsage: result.tokenUsage,
                  // The merge/discard route removes this directory after review.
                  worktreeDir: result.worktreeDir,
                },
                ...(result.status === "completed"
                  ? { tokenUsage: (result.tokenUsage?.promptTokens ?? 0) + (result.tokenUsage?.completionTokens ?? 0) }
                  : {}),
                completedAt: new Date(),
              },
            })
            .catch(() => {});
        })
        .catch(() => {
          runtimeState.executor.failed++;
          recordRuntimeLog("executor", "error", `run ${run.id.slice(-6)} threw unexpectedly`);
        })
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
