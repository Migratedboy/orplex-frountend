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
import {
  createLoopStreaks,
  trackToolTurn,
  buildLoopBreakDirective,
} from "@/lib/agent/contract";
import { validateToolArgs } from "@/lib/agent/contract/tools";
import { isCommandAllowed } from "@/lib/exec-guard";
import { createProviderAdapter, createAdapterForProvider, adapterModelId, type AIProviderAdapter, type NativeToolDef, type NativeToolCall } from "@/lib/ai-providers";
import { resolveRunCredential } from "@/lib/byok-credentials";
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
import { projectMemoryBlock } from "@/lib/memory";
import { loadUserSkills, renderSkillRoster, skillBody } from "@/lib/user-skills";
import { recordRuntimeLog } from "@/lib/runtime-log";
import { runtimeState } from "@/lib/runtime-state";
import { maxConcurrentRuns, parseFailoverChain } from "./executor-config";
import { getMcpServerForRun, ensureMcpReaper, parseMcpToolName, type McpToolDef, type McpServerConfig as McpRunConfig } from "../mcp-client";
import { buildMcpRoster, executeMcpMetaTool, mcpPromptSection, type BuilderTool } from "@/lib/mcp/tool-builder";
import { collectMcpServerConfigs, MAX_MCP_SERVERS_PER_RUN } from "../mcp-accounts";
import { getMcpCatalogEntry } from "../mcp-catalog";
import { mcpUsageBlock, mcpServerSummaries } from "../mcp-prompt";
import { resolveMcpLane } from "@/lib/mcp/gate";
import { hubCallTool, McpHubError } from "@/lib/mcp/hub";
import { listSnapshotToolsByServer } from "@/lib/mcp/tool-snapshot";
import { refreshMissingSnapshots as refreshMissingMcpSnapshots } from "@/lib/mcp/roster-refresh";
import { assessMcpToolRiskDb } from "@/lib/mcp/risk-db";
import { grepSearch, codeSearch } from "@/lib/grep-search";
import {
  createScratchpad,
  seedScratchpad,
  update_scratchpad as updateScratchpadSection,
  renderScratchpadBlock,
  type ScratchpadState,
  type ScratchpadSection,
  // Reached through the barrel, not the raw module: memory.ts is the single
  // documented entry point for every memory write.
} from "@/lib/memory";
import type { VerifyResult } from "@/lib/browser-verification";
import { loadToolHooks, evaluateDenyRules, matchesNotifyRules, type CompiledHooks } from "@/lib/tool-hooks";
import { runUserHooks } from "@/lib/user-hooks";
import { recordProviderEvent } from "@/lib/provider-uptime";
import { acquireTokens, estimateTokensOfMessages, reportUsage } from "@/lib/tpm-pacer";
import { createIsolatedContext, type WorktreeContext } from "./worktree";
import type { RuntimeArtifact } from "@/lib/agent/runtime/types";

const POLL_INTERVAL_MS = 4000;
const TURN_LIMIT = 60;
// Transcript budget for compaction, used ONLY when a model's real context
// window is unknown.
//
// This used to be a fixed 3100 tokens (an 8k Groq free-tier artifact: 8000
// minus prompt/tool/scratchpad overhead). Applied unconditionally it summarized
// away the context of a 200k-context paid model roughly every two turns —
// and each compaction is an extra BILLED model call, so the paid lane both
// lost the most context and paid the most per turn. The budget is now derived
// from the resolved model's context window (see resolveTranscriptBudget).
const FALLBACK_TRANSCRIPT_BUDGET_TOKENS = 3100;
const APPROVAL_WAIT_TIMEOUT_MS = 10 * 60_000;
const APPROVAL_POLL_MS = 2000;
const TOOL_WHITELIST = new Set([
  "write_file",
  "edit_file",
  "read_file",
  "list_files",
  "search_code",
  "code_search",
  "run_command",
  // Browser-as-sensor: navigate/read/click/type/console/screenshot plus the
  // advanced ops (find/wait/hover/select/tabs/network/evaluate) — the run
  // adapts mid-task from what the page shows (SSRF-guarded session below).
  "browser_navigate",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_press",
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
  // Playbook + MCP discovery verbs: advertised in buildNativeToolDefs and
  // the text prompt, so the text-protocol fallback must not drop them (a
  // fully-filtered turn ends the run having executed nothing).
  "playbook_search",
  "skill_create",
  "session_search",
  "mcp_call",
  "mcp_search_tools",
  "mcp_describe_tool",
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

/**
 * Transcript budget for compaction, sized to the model that will serve the
 * run rather than to a fixed free-tier constant.
 *
 * A 200k-context model must not have its history summarized away every couple
 * of turns — and because compaction is itself a model call, the paid lane was
 * paying for those summaries too. Small/free models keep the conservative
 * fallback, which is exactly the case that number was derived from.
 */
function resolveTranscriptBudget(adapter: AIProviderAdapter): number {
  const id = adapterModelId(adapter);
  const known = id !== "(auto)" ? KNOWN_CONTEXT_WINDOWS.find(([re]) => re.test(id))?.[1] : undefined;
  if (!known) return FALLBACK_TRANSCRIPT_BUDGET_TOKENS;
  // Leave generous headroom: the live transcript is only part of the window
  // (system prompt, tool schemas and the scratchpad consume the rest).
  return Math.max(FALLBACK_TRANSCRIPT_BUDGET_TOKENS, Math.floor(known * 0.5));
}

/**
 * Context windows for families the executor runs on. Deliberately keyed by
 * SUBSTRING rather than exact id: these arrive namespaced (`openai/gpt-4o`,
 * `qwen/…:free`) and an exact map would silently miss every one of them.
 */
const KNOWN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/(^|\/)(o1|o3|o4|gpt-5)/i, 200_000],
  [/gpt-oss/i, 131_072],
  [/gpt-4o|gpt-4\.1/i, 128_000],
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
  [/llama|qwen|mistral|mixtral|deepseek|command/i, 131_072],
  [/nemotron/i, 131_072],
];

/** Lane adapter: legacy in-run defs → the shared builder's input (C5). */
function toBuilderTool(t: McpToolDef): BuilderTool {
  return { server: t.server, name: t.name, description: t.description, inputSchema: t.inputSchema };
}

export function buildNativeToolDefs(mcpTools: McpToolDef[], remoteTools: BuilderTool[] = []): NativeToolDef[] {
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
    { name: "playbook_search", description: "Search the playbook — evidence-backed learnings from previous verified runs. Use when starting work that may resemble past work.", parameters: obj({ query: { type: "string", description: "What you are trying to do" } }, ["query"]) },
    { name: "skill_create", description: "Save a reusable skill to the playbook so future runs benefit. Use when you discover a procedure worth repeating.", parameters: obj({ title: { type: "string", description: "Short skill name" }, text: { type: "string", description: "The reusable procedure, self-contained" } }, ["title", "text"]) },
    { name: "session_search", description: "Search past conversation messages. Use when the user refers to something discussed before.", parameters: obj({ query: { type: "string", description: "What to search past messages for" } }, ["query"]) },
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
    // Universal MCP caller — available on every provider the executor calls,
    // so MCP works even when the provider is a lean/TPM-constrained one or an
    // unknown BYOK endpoint that doesn't get per-tool MCP defs in its array.
    // The model learns the server id + tool name from the system-prompt MCP
    // section and from mcp_search_tools / mcp_describe_tool (added below).
    { name: "mcp_call", description: "Call a tool on a connected MCP server by name. Use mcp_search_tools to list connected servers and their tools, and mcp_describe_tool to get an exact parameter schema. serverId is the MCP server id (e.g. \"supabase\", \"linear\"); tool is the server's tool name (e.g. \"list_tables\", \"create_issue\"); arguments is the tool's parameter object. Results arrive as text. Never invent server ids or tool names.", parameters: obj({ serverId: { type: "string", description: "MCP server id from MCP connectors" }, tool: { type: "string", description: "Tool name on that server" }, arguments: { type: "object", description: "Tool parameter object ({} if none)" } }, ["serverId", "tool"]) },
  ];
  // Shared builder (C5): full schemas under the cap; over it, names-only for
  // every tool plus the search/describe meta tools — never a silent drop (C10).
  // remoteTools = SDK-lane OAuth connectors from the Phase 5 snapshot (P8).
  const mcpRoster = buildMcpRoster([...mcpTools.map(toBuilderTool), ...remoteTools]);
  for (const d of mcpRoster.defs) defs.push(d);
  for (const d of mcpRoster.metaDefs) defs.push(d);
  return defs;
}

// ── Failover chain (opt-in, executor only) ───────────────────────────────────────
// AI_FAILOVER="groq,openrouter" — tried in order after the configured primary
// when it fails with a rate/quota error. Filtering (primary, unknown,
// keyless) lives in executor-config.ts where it is unit-testable.

function parseFailoverChainEnv(): string[] {
  return parseFailoverChain(process.env.AI_FAILOVER, process.env.AI_PROVIDER || "nvidia", process.env);
}

function buildSystemPrompt(mcpTools: McpToolDef[], nativeMode: boolean, memoryBlock = "", skillRoster = "", playbookBlock = "", mcpServers?: Array<{ name: string; description: string; toolCount: number }>, remoteTools: BuilderTool[] = []): string {
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
    `- playbook_search { "name": "playbook_search", "query": "..." } (learnings from past verified runs — check before starting)`,
    `- skill_create { "name": "skill_create", "title": "...", "text": "..." } (save a reusable procedure for future runs)`,
    `- session_search { "name": "session_search", "query": "..." } (search past conversation messages)`,
    `- scratchpad_update { "name": "scratchpad_update", "section": "plan|hypotheses|findings|next", "content": "..." } (private working memory, re-shown every turn — record plan, findings, next move; never store secrets)`,
    `Keep a private scratchpad via scratchpad_update as you learn — todo discipline still applies; the scratchpad holds reasoning, not checkmarks.`,
  ];
  if (skillRoster) {
    lines.push(``, `Skills available (call use_skill { "name": "use_skill", "name_of_skill": "<name>" } to load the full instructions):`, skillRoster);
  }
  if (memoryBlock) {
    lines.push(``, `Project memory (user-authored conventions from orplex.md — follow these):`, memoryBlock);
  }
  if (playbookBlock) {
    lines.push(``, `Playbook (learnings from previous verified runs — apply when relevant, ignore otherwise):`, playbookBlock);
  }
  if (mcpTools.length > 0 || remoteTools.length > 0) {
    const roster = buildMcpRoster([...mcpTools.map(toBuilderTool), ...remoteTools]);
    lines.push(``, mcpPromptSection(roster));
    if (mcpServers && mcpServers.length > 0) {
      lines.push(``, `Connected MCP services:`, mcpServerSummaries(mcpServers));
    }
    lines.push(``, mcpUsageBlock(roster.toolCount));
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

/**
 * read_file returns at most this many chars. Uncapped, a single read of a large
 * log (the exact case the paged branch below exists for) materializes the whole
 * file into the transcript and then into a request body — enough to OOM the
 * executor on the target box. Matches the cap the browser lane already applies.
 */
const MAX_READ_CHARS = 200_000;

/** Append an explicit marker so the model never reasons from a silent cut. */
function truncateWithNotice(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated — showing first ${limit.toLocaleString()} of ${text.length.toLocaleString()} chars${label ? ` (${label})` : ""}. Re-read with offset/limit for the rest.]`;
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
      // Truncation is marked, not silent: a 300k unified diff cut mid-hunk
      // leaves the Manager review drawer showing a patch that simply ends,
      // with no indication anything is missing.
      data: {
        runId,
        kind,
        name,
        mediaType,
        content: truncateWithNotice(content, 200_000, kind),
        ...(taskId ? { taskId } : {}),
      },
    });
  } catch {}
}

// ── Tool execution inside the worktree ────────────────────────────────────

async function readLocalFile(root: string, rel: string): Promise<string> {
  const { readFile, stat } = await import("fs/promises");
  const { resolve, sep, isAbsolute } = await import("path");
  const p = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const rootR = resolve(root);
  if (p !== rootR && !p.startsWith(rootR + sep)) throw new Error("path escapes workspace");
  // Cap BEFORE reading: the file may be far larger than the cap, and reading it
  // whole is what takes the process down.
  try {
    const st = await stat(p);
    if (st.size > MAX_READ_CHARS) {
      const { open } = await import("fs/promises");
      const handle = await open(p, "r");
      try {
        const buf = Buffer.alloc(MAX_READ_CHARS);
        const { bytesRead } = await handle.read(buf, 0, MAX_READ_CHARS, 0);
        return truncateWithNotice(buf.subarray(0, bytesRead).toString("utf8"), MAX_READ_CHARS, rel);
      } finally {
        await handle.close();
      }
    }
  } catch {
    // stat/open failed — fall through to a plain read and let its error surface.
  }
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

let serverHooksReady = false;

/** Idempotent activation of the server-safe plugin subset (secret-scanner). */
async function ensureServerHooks(): Promise<void> {
  if (serverHooksReady) return;
  serverHooksReady = true;
  try {
    const { activateSecretScanner } = await import("../plugins/builtin/secret-scanner-plugin");
    const { pluginRegistry } = await import("../plugins/registry");
    // Two-step like the production initializer: registration alone does NOT
    // wire hooks — the activate closure runs only via activatePlugin.
    await activateSecretScanner();
    await pluginRegistry.activatePlugin("secret-scanner");
  } catch {
    serverHooksReady = false;
  }
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
  mcpTools?: McpToolDef[],
  scratchpad?: {
    get(): ScratchpadState;
    update(section: ScratchpadSection, content: string): void;
  },
  mcpExtras?: {
    /** Session user for the SDK lane (C6 DB risk lookup + hub dispatch). */
    userId?: string;
    /** Phase 5 snapshot roster for OAuth connectors (meta tools + dispatch). */
    remoteTools?: BuilderTool[];
  }
): Promise<string> {
  const name = call.name;

  // Shared contract gate: malformed core-tool calls fail fast with a precise
  // error instead of falling through to "unknown tool". (Browser/MCP lanes
  // validate through their own contract paths below.)
  const argError = validateToolArgs(name, call as unknown as Record<string, unknown>);
  if (argError) return `error: ${argError}`;

  // Plugin beforeToolCall hooks, server lane. Only the secret-scanner is
  // activated here (see ensureServerHooks below) — it is pure, stateless,
  // and closes the one gap the executor's native guards don't cover
  // (hardcoded secrets into merged branches). Deliberately NOT the full
  // bundle: response-cache would serve stale results, git-auto-commit would
  // pollute review branches, task-queue conflicts with server pacing, and
  // input-sanitizer/path-traversal are subsumed by isCommandAllowed plus the
  // executor's own resolve-based worktree containment.
  try {
    await ensureServerHooks();
    const { beforeToolCall } = await import("../plugins/registry");
    const gated = await beforeToolCall(name, call as Record<string, unknown>);
    if ((gated as { _blocked?: boolean })._blocked) {
      return "refused by secret policy: file content appears to contain a hardcoded secret — use environment variables instead.";
    }
  } catch {
    // Hook infrastructure must never break tool dispatch; a hook failure
    // fails open here (the write still runs through all native guards).
  }

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

  // ── over-cap meta tools (C10) — read-only discovery against this run's roster ──
  if (name === "mcp_search_tools" || name === "mcp_describe_tool") {
    return executeMcpMetaTool(
      name,
      call,
      [...(mcpTools ?? []).map(toBuilderTool), ...(mcpExtras?.remoteTools ?? [])]
    );
  }

  // ── MCP tools (mcp__<server>__<tool>) — risk gate, then the right lane ──
  if (name.startsWith("mcp__")) {
    const parsed = parseMcpToolName(name);
    if (!parsed) return `error: malformed MCP tool name "${name.slice(0, 80)}"`;

    // C6 (server lane): DB-backed risk tier — snapshot annotations + the
    // Prisma autoApproveReadOnly toggle. Approval parks the run (the same
    // DB request flow run_command uses).
    if (mcpExtras?.userId) {
      const risk = await assessMcpToolRiskDb(mcpExtras.userId, name);
      if (!risk.autoApprovable) {
        const approved = await requestUserApproval(runId, `MCP tool ${name} — ${risk.reason}`, {
          tool: name,
          riskLevel: risk.level,
        });
        if (!approved) return `rejected by user`;
      }
    }

    if (mcpRunConfigs && mcpRunConfigs[parsed.server]) {
      try {
        const handle = await getMcpServerForRun(parsed.server, mcpRunConfigs, mcpExtras?.userId ?? "unknown");
        return await handle.callTool(parsed.tool, call as Record<string, unknown>);
      } catch (err) {
        return `error: ${(err as Error).message.slice(0, 500)}`;
      }
    }

    // SDK lane (Phase 8, default): remote OAuth connector through the hub.
    if (mcpExtras?.userId && resolveMcpLane(process.env.ORPLEX_MCP) === "sdk") {
      try {
        const { name: _name, ...args } = call;
        const out = await hubCallTool(mcpExtras.userId, parsed.server, parsed.tool, args);
        return out.isError ? `error: ${out.text.slice(0, 2000)}` : out.text;
      } catch (err) {
        const msg = (err as Error).message.slice(0, 500);
        const hint = err instanceof McpHubError && err.code === "needs_reauth"
          ? " — the OAuth session expired; reconnect it in Connectors"
          : "";
        return `error: ${msg}${hint}`;
      }
    }        return `error: no MCP server "${parsed.server}" is connected for this run — the user can add connectors in Settings → Connectors`;
      }

    // ── Universal MCP caller (mcp_call) — mirrors the client-side handler. ───
    // A lean/unknown provider the executor calls may not have the server's
    // per-tool MCP definitions in its function-calling array, but it can still
    // emit mcp_call with the server id + tool name + args learned from the
    // system-prompt MCP section. This constructs the mcp__ name and runs the
    // same risk gate + lane dispatch as a direct mcp__ call.
    if (name === "mcp_call") {
      const serverId = (call as Record<string, unknown>).serverId as string | undefined;
      const tool = (call as Record<string, unknown>).tool as string | undefined;
      const args = (call as Record<string, unknown>).arguments as Record<string, unknown> ?? {};
      if (!serverId || !tool) {
        return `error: mcp_call requires serverId and tool (e.g. mcp_call({serverId: \"supabase\", tool: \"list_tables\", arguments: {}})). Use mcp_search_tools to list connected servers and their tools.`;
      }
      const mcpName = `mcp__${serverId}__${tool}`;
      const parsed = parseMcpToolName(mcpName);
      if (!parsed) return `error: malformed mcp_call target "${mcpName.slice(0, 80)}"`;

      if (mcpExtras?.userId) {
        const risk = await assessMcpToolRiskDb(mcpExtras.userId, mcpName);
        if (!risk.autoApprovable) {
          const approved = await requestUserApproval(
            runId,
            `MCP tool ${mcpName} — ${risk.reason}`,
            { tool: mcpName, riskLevel: risk.level },
          );
          if (!approved) return `rejected by user`;
        }
      }

      if (mcpRunConfigs && mcpRunConfigs[parsed.server]) {
        try {
          const handle = await getMcpServerForRun(parsed.server, mcpRunConfigs, mcpExtras?.userId ?? "unknown");
          return await handle.callTool(parsed.tool, args);
        } catch (err) {
          return `error: ${(err as Error).message.slice(0, 500)}`;
        }
      }

      if (mcpExtras?.userId && resolveMcpLane(process.env.ORPLEX_MCP) === "sdk") {
        try {
          const out = await hubCallTool(mcpExtras.userId, parsed.server, parsed.tool, args);
          return out.isError ? `error: ${out.text.slice(0, 2000)}` : out.text;
        } catch (err) {
          const msg = (err as Error).message.slice(0, 500);
          const hint = err instanceof McpHubError && err.code === "needs_reauth"
            ? " — the OAuth session expired; reconnect it in Connectors"
            : "";
          return `error: ${msg}${hint}`;
        }
      }

      return `error: no MCP server "${parsed.server}" is connected for this run — the user can add connectors in Settings → Connectors`;
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
const kept = content.slice(0, 2000);
        scratchpad.update(section as ScratchpadSection, kept);
        // Report what was ACTUALLY kept. Claiming the full length while storing
        // a 2000-char prefix meant the model believed it had banked findings
        // that were then re-rendered out of existence every turn — and it
        // reasoned from them in the meantime.
        return kept.length < content.length
          ? `recorded ${section} (${kept.length} of ${content.length} chars — only the first ${kept.length} are kept). Shorten it to keep it all.`
          : `recorded ${section} (${kept.length} chars). It will be re-shown every turn.`;
  }

  // playbook_search — derived view over playbooks + workspace learnings.
  // The playbook is NOT a parallel memory store: patterns derived from runs
  // land in the workspace-learnings bucket (remember()), and search reads
  // both so nothing learned is invisible to this tool. Learnings are keyed
  // by workspace (machine:folder, same key the capture route writes), resolved
  // from the run row — never the auth id.
  if (name === "playbook_search" && typeof call.query === "string") {
    try {
      const userId = mcpExtras?.userId || "default";
      const { searchPlaybooks } = await import("../playbook");
      const hits = await searchPlaybooks(userId, call.query.slice(0, 500), 5);
      const lines = hits.map((h) => `- [${h.pattern}] ${h.content} (confidence: ${Math.round(h.confidence * 100)}%)`);
      // Derived-view half: workspace learnings for the same query. Bounded
      // (retrieval embeds locally; never stall the tool loop on a cold model).
      try {
        const { getWorkspaceKey } = await import("../run-ledger");
        const runRow = await prisma.agentRun.findUnique({ where: { id: runId }, select: { workspace: true } }).catch(() => null);
        const workspaceKey = getWorkspaceKey(runRow?.workspace || "");
        const { retrieveWorkspaceMemories } = await import("../workspace-memory");
        const mems = await Promise.race([
          retrieveWorkspaceMemories(workspaceKey, call.query.slice(0, 500), 3).catch(() => []),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("learnings timeout")), 15_000)),
        ]).catch(() => []);
        for (const m of (mems as Array<{ content: string }>).slice(0, 3)) lines.push(`- [learning] ${m.content}`);
      } catch {
        /* learnings unavailable — playbook hits still stand */
      }
      if (lines.length === 0) return "No matching playbook entries found.";
      return lines.join("\n");
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (name === "skill_create") {
    try {
      const title = typeof call.title === "string" ? call.title.slice(0, 100) : "";
      const text = (typeof call.text === "string" ? call.text : typeof call.content === "string" ? call.content : "").slice(0, 2000);
      if (!title || !text) return "error: title and text are required";
      const { mergeOrCreate } = await import("../playbook");
      const entry = await mergeOrCreate(mcpExtras?.userId || "default", {
        pattern: "skill",
        content: `${title}: ${text}`,
        tags: ["skill", title.toLowerCase()],
        evidence: { source: "skill_create" },
      });
      return `Created skill "${title}" (confidence: ${Math.round((entry?.confidence ?? 0.5) * 100)}%)`;
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  if (name === "session_search" && typeof call.query === "string") {
    try {
      const userId = mcpExtras?.userId;
      if (!userId) return "error: session search needs a user context";
      const msgs = await prisma.message.findMany({
        where: {
          conversation: { userId },
          content: { contains: call.query.slice(0, 200), mode: "insensitive" },
        },
        include: { conversation: { select: { title: true } } },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      if (msgs.length === 0) return "No matching messages found.";
      return msgs.map((m) => `- [${m.conversation.title}] ${m.content.slice(0, 120)}`).join("\n");
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
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

  // ── browser_* — one contract, Playwright backend (no HTTP hop) ──────────
  // Op mapping, arg validation, and result formatting live in
  // agent/contract/browser.ts — shared with the interactive client worker.
  if (typeof name === "string" && name.startsWith("browser_")) {
    try {
      const { browserOpOf, runBrowserTool } = await import("@/lib/agent/contract/browser");
      const { playwrightBackend } = await import("@/lib/agent/contract/browser-server");
      if (!browserOpOf(name)) return `error: ${name} is not supported in server runs`;
      // Session fixation guard: the session key stays run-scoped — a
      // model-supplied sessionId must never escape this run's browser.
      const { sessionId: _dropped, ...modelArgs } = call as unknown as Record<string, unknown>;
      return await runBrowserTool(
        playwrightBackend(`run:${runId}`), // session scoped to this run — isolated per execution
        name,
        modelArgs
      );
    } catch (err) {
      // A lane failure (backend import, browser crash) is a tool error, never
      // a run failure — same envelope as every other lane here.
      return `error: browser ${name} failed: ${(err as Error).message.slice(0, 200)}`;
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
            else resolve(truncateWithNotice([stdout, stderr].filter(Boolean).join("\n"), 8000, "combined stdout+stderr") || "(no output)");
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
  // Resolve the RUN USER's own key before falling back to the platform env.
  // This used to read process.env only, so a user who had paid for and
  // configured a key in Settings got it honoured in chat and completely
  // ignored here — their background runs silently executed on the platform's
  // free shared key, against a model they never picked.
  const credential = await resolveRunCredential(run.userId, run.modelOverride);
  const adapter = credential
    ? createAdapterForProvider(credential.provider, run.modelOverride ?? credential.model ?? null, credential.apiKey)
    : createProviderAdapter(run.modelOverride);
  // True when this run is on a platform/free allowance (no paid BYOK key), so
  // free-tier shaping (compact prompt, reduced tools, tighter budgets) and
  // quota accounting apply to it — and never to a user's paid key.
  const onFreeTierLane = credential ? credential.isFreeTier : true;
  // Durable resolution: session Map → DB (survives server restarts).
  const workDir = (await resolveWorkspaceCwd(run.userId)) || process.cwd();
  let ctx: WorktreeContext | null = null;
  let transcript: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: truncateWithNotice(run.prompt, 100_000, "task prompt") },
  ];
  let turns = 0;
  let summary = "";
  // Scratchpad: claimed runs do real multi-step work, so start seeded. The
  // block is re-rendered fresh into every turn's results message (stale copies
  // compact away harmlessly; the live one is always in the latest message).
  let scratch: ScratchpadState = seedScratchpad(run.prompt);
  // Paths written this run (for the verification lane + artifacts).
  const writtenFiles = new Set<string>();
  // Ordered tool names this run invoked — the raw material for the trajectory
  // and for pattern mining (see agent-insights.ts).
  const toolsUsed: string[] = [];
  const startedAt = Date.now();
  // Auto-checkpoint state: pre-write checkpoints with cooldown + per-run cap.
  const autoCp: AutoCheckpointState = newAutoCheckpointState();
  // Token metering (native function-calling turns only; text-protocol turns
  // carry no counts and are reported honestly as unknown).
  const usageTotal = { promptTokens: 0, completionTokens: 0 };
  let usageKnown = false;
  // Failover state lives at function scope: the catch block reports which
  // provider actually served the run before it failed.
  let currentAdapter: AIProviderAdapter = adapter;
  let servedProvider = adapter.name || process.env.AI_PROVIDER || "nvidia";
  // Flips when the provider rejects the function-calling request shape —
  // the rest of the run then uses the text protocol.
  let nativeBroken = false;
  // Loop breaker (parity with the client worker — loop-detect.ts): without
  // it a stuck model burned all TURN_LIMIT turns re-sending the same call.
  const loopStreaks = createLoopStreaks();
  let loopBreakAttempted = false;
  let lastToolResults = "";

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
            const handle = await getMcpServerForRun(serverName, mcpRunConfigs, run.userId);
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

    // SDK lane (Phase 8, default): remote OAuth connectors from the Phase 5
    // snapshot. Workspace/account stdio configs win on name conflicts; in
    // ORPLEX_MCP=legacy this list stays empty (rollback safety, C8).
    // Phase 9 self-heal: discover any connected server whose snapshot hasn't
    // been written yet OR is stale, so freshly-connected connectors (and
    // servers whose tools changed since the last snapshot) are visible on the
    // first run and on every run thereafter. Errors swallowed.
    let remoteTools: BuilderTool[] = [];
    let mcpServerSummaries: Array<{ name: string; description: string; toolCount: number }> = [];
    try {
      if (resolveMcpLane(process.env.ORPLEX_MCP) === "sdk") {
        const stdioNames = new Set(Object.keys(mcpRunConfigs));
        await refreshMissingMcpSnapshots(run.userId).catch(() => {});
        const snapshotTools = (await listSnapshotToolsByServer(run.userId)).filter((t) => !stdioNames.has(t.server));
        remoteTools = snapshotTools;
        // Build server summaries from the snapshot so the prompt shows what each
        // connected server IS (not just its tool names).
        const merged = buildMcpRoster(snapshotTools);
        mcpServerSummaries = merged.servers.map((s) => ({
          name: s.name,
          description: getMcpCatalogEntry(s.name)?.description ?? "",
          toolCount: s.toolCount,
        }));
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

    // Playbook: evidence-backed learnings from previous verified runs,
    // retrieved once per run for the task at hand (not per turn).
    // Token-budgeted, only for cosine-similar matches; empty → omitted.
    let playbookBlock = "";
    try {
      const { searchPlaybooks, formatPlaybooksForPrompt } = await import("../playbook");
      playbookBlock = formatPlaybooksForPrompt(await searchPlaybooks(run.userId, run.prompt.slice(0, 500), 3)) || "";
    } catch {
      playbookBlock = "";
    }

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

    const nativeDefs = buildNativeToolDefs(mcpTools, remoteTools);

    // Build the system prompt WITH the refreshed MCP section so the model
    // sees every connected server and its tools on the very first run.
    const executorMcpSection = remoteTools.length > 0 ? mcpPromptSection(buildMcpRoster(remoteTools)) : "";

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
            model: adapterModelId(currentAdapter),
            ok: true,
            latencyMs: Date.now() - t0,
          });
          return out;
        } catch (err) {
          recordProviderEvent({
            userId: run.userId,
            lane: "server_run",
            provider: servedProvider,
            model: adapterModelId(currentAdapter),
            ok: false,
            errorMessage: String((err as Error).message),
            latencyMs: Date.now() - t0,
          });
          const next = failoverChain[chainIdx + 1];
          if (!next || !isRateLimitError(err)) throw err;
          chainIdx++;
          const from = servedProvider;
          // Do NOT carry the primary's model id to a different provider: an
          // id chosen for Groq (e.g. "openai/gpt-oss-120b") is a 404 on
          // OpenRouter, and a 404 is not a rate limit — so the chain died at
          // the first hop and the fallback could never actually fire. Only an
          // override we can attribute to THIS provider survives; otherwise the
          // target provider serves its own registry default.
          const overrideForNext =
            run.modelOverride && next === servedProvider ? run.modelOverride : null;
          currentAdapter = createAdapterForProvider(next, overrideForNext);
          servedProvider = next;
          await emit(run.id, "provider-failover", { from, to: next, reason: String((err as Error).message).slice(0, 200) }).catch(() => {});
        }
      }
    }

    for (turns = 1; turns <= TURN_LIMIT; turns++) {
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "executing" } }).catch(() => {});

      // Compact before the call when the transcript is over budget.
      const transcriptTokens = transcript.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
      const budget = resolveTranscriptBudget(currentAdapter);
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
      const nativeMode = typeof currentAdapter.completeWithTools === "function" && !nativeBroken;
      const messages = [
        { role: "system", content: buildSystemPrompt(
          mcpTools,
          nativeMode,
          memoryBlock,
          skillRoster,
          playbookBlock,
          [
            ...Object.keys(mcpRunConfigs).map((serverId) => ({
              name: getMcpCatalogEntry(serverId)?.name ?? serverId,
              description: getMcpCatalogEntry(serverId)?.description ?? "user-connected MCP server",
              toolCount: mcpTools.filter((t) => t.server === serverId).length,
            })),
            // SDK-lane OAuth connectors (Phase 8): summarized alongside stdio.
            ...mcpServerSummaries,
          ],
          remoteTools
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
        // Target wins: a model argument literally named "name" must never
        // overwrite the dispatch target (the sibling lanes strip it the
        // same way; a legit `name` parameter stays undeliverable via flat
        // calls — known limitation, documented at the dispatch sites).
        ? nativeCalls.map((c) => ({ ...c.args, name: c.name }))
        : parseToolCalls(text)
            // Bare-JSON recovery: weak OpenAI-compatible models sometimes drop the
            // XML wrapper and emit a tool-call JSON object instead (live-observed:
            // `{"name":"read_file",...}` became the run "summary"). Only tried
            // when XML found nothing, and gated to tool-call-shaped JSON.
            .concat(parseToolCalls(text).length === 0 ? parseBareJsonToolCalls(text) : [])
            .filter((c) => TOOL_WHITELIST.has(String(c.name)) || String(c.name).startsWith("mcp__"));
      if (calls.length === 0) {
        summary = truncateWithNotice(text, 20_000, "final report");
        break; // plain-text answer = done
      }

      // Streak-based loop detection — BEFORE dispatch, so a tripped call never
      // executes. First trip = one evidence-laden strategy change; a second
      // trip (the model ignored the evidence) = honest early stop with the
      // work that exists committed on the branch.
      const loopVerdict = trackToolTurn(loopStreaks, calls as Array<{ name?: string }>);
      if (loopVerdict.loop) {
        if (loopBreakAttempted) {
          await emit(run.id, "loop-stopped", { reason: loopVerdict.reason }).catch(() => {});
          summary = `Stopped early: the agent kept repeating ${loopVerdict.reason} after a strategy-change instruction. Work so far is committed on branch ${ctx.branch} for review.`;
          break;
        }
        loopBreakAttempted = true;
        await emit(run.id, "loop-break", { reason: loopVerdict.reason }).catch(() => {});
        transcript.push({ role: "user", content: buildLoopBreakDirective(loopVerdict, lastToolResults) });
        continue;
      }

      const results: string[] = [];
      for (const call of calls) {
        const toolName = String(call.name);
        // Feed the insight store's ordered tool sequence. Bounded so a runaway
        // loop cannot grow this array without limit (the trajectory writer
        // truncates too, but bounding here keeps memory flat).
        if (toolName && toolsUsed.length < 400) toolsUsed.push(toolName);
        // use_skill resolves against the discovered skill list before dispatch.
        if (toolName === "use_skill") {
          (call as Record<string, unknown>).__skillBody = skillBody(skills, String((call as Record<string, unknown>).name_of_skill ?? "")) ?? "";
        }
        const out = await executeTool(call as never, ctx, run.autonomyPolicy !== "auto", run.id, writtenFiles, hooks, autoCp, mcpRunConfigs, mcpTools, {
          get: () => scratch,
          update: (section, content) => {
            scratch = updateScratchpadSection(scratch, section, content, turns);
          },
        }, { userId: run.userId, remoteTools });
        results.push(`<tool_result name="${String(call.name)}">${out}</tool_result>`);
      }
      const scratchBlock = renderScratchpadBlock(scratch);
      lastToolResults = results.join("\n");
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

    // Playbook evidence: did the browser verification lane run clean?
    // null = lane never ran (the derive gate then refuses to learn);
    // false = ran red. Set inside the lane block below.
    let verifyPass: boolean | null = null;
    if (
      writtenPaths.length > 0 &&
      looksLikeUiWork(writtenPaths) &&
      ctx.isGitRepo &&
      modulesReady &&
      !isMemoryPressureHigh()
    ) {
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: "verifying" } }).catch(() => {});
      verifyPass = false; // lane ran; flips true only on a clean pass below
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
          const out = await executeTool(call as never, ctx, run.autonomyPolicy !== "auto", run.id, writtenFiles, hooks, autoCp, mcpRunConfigs, mcpTools, undefined, { userId: run.userId, remoteTools });
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
        verifyPass = true;
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

    // Playbook learning: derive evidence-gated entries from this run and
    // merge them (repeat evidence raises confidence, contradictions decay).
    // Best-effort — learning must never fail a completed run. The derive
    // gate refuses unverified runs (browser lane must have passed), so only
    // proven work teaches.
    if (writtenPaths.length > 0) {
      try {
        const { readFile: readWritten } = await import("fs/promises");
        const { join: joinRun } = await import("path");
        const files: Record<string, string> = {};
        for (const p of writtenPaths.slice(0, 8)) {
          try {
            const c = await readWritten(joinRun(ctx.worktreeDir, p), "utf8");
            files[p] = c.slice(0, 20000);
          } catch {
            // Unreadable (deleted/moved post-write) — skip the file, keep the rest.
          }
        }
        if (Object.keys(files).length > 0) {
          const { deriveFromRun, mergeOrCreate } = await import("../playbook");
          const derived = deriveFromRun({
            task: run.prompt,
            files,
            lanes: { browser: verifyPass === true ? "pass" : verifyPass === false ? "fail" : undefined },
            finalStatus: "done",
          });
          for (const entry of derived) {
            await mergeOrCreate(run.userId, entry, run.id).catch(() => null);
          }
        }
      } catch {
        // Learning never fails a run.
      }
    }

    await emit(run.id, "run-finished", { turns, changedFiles: changed.length, sha, provider: servedProvider });

    // Durable insight record: this is what feeds /api/agent/insights (tasks,
    // tool-call audit, the run trajectory, and eventually learned patterns).
    // Fire-and-forget and individually guarded — telemetry must never delay or
    // fail a completed run.
    await recordRunInsights({
      run,
      ok: true,
      summary,
      turns,
      filesWritten: changed,
      tokenUsage: usageKnown ? usageTotal : null,
      toolsUsed,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});

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
    // Same durable insight record on the failure path — a failed run is often
    // the more interesting one (it is what the pattern miner learns from).
    await recordRunInsights({
      run,
      ok: false,
      summary,
      turns,
      filesWritten: [...writtenFiles],
      tokenUsage: usageKnown ? usageTotal : null,
      toolsUsed,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
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

/**
 * Record a finished (or failed) run into the durable insight store.
 *
 * This is the wiring that gives Task, ToolCall, PipelineStep, SonaTrajectory,
 * SonaPattern and VectorMemoryEntry actual writers. Every step is individually
 * guarded: an insight write that fails must never turn a good run into a bad
 * one, and a partially-recorded run is far better than none.
 *
 * Pattern mining is NOT run here — it is a batch job over trajectories,
 * triggered by GET /api/agent/insights?learn=1, because mining on every run
 * would re-scan the whole table N times.
 */
async function recordRunInsights(input: {
  run: QueuedRun;
  ok: boolean;
  summary: string;
  turns: number;
  filesWritten: string[];
  tokenUsage: { promptTokens: number; completionTokens: number } | null;
  toolsUsed: string[];
  durationMs: number;
}): Promise<void> {
  const { run } = input;
  const { recordTask, completeTask, recordToolCall, recordPipelineStep, recordTrajectory, rememberSemantic } =
    await import("@/lib/agent-insights");

  // 1) Task — the per-user durable record for this run.
  const taskId = await recordTask({ userId: run.userId, prompt: run.prompt, mode: "code", runId: run.id });

  if (taskId) {
    // 2) ToolCall — the audit trail of what the agent actually invoked.
    // One row per DISTINCT tool with its invocation count, so a 200-call run
    // does not write 200 rows.
    const counts = new Map<string, number>();
    for (const t of input.toolsUsed) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [tool, n] of counts) {
      await recordToolCall({
        taskId,
        tool,
        args: "",
        status: input.ok ? "success" : "error",
        duration: input.durationMs,
        result: `invoked ${n}x`,
      }).catch(() => {});
    }
    await completeTask(taskId, input.summary, input.ok).catch(() => {});
  }

  // 3) PipelineStep — per-stage timing for this run.
  await recordPipelineStep({
    runId: run.id,
    state: "executor",
    input: input.summary.slice(0, 2_000),
    output: `${input.turns} turns · ${input.filesWritten.length} files · ${input.toolsUsed.length} tool calls`,
    duration: input.durationMs,
    success: input.ok,
  }).catch(() => {});

  // 4) SonaTrajectory — the full record the pattern miner reads.
  await recordTrajectory({
    task: run.prompt,
    outcome: input.ok ? "success" : "failure",
    toolsUsed: input.toolsUsed,
    filesChanged: input.filesWritten,
    steps: input.toolsUsed.map((tool) => ({ tool, ok: input.ok })),
    totalTokens: input.tokenUsage ? input.tokenUsage.promptTokens + input.tokenUsage.completionTokens : 0,
    totalDuration: input.durationMs,
  }).catch(() => {});

  // 5) VectorMemoryEntry — semantic memory of what this run achieved, so a
  // later similar task can recall it. Type is `pattern` for successes (the
  // reusable knowledge) and `error` for failures (the thing to avoid).
  await rememberSemantic({
    type: input.ok ? "pattern" : "error",
    content: `${run.prompt}\n\n${input.summary}`.slice(0, 8_000),
    filePath: input.filesWritten[0],
    success: input.ok,
    tags: [...new Set(input.toolsUsed)].slice(0, 20),
  }).catch(() => {});
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
