// native-tools.ts — The worker's per-turn tool DISPATCH, extracted from
// background-worker.ts. One exported function: `dispatchToolCall` executes a
// single tool call and returns its `<tool_result>` XML for the next model
// turn. All display/store/state access is injected via ToolContext, so this
// module owns zero globals and is unit-testable in isolation.
//
// Unknown or unimplemented tools now produce an explicit error tool_result —
// previously they silently returned nothing and the model burned turns
// waiting for a result that never came.

import { TIMEOUTS, LIMITS, isBlockedCommand } from "../constants";
import { classifyRisk } from "../risk-classifier";
import { requestApproval } from "../approval-store";
import { computeDiff } from "../file-history";
import { virtualFS } from "../virtual-fs";
import {
  searchCodeInContents,
  listFilesUnderPath,
  screenshotMarkdown,
  downscaleDataUrl,
} from "../tool-text";
import { recordFailure } from "../failure-memory";
import { emitActivity, emitPreview } from "../agent-events";
import { CLARIFICATION_SKIP } from "../background-chat";
import { writeFileAudited, editFileAudited, type FileOpsFs, type FileOpsCounters } from "./file-ops";
import { isServerCommand, diagnosePortConflict } from "./serve-helpers";
import type { ToolCall } from "../stream-reader";
import { apiFetch } from "@/lib/api-base";

const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";

export interface ToolContext {
  mode: string;
  /** Files read this task (path → count) — dedup tracking */
  readFiles: Map<string, number>;
  /** Cached full contents of files read this task */
  contextFiles: Map<string, string>;
  /** Cached read previews (path → 5-line preview) */
  readResults: Map<string, string>;
  abortSignal: AbortSignal | null;
  fs: FileOpsFs;
  counters: FileOpsCounters;
  fileTree: any[];
  /** Cached workspace file contents — the search_code index */
  fileContents: Record<string, string>;

  /** background-chat store integration (todos & questions) */
  store: {
    setTodos(items: string[]): void;
    completeTodo(index: number): void;
    clearTodos(): void;
    setQuestion(question: string, options: string[], allowFreeText: boolean, meta?: { context?: string; kind?: "question" | "clarification" }): void;
    /** Mark the pending question answered — used on timeout so a card never dangles. */
    answerQuestion(answer: string): void;
  };
  /** Task-stat bumps the worker tracks for completion notifications */
  stats: {
    commandRun(): void;
    failedStep(): void;
    rejectedAction(): void;
  };
  /** Plugin-hook bridges so audited writes stay observable */
  hooks: {
    fileWritten(path: string, content: string): void;
    fileEdited(path: string, oldText: string, newText: string): void;
  };

  // ── Display-transcript accessors (the worker composes the visible text) ──
  getDisplay(): string;
  appendDisplay(text: string): void;
  /**
   * Scratchpad access (optional — queue-runner/server lanes have no task
   * scratchpad). The worker owns the state; the dispatcher only routes the
   * model's section writes through update().
   */
  scratchpad?: {
    get(): import("../scratchpad").ScratchpadState;
    update(section: import("../scratchpad").ScratchpadSection, content: string): void;
  };
  setStatus(status: import("../background-chat").TaskStatus, detail?: string): void;
  /** Replace the last status line in the display transcript */
  replaceStatus(line: string): void;
  /** Push the display transcript to the store */
  syncDisplay(): void;
  /** Poll for the user's answer to a pending question */
  waitForAnswer(timeoutMs?: number): Promise<string>;
}

export interface DispatchOutcome {
  resultXml: string;
  blocked: boolean;
  /** true when the read was served from cache (dedup) — the loop uses this for re-prompting */
  dedupRead?: boolean;
  /** Screenshot pixels (downscaled data URL) — the worker forwards these to
   *  the vision channel so the model SEES the capture, and they are already
   *  rendered inline in the chat transcript by the handler below. */
  imageDataUrl?: string;
}

/**
 * Shared screenshot landing: embed the capture inline in the chat transcript
 * (the markdown renderer turns it into an <img>) and return the pixels so
 * the caller can forward them to the vision channel. Never throws — worst
 * case it returns undefined and the chat shows text only, exactly like
 * before. NOTE: resultXml stays text-only on purpose — pixels travel via
 * the return value (vision) + the display transcript (chat <img>).
 */
async function attachScreenshot(
  ctx: ToolContext,
  rawDataUrl: unknown,
  label: string
): Promise<string | undefined> {
  try {
    if (typeof rawDataUrl === "string" && rawDataUrl.startsWith("data:image/")) {
      const shot = await downscaleDataUrl(rawDataUrl);
      ctx.appendDisplay(screenshotMarkdown(shot, label));
      ctx.syncDisplay();
      return shot;
    }
  } catch {}
  return undefined;
}

/** fetch helper that aborts when the task aborts or the timeout fires */
function ctxFetch(url: string, init: RequestInit, ctx: ToolContext, timeoutMs?: number): Promise<Response> {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal =
    ctx.abortSignal && timeoutSignal
      ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
      : (ctx.abortSignal ?? timeoutSignal);
  return fetch(url, { ...init, signal });
}

function previewOf(content: string, maxLines = 5): string {
  const lines = content.split("\n").filter(l => l.trim());
  return lines.slice(0, maxLines).join(" ").slice(0, 80) + (lines.length > maxLines ? "…" : "");
}

// read_file returns at most this many chars per call. Files live on disk —
// the tool surfaces a head window instead of materializing megabytes into the
// model context AND the per-task caches. Pagination: offset/limit args let
// the agent walk the rest natively (no sed workaround).
const MAX_READ_CHARS = 200_000;
const MAX_PAGE_CHARS = 200_000; // per-call ceiling for offset/limit pages too

/**
 * Slice a page out of full file content by LINES (agent-friendly: line
 * numbers are what search results and editors speak). offset is 1-based;
 * limit caps both line count and MAX_PAGE_CHARS so a page can never flood
 * the context. Returns { text, startLine, endLine, totalLines }.
 */
function pageByLines(content: string, offsetRaw: unknown, limitRaw: unknown) {
  // A trailing newline produces a phantom empty last element — drop it so
  // line counts match editors/ripgrep (both count 750,000, not 750,001).
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const totalLines = lines.length;
  const offset = Math.max(1, Math.min(totalLines, Math.floor(Number(offsetRaw)) || 1));
  const requested = Math.floor(Number(limitRaw));
  const maxLinesByChars = Math.max(1, Math.floor(MAX_PAGE_CHARS / 120)); // ~120 chars/line heuristic
  const limit = Math.max(1, Math.min(totalLines - offset + 1, maxLinesByChars, Number.isFinite(requested) && requested > 0 ? requested : 2000));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return { text: slice.join("\n"), startLine: offset, endLine: offset - 1 + slice.length, totalLines };
}

export async function dispatchToolCall(
  call: ToolCall,
  ctx: ToolContext
): Promise<DispatchOutcome> {
  let toolResults = "";
  const result = (xml: string) => {
    toolResults += xml;
  };

  // ── MCP connector tools (mcp__<server>__<tool>) ─────────────────────
  // OAuth-authenticated remote servers connected in MCP connectors. Checked
  // FIRST so their names never collide with built-ins. Risk-tiered approval
  // runs BEFORE dispatch (C6): unknown third-party tools default to medium,
  // only server-declared read-only + the user's per-server toggle go silent.
  if (call.name.startsWith("mcp__")) {
    const { assessMcpToolRisk } = await import("../mcp/risk-hint");
    const mcpRisk = assessMcpToolRisk(call.name);
    if (!mcpRisk.autoApprovable) {
      if (mcpRisk.level === "high") {
        emitActivity({ type: "tool", message: `High-risk MCP tool requires approval: ${call.name}`, agent: "coder" });
      }
      ctx.setStatus("awaiting_approval", `Waiting for approval: ${call.name}`);
      ctx.appendDisplay(`${call.name} — awaiting approval\n`);
      ctx.syncDisplay();
      const approved = await requestApproval(
        "mcp_tool",
        `MCP tool ${call.name} — ${mcpRisk.reason}`,
        { tool: call.name },
        undefined,
        mcpRisk.level
      );
      if (!approved) {
        ctx.stats.rejectedAction();
        result(`<tool_result name="${call.name}">rejected by user</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Rejected: ${call.name}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
    }
    const { dispatchMcpToolCall } = await import("../mcp/dispatch");
    return dispatchMcpToolCall(call as { name: string } & Record<string, unknown>, {
      setStatus: ctx.setStatus,
      appendDisplay: ctx.appendDisplay,
      syncDisplay: ctx.syncDisplay,
    });
  }

  // ── over-cap MCP meta tools (C10) ─────────────────────────────────────
  // Read-only discovery (no approval): search/describe run against the same
  // localStorage roster the prompt section was built from.
  if (call.name === "mcp_search_tools" || call.name === "mcp_describe_tool") {
    const { loadRemotes } = await import("../mcp/registry");
    const { executeMcpMetaTool } = await import("../mcp/tool-builder");
    const tools = loadRemotes().flatMap((r) =>
      (r.tools ?? []).map((t) => ({
        server: r.id,
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }))
    );
    ctx.setStatus("tool_executing", `${call.name}…`);
    const out = executeMcpMetaTool(call.name, call as unknown as Record<string, unknown>, tools);
    ctx.appendDisplay(`[OK] ${call.name}\n`);
    ctx.syncDisplay();
    result(`<tool_result name="${call.name}">\n${out}\n</tool_result>\n`);
    return { resultXml: toolResults, blocked: false };
  }

  // ── read_file ─────────────────────────────────────────────────────────
  if (call.name === "read_file" && call.path) {
    const readCount = ctx.readFiles.get(call.path) || 0;
    const MAX_DUPLICATE_READS = 3;

    // Dedup: after enough reads, serve the cached FULL content — a 5-line
    // preview made the model re-read forever (it could never see the file).
    if (readCount >= MAX_DUPLICATE_READS) {
      const cached = ctx.contextFiles.get(call.path);
      const preview = ctx.readResults.get(call.path) || "(already read)";
      result(`<tool_result name="read_file" path="${call.path}">\n[Already read ${readCount} times — showing cached content, do NOT re-read]\n${cached ?? preview}\n</tool_result>\n`);
      ctx.appendDisplay(`[OK] Read \`${call.path}\` (cached — already read ${readCount}×)\n`);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    ctx.readFiles.set(call.path, readCount + 1);
    ctx.setStatus("tool_executing", `Reading ${call.path}…`);
    emitActivity({ type: "tool", message: `Reading ${call.path}`, agent: "coder" });
    ctx.appendDisplay(`analysing [${call.path}]\n`);
    ctx.syncDisplay();

    // Paged read: offset (1-based line) and/or limit (line count) fetch an
    // exact window — the native replacement for the old sed workaround.
    // Requires a size probe so the server lane can read ONLY the page from
    // disk instead of materializing the whole file first.
    const wantsPage = call.offset !== undefined || call.limit !== undefined;
    if (wantsPage && ctx.fs.readPage) {
      try {
        const page = await ctx.fs.readPage(call.path, Math.floor(Number(call.offset)) || 1, Math.floor(Number(call.limit)) || 2000);
        if (page) {
          const body =
            page.text +
            (page.hasMore
              ? `\n\n[…page continues — read_file ${call.path} offset=${page.endLine + 1} for the next section; total ${page.totalLines.toLocaleString()} lines]`
              : `\n\n[end of file — ${page.totalLines.toLocaleString()} lines total]`);
          result(`<tool_result name="read_file" path="${call.path}" lines="${page.startLine}-${page.endLine}">\n${body}\n</tool_result>\n`);
          ctx.readResults.set(call.path, previewOf(page.text));
          ctx.replaceStatus(`[OK] Read \`${call.path}\` lines ${page.startLine}–${page.endLine} of ${page.totalLines.toLocaleString()}`);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
      } catch {
        // probe failed — fall through to the whole-file path below
      }
    }

    let content = (await ctx.fs.readFile?.(call.path)) || "(file not available)";
    if (wantsPage && content.length > 0 && !content.startsWith("[Error")) {
      // Client lane (no readPage): full text is already in memory — slice it.
      const { text, startLine, endLine, totalLines } = pageByLines(content, call.offset, call.limit);
      const body =
        text +
        (endLine < totalLines
          ? `\n\n[…page continues — read_file ${call.path} offset=${endLine + 1} for the next section; total ${totalLines.toLocaleString()} lines]`
          : `\n\n[end of file — ${totalLines.toLocaleString()} lines total]`);
      result(`<tool_result name="read_file" path="${call.path}" lines="${startLine}-${endLine}">\n${body}\n</tool_result>\n`);
      ctx.readResults.set(call.path, previewOf(text));
      ctx.replaceStatus(`[OK] Read \`${call.path}\` lines ${startLine}–${endLine} of ${totalLines.toLocaleString()}`);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }
    if (content.length > MAX_READ_CHARS) {
      const total = content.length;
      content =
        content.slice(0, MAX_READ_CHARS) +
        `\n\n[…truncated — showing first ${MAX_READ_CHARS.toLocaleString()} of ${total.toLocaleString()} chars. Use read_file with offset/limit (line numbers) to page through the rest — e.g. offset=${Math.ceil(MAX_READ_CHARS / 80)} for the next section — or grep -n to locate.]`;
    }
    const contentLength = content.length;
    const lineCount = content.split("\n").length;

    ctx.readResults.set(call.path, previewOf(content));
    if (!content.startsWith("[Error") && content !== "(file not available)") {
      ctx.contextFiles.set(call.path, content);
    }
    result(`<tool_result name="read_file" path="${call.path}">\n${content}\n</tool_result>\n`);
    ctx.replaceStatus(`[OK] Read \`${call.path}\` (lines 1–${lineCount}, ${contentLength} chars)`);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── list_files ────────────────────────────────────────────────────────
  if (call.name === "list_files") {
    ctx.setStatus("tool_executing", `Listing ${call.path || "."}…`);
    emitActivity({ type: "tool", message: `Listing ${call.path || "."}`, agent: "coder" });
    ctx.appendDisplay(`analysing [${call.path || "."}]\n`);
    ctx.syncDisplay();

    const listing = listFilesUnderPath(call.path || "", ctx.fileTree);
    const fileCount = listing.split("\n").length;
    result(`<tool_result name="list_files" path="${call.path || "."}">\n${listing}\n</tool_result>\n`);
    ctx.replaceStatus(`[SUCCESS] Listed ${fileCount} file(s) in \`${call.path || "."}\``);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── ASK mode is read-only ─────────────────────────────────────────────
  if (ctx.mode === "ask" && ["write_file", "write_file_chunk", "edit_file", "batch_edit", "undo_file"].includes(call.name)) {
    result(`<tool_result name="${call.name}">error — file modifications are disabled in ask mode. Present the code in your response text instead.</tool_result>\n`);
    ctx.replaceStatus(`[BLOCKED] ${call.name} — disabled in ask mode`);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: true };
  }

  // ── write_file ────────────────────────────────────────────────────────
  if (call.name === "write_file" && call.path && call.content !== undefined) {
    ctx.setStatus("tool_executing", `Writing ${call.path}...`);
    emitActivity({ type: "file", message: `Creating ${call.path}`, agent: "coder" });
    ctx.appendDisplay(`writing [${call.path}]\n`);
    ctx.syncDisplay();

    const lineCount = call.content.split("\n").length;

    // Approval gate: overwriting a file the agent did NOT create this task
    // needs user approval (with a diff). Files the agent itself created are
    // auto-approved — same contract as Claude Code's auto-accept-edits mode.
    if (!ctx.counters.writtenFiles.has(call.path)) {
      // Anti-clobber guard (server lane): oversized files are read as a head
      // window, so a full overwrite here would silently destroy the unseen
      // tail. Refuse BEFORE any whole-file read — reading a 74 MB file to
      // build an approval diff would spike memory exactly like the old
      // eager-index build did.
      let oversized = false;
      try {
        const probe = await ctx.fs.statFile?.(call.path);
        oversized = !!probe && probe.size > 8 * 1024 * 1024;
      } catch {}
      if (oversized && call.content.length < 4 * 1024 * 1024) {
        result(`<tool_result name="write_file" path="${call.path}">refused: the file on disk is far larger than this content — the write looks partial (windowed read) and would destroy the rest of the file. Rewrite big files with terminal streaming tools (sed -i, truncate) instead.</tool_result>\n`);
        ctx.replaceStatus(`[BLOCKED] Anti-clobber: \`${call.path}\` too large for a full overwrite`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: true };
      }

      const prevContent = await ctx.fs.readFile?.(call.path).catch(() => null);
      const existed = !!prevContent && !prevContent.startsWith("[Error");
      if (existed) {
        ctx.setStatus("awaiting_approval", `Waiting for approval: overwrite ${call.path}`);
        ctx.appendDisplay(`overwriting [${call.path}] — awaiting approval\n`);
        ctx.syncDisplay();
        // Skip the diff for very large files — computing it needs the whole
        // file in one string; a summary line is enough for approval UX.
        const diff = (prevContent!.length <= 2_000_000)
          ? computeDiff(prevContent!, call.content)
          : `[file too large for diff — ${prevContent!.length.toLocaleString()} chars on disk]`;
        const approved = await requestApproval(
          "write_file",
          `Overwrite ${call.path} (${lineCount} lines)`,
          { path: call.path, existed },
          diff
        );
        if (!approved) {
          ctx.stats.rejectedAction();
          result(`<tool_result name="write_file" path="${call.path}">rejected by user — do not write this file again without permission; adjust your approach.</tool_result>\n`);
          ctx.replaceStatus(`[BLOCKED] User rejected overwrite of \`${call.path}\``);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: true };
        }
      }
    }

    const success = await writeFileAudited(call.path, call.content, ctx.fs, ctx.counters);
    if (success) ctx.hooks.fileWritten(call.path, call.content);

    result(`<tool_result name="write_file" path="${call.path}">${success ? "success" : "error"}</tool_result>\n`);
    ctx.replaceStatus(
      success
        ? `[SUCCESS] Wrote \`${call.path}\` (${lineCount} lines)`
        : `[ERROR] Failed to write \`${call.path}\``
    );
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── write_file_chunk ──────────────────────────────────────────────────
  if (call.name === "write_file_chunk" && call.path && call.content !== undefined) {
    ctx.setStatus("tool_executing", `Appending to ${call.path}...`);
    emitActivity({ type: "file", message: `Appending to ${call.path}`, agent: "coder" });
    ctx.appendDisplay(`appending [${call.path}]\n`);
    ctx.syncDisplay();

    const existing = (await ctx.fs.readFile?.(call.path).catch(() => "")) || "";
    const newContent = existing + call.content;
    const chunkLines = call.content.split("\n").length;
    const totalLines = newContent.split("\n").length;
    let success = false;
    if (ctx.fs.writeFile) {
      success = await ctx.fs.writeFile(call.path, newContent);
    } else {
      success = virtualFS.writeFile(call.path, newContent);
    }
    if (success) {
      ctx.counters.writtenFiles.set(call.path, newContent);
      ctx.hooks.fileWritten(call.path, newContent);
    }

    result(`<tool_result name="write_file_chunk" path="${call.path}">${success ? `appended ${chunkLines} lines (total: ${totalLines} lines)` : "error"}</tool_result>\n`);
    ctx.replaceStatus(
      success
        ? `[SUCCESS] Appended ${chunkLines} lines to \`${call.path}\` (total: ${totalLines} lines)`
        : `[ERROR] Failed to append to \`${call.path}\``
    );
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── edit_file (risk-tiered approval) ──────────────────────────────────
  if (call.name === "edit_file" && call.path && call.old_text && call.new_text) {
    // Size guard (server lane): whole-file string replace needs the entire
    // file in memory — refuse for very large files, same policy as the
    // renderer's editFile. Streamed edits go through the terminal.
    try {
      const probe = await ctx.fs.statFile?.(call.path);
      if (probe && probe.size > 8 * 1024 * 1024) {
        result(`<tool_result name="edit_file" path="${call.path}">error: file too large for in-app edit (${(probe.size / 1048576).toFixed(1)} MB) — use terminal streaming tools (sed -i) instead.</tool_result>
`);
        ctx.replaceStatus(`[BLOCKED] \`${call.path}\` too large for edit_file`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: true };
      }
    } catch {}
    const editDiff = computeDiff(call.old_text, call.new_text);
    const editRisk = classifyRisk("edit_file", { path: call.path, old_text: call.old_text, new_text: call.new_text });
    // Files the agent already wrote this task are auto-approved on edit —
    // same contract as the write_file gate (auto-accept-edits mode).
    const agentOwned = ctx.counters.writtenFiles.has(call.path);
    let approved = true;
    if (!editRisk.autoApprovable && !agentOwned) {
      ctx.setStatus("awaiting_approval", `Waiting for approval: edit ${call.path}`);
      ctx.appendDisplay(`editing [${call.path}] — awaiting approval\n`);
      ctx.syncDisplay();
      approved = await requestApproval(
        "edit_file",
        `Edit ${call.path}`,
        { path: call.path, old_text: call.old_text, new_text: call.new_text },
        editDiff
      );
    }

    if (!approved) {
      ctx.stats.rejectedAction();
      result(`<tool_result name="edit_file" path="${call.path}">rejected by user</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Edit \`${call.path}\` — rejected`);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    ctx.setStatus("tool_executing", `Editing ${call.path}...`);
    const success = await editFileAudited(call.path, call.old_text, call.new_text, ctx.fs, ctx.counters);
    if (success) ctx.hooks.fileEdited(call.path, call.old_text, call.new_text);
    result(`<tool_result name="edit_file" path="${call.path}">${success ? "success — verify changes with read_file" : "error: text not found"}</tool_result>\n`);
    ctx.replaceStatus(success ? `[SUCCESS] Edited \`${call.path}\`` : `[FAIL] Failed to edit \`${call.path}\` — text not found`);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── batch_edit ────────────────────────────────────────────────────────
  if (call.name === "batch_edit" && Array.isArray(call.edits)) {
    const edits = call.edits as { path: string; old_text: string; new_text: string }[];
    ctx.setStatus("awaiting_approval", `Waiting for approval: batch edit ${edits.length} file(s)`);
    ctx.appendDisplay(`batch editing [${edits.length} files] — awaiting approval\n`);
    ctx.syncDisplay();

    const diffs = edits.map(e => `--- ${e.path}\n+++ ${e.path}\n${computeDiff(e.old_text, e.new_text)}`).join("\n\n");
    const approved = await requestApproval("edit_file", `Batch edit ${edits.length} file(s)`, { edits }, diffs);

    if (!approved) {
      ctx.stats.rejectedAction();
      result(`<tool_result name="batch_edit">rejected by user</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Batch edit rejected`);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    let successCount = 0;
    let failCount = 0;
    for (const edit of edits) {
      const ok = await editFileAudited(edit.path, edit.old_text, edit.new_text, ctx.fs, ctx.counters);
      if (ok) {
        successCount++;
        ctx.hooks.fileEdited(edit.path, edit.old_text, edit.new_text);
      } else failCount++;
    }
    result(`<tool_result name="batch_edit">${successCount} succeeded, ${failCount} failed</tool_result>\n`);
    ctx.replaceStatus(`[OK] Batch edit: ${successCount} files edited, ${failCount} failed`);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── search_code ───────────────────────────────────────────────────────
  if (call.name === "search_code" && call.query) {
    ctx.setStatus("tool_executing", `Searching "${call.query}"…`);
    ctx.appendDisplay(`searching [${call.query}]\n`);
    ctx.syncDisplay();

    // Real tree search first (server-side rg/git-grep over the registered
    // workspace). Falls back to the read-cache scan when no workspace folder
    // is open (virtual FS mode) or the server is unreachable — the agent
    // always gets an answer.
    let results: string | null = null;
    let engine = "cache";
    try {
      const res = await ctxFetch(`${base}/api/agent/grep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: call.query }),
      }, ctx, 12000);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        engine = data.engine || "grep";
        results = data.output || "";
      }
    } catch {}
    if (results === null) {
      results = searchCodeInContents(call.query, ctx.fileContents);
    }
    const lineCount = results ? results.split("\n").length : 0;
    result(`<tool_result name="search_code" query="${call.query}" engine="${engine}">\n${results || `No matches for "${call.query}"`}\n</tool_result>\n`);
    ctx.replaceStatus(`[OK] Search "${call.query}" [${engine}] — ${lineCount} line(s)`);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── code_search (snippet mode) ────────────────────────────────────────
  // Like search_code, but returns grouped per-file snippets with context
  // lines and ready-made read_file offset/limit hints — locate regions
  // without reading whole files. Server-side ripgrep via /api/agent/grep
  // (mode=snippets); falls back to the in-memory scan with a note when no
  // workspace folder is open.
  if (call.name === "code_search" && call.query) {
    ctx.setStatus("tool_executing", `Snippets for "${call.query}"…`);
    ctx.appendDisplay(`code_search [${call.query}]\n`);
    ctx.syncDisplay();

    let results: string | null = null;
    let engine = "cache";
    try {
      const res = await ctxFetch(`${base}/api/agent/grep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern: call.query, mode: "snippets", context: call.context }),
      }, ctx, 15000);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        engine = data.engine || "grep";
        results = data.output || "";
      }
    } catch {}
    if (results === null) {
      results =
        searchCodeInContents(call.query, ctx.fileContents) +
        "\n[offline fallback — open the workspace folder for context-rich ripgrep snippets]";
    }
    const matchCount = (results.match(/→ read_file/g) || []).length;
    result(`<tool_result name="code_search" query="${call.query}" engine="${engine}">\n${results}\n</tool_result>\n`);
    ctx.replaceStatus(`[OK] code_search "${call.query}" [${engine}] — ${matchCount} snippet(s)`);
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── web_search ────────────────────────────────────────────────────────
  if (call.name === "web_search" && call.query) {
    ctx.setStatus("tool_executing", `Searching web: "${call.query.slice(0, 30)}"…`);
    ctx.appendDisplay(`searching web [${call.query}]\n`);
    ctx.syncDisplay();

    try {
      const res = await ctxFetch(`${base}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: call.query }),
      }, ctx, 10000);
      const data = await res.json();
      const results = data.results || [];
      if (results.length > 0) {
        const formatted = results.map((r: any, i: number) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");
        result(`<tool_result name="web_search" query="${call.query}">\n${formatted}\n</tool_result>\n`);
        ctx.replaceStatus(`[OK] Web search "${call.query.slice(0, 30)}" — ${results.length} result(s)`);
      } else {
        result(`<tool_result name="web_search" query="${call.query}">No results found</tool_result>\n`);
        ctx.replaceStatus(`[OK] Web search "${call.query.slice(0, 30)}" — no results`);
      }
    } catch (err) {
      result(`<tool_result name="web_search" query="${call.query}">Search failed: ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Web search failed: ${(err as Error).message}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── run_command (approval → serve lane or exec) ───────────────────────
  if (call.name === "run_command" && call.command) {
    // Safety: block destructive commands (centralized blocklist)
    if (isBlockedCommand(call.command)) {
      result(`<tool_result name="run_command" command="${call.command}">BLOCKED: command is too dangerous to execute</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Command blocked for safety: \`${call.command.slice(0, 50)}\``);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    const commandRisk = classifyRisk("run_command", { command: call.command });
    let approved = true;
    if (commandRisk.autoApprovable === false) {
      if (commandRisk.level === "high") {
        emitActivity({ type: "tool", message: `High-risk command requires approval: ${call.command.slice(0, 40)}`, agent: "coder" });
      }
      ctx.setStatus("awaiting_approval", `Waiting for approval: ${call.command.slice(0, 40)}`);
      ctx.appendDisplay(`running [${call.command}] — awaiting approval\n`);
      ctx.syncDisplay();
      approved = await requestApproval("run_command", `Run: ${call.command}`, { command: call.command });
    } else {
      ctx.setStatus("tool_executing", `Running: ${call.command.slice(0, 40)}...`);
      emitActivity({ type: "tool", message: `Running ${call.command.slice(0, 40)}`, agent: "coder" });
      ctx.appendDisplay(`running [${call.command}]\n`);
      ctx.syncDisplay();
    }

    if (!approved) {
      ctx.stats.rejectedAction();
      result(`<tool_result name="run_command" command="${call.command}">rejected by user</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Command rejected: \`${call.command.slice(0, 50)}\``);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    // Lane selection lives in terminal-lane.ts: the Electron desktop bridge
    // runs commands ON THE USER'S DEVICE in their workspace folder; otherwise
    // the API lane runs them server-side. Either way every line is mirrored
    // to the Terminal tab via the terminal event bus.
    const { runTerminalCommand, hasDesktopTerminal, resolveDesktopCwd } = await import("../terminal-lane");
    const { emitTerminalLine } = await import("../terminal-events");
    const desktopCwd = resolveDesktopCwd(ctx.fs.directoryName);

    if (isServerCommand(call.command)) {
      // SERVE LANE: dev/preview servers never exit — run detached.
      if (hasDesktopTerminal() && desktopCwd) {
        try {
          const bridge = window.orplexDesktop!.terminal!;
          emitTerminalLine("cmd", `$ ${call.command}  [on this device]`, "agent");
          const started = await bridge.serveStart({ command: call.command, cwd: desktopCwd });
          if (started.ok) {
            ctx.stats.commandRun();
            if (started.tail) emitTerminalLine("stdout", started.tail, "agent");
            result(`<tool_result name="run_command" command="${call.command}">SERVER RUNNING on this device${started.url ? ` at ${started.url}` : ""}\n${started.tail || ""}\n</tool_result>\n`);
            ctx.replaceStatus(`[OK] Server running${started.url ? ` at ${started.url}` : ""} (device)`);
            if (started.url) emitPreview(started.url, "verify_app");
          } else {
            ctx.stats.failedStep();
            emitTerminalLine("error", started.error || "serve failed", "agent");
            result(`<tool_result name="run_command" command="${call.command}">FAILED: ${started.error}\n</tool_result>\n`);
            ctx.replaceStatus(`[FAIL] Server failed: ${String(started.error).split("\n")[0].slice(0, 60)}`);
          }
        } catch (err) {
          ctx.stats.failedStep();
          result(`<tool_result name="run_command" command="${call.command}">error: ${(err as Error).message}\n</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Server start failed`);
        }
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
      try {
        const serveRes = await ctxFetch("/api/agent/serve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", command: call.command }),
        }, ctx);
        const serveData = await serveRes.json();
        if (serveData.ok) {
          ctx.stats.commandRun();
          emitTerminalLine("cmd", `$ ${call.command}`, "agent");
          if (serveData.output) emitTerminalLine("stdout", String(serveData.output).slice(0, 4000), "agent");
          result(`<tool_result name="run_command" command="${call.command}">SERVER RUNNING — ${serveData.message}\n${serveData.output || ""}\n</tool_result>\n`);
          ctx.replaceStatus(`[OK] Server running${serveData.port ? ` at http://localhost:${serveData.port}` : ""}`);
          if (serveData.port) emitPreview(`http://localhost:${serveData.port}`, "verify_app");
        } else {
          ctx.stats.failedStep();
          result(`<tool_result name="run_command" command="${call.command}">FAILED: ${serveData.error}\n</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Server failed: ${String(serveData.error).split("\n")[0].slice(0, 60)}`);
        }
      } catch (err) {
        ctx.stats.failedStep();
        result(`<tool_result name="run_command" command="${call.command}">error: ${(err as Error).message}\n</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Server start failed`);
      }
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    // One-shot exec: shared lane runner (desktop-first, API fallback) — the
    // bus mirror makes every agent command visible in the Terminal tab.
    try {
      const execData = await runTerminalCommand({
        command: call.command,
        dirName: ctx.fs.directoryName,
        signal: ctx.abortSignal,
        source: "agent",
      });
      if (execData.exitCode === 0) {
        ctx.stats.commandRun();
        result(`<tool_result name="run_command" command="${call.command}">\n${execData.stdout}${execData.stderr ? `\nSTDERR: ${execData.stderr}` : ""}\n</tool_result>\n`);
        ctx.replaceStatus(`[OK] Command completed: \`${call.command.slice(0, 50)}\``);
      } else {
        ctx.stats.failedStep();
        const portHint = diagnosePortConflict(call.command, execData.stderr || execData.stdout || "");
        result(`<tool_result name="run_command" command="${call.command}">\n${execData.stdout}${execData.stderr ? `\nSTDERR: ${execData.stderr}` : execData.stderr}${portHint}\n</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Command failed: \`${call.command.slice(0, 50)}\` (exit ${execData.exitCode})${portHint ? " — port busy" : ""}`);
        recordFailure("command", `${call.command}\n${execData.stderr || execData.stdout || "exit " + execData.exitCode}`, []);
      }
    } catch (err) {
      ctx.stats.failedStep();
      result(`<tool_result name="run_command" command="${call.command}">error: ${(err as Error).message}\n</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Command failed: ${(err as Error).message.slice(0, 50)}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── run_in_sandbox (E2B when configured, detached serve for servers,
  //    else local exec with sandbox budgets) ─────────────────────────────
  if (call.name === "run_in_sandbox" && call.command) {
    const sandboxTimeout = (call.timeout as number) || TIMEOUTS.SANDBOX_EXEC / 1000;

    ctx.setStatus("awaiting_approval", `Waiting for approval: sandbox ${call.command.slice(0, 40)}`);
    ctx.appendDisplay(`sandbox [${call.command}] — awaiting approval\n`);
    ctx.syncDisplay();

    const approved = await requestApproval(
      "run_command",
      `Run in sandbox: ${call.command}`,
      { command: call.command, sandbox: true },
      undefined,
      "medium" // sandboxed execution is contained — never above medium
    );

    if (!approved) {
      ctx.stats.rejectedAction();
      result(`<tool_result name="run_in_sandbox" command="${call.command}">rejected by user</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Sandbox command rejected`);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    if (isServerCommand(call.command)) {
      // SERVER LANE for sandbox-called servers (live-validated: the model
      // chose run_in_sandbox for `npx serve . -l 5000`).
      try {
        const serveRes = await ctxFetch("/api/agent/serve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", command: call.command }),
        }, ctx);
        const serveData = await serveRes.json();
        if (serveData.ok) {
          ctx.stats.commandRun();
          result(`<tool_result name="run_in_sandbox" command="${call.command}">SERVER RUNNING — ${serveData.message}\n${serveData.output || ""}\n</tool_result>\n`);
          ctx.replaceStatus(`[OK] Server running${serveData.port ? ` at http://localhost:${serveData.port}` : ""}`);
          if (serveData.port) emitPreview(`http://localhost:${serveData.port}`, "verify_app");
        } else {
          ctx.stats.failedStep();
          result(`<tool_result name="run_in_sandbox" command="${call.command}">FAILED: ${serveData.error}\n</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Server failed: ${String(serveData.error).split("\n")[0].slice(0, 60)}`);
        }
      } catch (err) {
        ctx.stats.failedStep();
        result(`<tool_result name="run_in_sandbox" command="${call.command}">error: ${(err as Error).message}\n</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Server start failed`);
      }
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    const e2bKey = process.env.E2B_API_KEY;
    if (e2bKey) {
      // E2B cloud sandbox — optional dependency, only imported when a key exists
      ctx.setStatus("tool_executing", "Running in cloud sandbox…");
      try {
        // @ts-ignore — e2b is an optional dependency (npm i e2b to enable)
        const { Sandbox } = await import(/* webpackIgnore: true */ "e2b");
        const sandbox = await Sandbox.create({ apiKey: e2bKey });
        const execution = await sandbox.runCommand(call.command, { timeout: sandboxTimeout });
        const output = (execution.stdout || "") + (execution.stderr ? `\nSTDERR: ${execution.stderr}` : "");
        result(`<tool_result name="run_in_sandbox" command="${call.command}">\n${truncate(output, LIMITS.SANDBOX_OUTPUT)}\n</tool_result>\n`);
        ctx.replaceStatus(`[OK] Sandbox completed: \`${call.command.slice(0, LIMITS.COMMAND_STATUS)}\``);
        await sandbox.kill();
        ctx.stats.commandRun();
      } catch (err) {
        ctx.stats.failedStep();
        result(`<tool_result name="run_in_sandbox" command="${call.command}">error: ${(err as Error).message}</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Sandbox failed: ${(err as Error).message}`);
      }
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    // Fallback: local execution via the exec API with sandbox budgets
    ctx.setStatus("tool_executing", "Running locally (no sandbox key)…");
    try {
      const execRes = await ctxFetch("/api/agent/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: call.command,
          timeout: Math.min(sandboxTimeout * 1000, TIMEOUTS.COMMAND_EXEC),
          maxBuffer: LIMITS.SANDBOX_BUFFER,
        }),
      }, ctx);
      const execData = await execRes.json();
      const output = (execData.stdout || "") + (execData.stderr ? `\nSTDERR: ${execData.stderr}` : "");
      result(`<tool_result name="run_in_sandbox" command="${call.command}">\n${output}\n</tool_result>\n`);
      ctx.replaceStatus(
        execData.exitCode === 0
          ? `[OK] Command completed (local): \`${call.command.slice(0, 50)}\``
          : `[FAIL] Command failed: \`${call.command.slice(0, 50)}\` (exit ${execData.exitCode})`
      );
      if (execData.exitCode === 0) ctx.stats.commandRun();
      else ctx.stats.failedStep();
    } catch (err) {
      ctx.stats.failedStep();
      result(`<tool_result name="run_in_sandbox" command="${call.command}">error: ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Command failed: ${(err as Error).message.slice(0, 50)}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── undo_last_change ──────────────────────────────────────────────────
  if (call.name === "undo_last_change" && call.path) {
    ctx.setStatus("tool_executing", `Undoing ${call.path}…`);
    ctx.appendDisplay(`undoing [${call.path}]\n`);
    ctx.syncDisplay();

    const { undoLastChange } = await import("../file-history");
    const prevContent = undoLastChange(call.path);
    if (prevContent !== null && ctx.fs.writeFile) {
      await ctx.fs.writeFile(call.path, prevContent);
      ctx.hooks.fileWritten(call.path, prevContent);
      result(`<tool_result name="undo_last_change" path="${call.path}">success - restored previous version</tool_result>\n`);
      ctx.replaceStatus(`[OK] Undid change to \`${call.path}\` — restored previous version`);
    } else {
      result(`<tool_result name="undo_last_change" path="${call.path}">error - no previous version found</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] No previous version of \`${call.path}\` to undo`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── take_screenshot ───────────────────────────────────────────────────
  if (call.name === "take_screenshot" && call.url) {
    ctx.setStatus("tool_executing", `Capturing ${call.url}...`);
    ctx.appendDisplay(`capturing [${call.url}]\n`);
    ctx.syncDisplay();

    try {
      const res = await ctxFetch(`${base}/api/agent/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: call.url, width: 1280, height: 720 }),
      }, ctx, 20000);
      const data = await res.json();
      if (data.screenshot) {
        emitPreview(call.url, "take_screenshot");
        const shot = await attachScreenshot(ctx, data.screenshot, `screenshot — ${call.url}`);
        result(`<tool_result name="take_screenshot" url="${call.url}">success - screenshot captured (${data.width || 1280}x${data.height || 720}) and attached inline in the chat below. Page opened in the live preview panel.</tool_result>\n`);
        ctx.replaceStatus(`[OK] Screenshot captured: ${call.url} (shown in live preview)`);
        ctx.syncDisplay();
        if (shot) return { resultXml: toolResults, blocked: false, imageDataUrl: shot };
      } else {
        result(`<tool_result name="take_screenshot" url="${call.url}">error - ${data.error || "capture failed"}</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Screenshot failed: ${data.error || "unknown error"}`);
      }
    } catch (err) {
      result(`<tool_result name="take_screenshot" url="${call.url}">error - ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Screenshot failed: ${(err as Error).message}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── todo_list ─────────────────────────────────────────────────────────
  if (call.name === "todo_list") {
    const action = typeof call.action === "string" ? call.action : "";
    const items = Array.isArray(call.items)
      ? call.items.map((i: unknown) => typeof i === "string" ? i : JSON.stringify(i))
      : undefined;
    const completedIndex = typeof call.completed_index === "number" ? call.completed_index : undefined;

    if (action === "create" && items) {
      ctx.store.setTodos(items);
      result(`<tool_result name="todo_list" action="create">Created ${items.length} tasks</tool_result>\n`);
      ctx.replaceStatus(`[OK] Todo list created (${items.length} items)`);
    } else if (action === "update" && items) {
      ctx.store.setTodos(items);
      result(`<tool_result name="todo_list" action="update">Updated todo list</tool_result>\n`);
      ctx.replaceStatus(`[OK] Todo list updated`);
    } else if (action === "complete" && completedIndex !== undefined) {
      ctx.store.completeTodo(completedIndex);
      result(`<tool_result name="todo_list" action="complete">Marked item ${completedIndex} done</tool_result>\n`);
      ctx.replaceStatus(`[OK] Task ${completedIndex + 1} completed`);
    } else if (action === "clear") {
      ctx.store.clearTodos();
      result(`<tool_result name="todo_list" action="clear">Cleared todo list</tool_result>\n`);
      ctx.replaceStatus(`[OK] Todo list cleared`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── scratchpad_update ─────────────────────────────────────────────────
  // The model's private working memory. State lives in the worker (per task);
  // this case only validates + routes. Refused loudly when no scratchpad is
  // wired (server lanes) so the model adapts instead of looping.
  if (call.name === "scratchpad_update") {
    const section = typeof call.section === "string" ? call.section : "";
    const content = typeof call.content === "string"
      ? call.content
      : JSON.stringify(call.content ?? "");
    if (!ctx.scratchpad) {
      result(`<tool_result name="scratchpad_update">error - no scratchpad in this environment; keep your reasoning in the reply text instead.</tool_result>\n`);
    } else if (!["plan", "hypotheses", "findings", "next"].includes(section)) {
      result(`<tool_result name="scratchpad_update">error - section must be one of: plan, hypotheses, findings, next.</tool_result>\n`);
    } else {
      ctx.scratchpad.update(
        section as import("../scratchpad").ScratchpadSection,
        content.slice(0, 2000)
      );
      result(`<tool_result name="scratchpad_update" section="${section}">recorded (${content.length} chars). It will be re-shown to you every turn.</tool_result>\n`);
      ctx.replaceStatus(`[OK] Scratchpad: ${section} updated`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── ask_question ──────────────────────────────────────────────────────
  if (call.name === "ask_question") {
    const question = typeof call.question === "string" ? call.question : JSON.stringify(call.question ?? "");
    const options = Array.isArray(call.options)
      ? call.options.map((o: unknown) => typeof o === "string" ? o : JSON.stringify(o))
      : [];
    const allowFreeText = call.allow_free_text !== false;

    if (!question || options.length === 0) {
      result(`<tool_result name="ask_question">error - missing question or options</tool_result>\n`);
    } else {
      ctx.store.setQuestion(question, options, allowFreeText);
      ctx.setStatus("awaiting_approval", "Waiting for user answer…");
      ctx.appendDisplay(`asking [${question.slice(0, 40)}]\n`);
      ctx.syncDisplay();

      const answer = await ctx.waitForAnswer();
      result(`<tool_result name="ask_question" question="${question}">User answered: ${answer}</tool_result>\n`);
      ctx.replaceStatus(`[OK] User answered: "${answer}"`);
      ctx.syncDisplay();
    }
    return { resultXml: toolResults, blocked: false };
  }

  // ── ask_clarification ──────────────────────────────────────────────────
  // Pauses the run: status → waiting_for_input, the message-stream
  // ClarificationCard replaces the tail spinner, and the loop parks on
  // waitForAnswer until the user replies, dismisses (skip), or the task
  // dies. The answered exchange is folded into the display transcript as a
  // [CLARIFIED] marker so the compact card survives in message history.
  if (call.name === "ask_clarification") {
    const question = typeof call.question === "string" ? call.question : JSON.stringify(call.question ?? "");
    const context = typeof call.context === "string" ? call.context : "";
    const options = Array.isArray(call.options)
      ? call.options.map((o: unknown) => (typeof o === "string" ? o : JSON.stringify(o))).slice(0, 4)
      : [];
    const allowFreeText = call.allow_freetext !== false;

    if (!question) {
      result(`<tool_result name="ask_clarification">error - missing question</tool_result>\n`);
    } else {
      ctx.store.setQuestion(question, options, allowFreeText, { context, kind: "clarification" });
      ctx.setStatus("waiting_for_input", "Waiting for input");
      ctx.syncDisplay();

      const raw = await ctx.waitForAnswer();
      const skipped = raw === CLARIFICATION_SKIP || raw === "(timed out)" || raw === "(task cancelled)";
      if (raw === "(timed out)") ctx.store.answerQuestion(CLARIFICATION_SKIP);
      const answerForModel = (
        skipped ? "User skipped clarification. Make a reasonable assumption and proceed." : raw
      ).replace(/<\/?tool_result[^>]*>/g, "");
      ctx.appendDisplay(
        `[CLARIFIED]:${JSON.stringify({ q: question, ...(context ? { c: context } : {}), a: skipped ? "Skipped" : raw })}\n`
      );
      result(`<tool_result name="ask_clarification">${answerForModel}</tool_result>\n`);
      ctx.setStatus("streaming", "Processing…");
      ctx.syncDisplay();
    }
    return { resultXml: toolResults, blocked: false };
  }

  // ── preview_browser ───────────────────────────────────────────────────
  if (call.name === "preview_browser" && call.url) {
    ctx.setStatus("tool_executing", `Previewing ${call.url}...`);
    emitActivity({ type: "tool", message: `Previewing ${call.url}`, agent: "coder" });
    ctx.appendDisplay(`previewing [${call.url}]\n`);
    ctx.syncDisplay();

    try {
      emitPreview(call.url, "preview_browser");
      const res = await ctxFetch(`${base}/api/agent/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: call.url, action: "fetch" }),
      }, ctx, 15000);
      const data = await res.json();
      if (data.success) {
        result(`<tool_result name="preview_browser" url="${call.url}">success — Title: "${data.title}" | Content-Type: ${data.contentType} | Size: ${data.size} chars | Status: ${data.statusCode}\nThe page is live in the preview panel.</tool_result>\n`);
        ctx.replaceStatus(`[OK] Preview loaded: "${data.title}" (${data.size} chars)`);
      } else {
        result(`<tool_result name="preview_browser" url="${call.url}">error: ${data.error || "Failed to load"}</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] Preview failed: ${data.error || "unknown"}`);
      }
    } catch (err) {
      result(`<tool_result name="preview_browser" url="${call.url}">error: ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Preview failed: ${(err as Error).message}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── verify_app ────────────────────────────────────────────────────────
  if (call.name === "verify_app") {
    if (!ctx.fs.directoryName) {
      result(`<tool_result name="verify_app">error — no local folder is open, so there is no dev server to start. Open a folder (sidebar → Open) and retry, or use preview_browser with an explicit URL.</tool_result>\n`);
      ctx.replaceStatus(`[WARN] verify_app needs an open folder`);
      ctx.syncDisplay();
      return { resultXml: toolResults, blocked: false };
    }

    ctx.setStatus("tool_executing", "Verifying app in headless browser…");
    ctx.appendDisplay(`verifying app [${call.path || "/"}]\n`);
    ctx.syncDisplay();

    try {
      const res = await ctxFetch(`${base}/api/agent/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          devCommand: call.dev_command,
          port: call.port,
          path: call.path || "/",
          interactions: Array.isArray(call.interactions) ? call.interactions : [],
        }),
      }, ctx, 360000);
      const data = await res.json();
      if (data.success && data.result) {
        const r = data.result;
        if (r.error && String(r.error).includes("infrastructure-failure")) {
          result(`<tool_result name="verify_app">infrastructure-failure: the verification harness could not run — this says NOTHING about your app; do not claim pass or fail. ${String(r.error).slice(0, 400)}</tool_result>\n`);
          ctx.replaceStatus(`[WARN] Verification harness failed (infrastructure, not your app)`);
        } else {
          const errors: string[] = r.consoleErrors || [];
          const warnings: string[] = r.consoleWarnings || [];
          const verdict = r.success ? "PASS" : "ISSUES FOUND";
          result(`<tool_result name="verify_app" path="${call.path || "/"}">\nVerdict: ${verdict}\nHTTP status: ${r.httpStatus ?? "?"} | Page: ${r.pageTitle || "?"}\nConsole errors (${errors.length}):${errors.length ? "\n" + errors.slice(0, 5).join("\n") : " none"}\nConsole warnings: ${warnings.length}\n${r.screenshotPath ? `Screenshot: ${r.screenshotPath}\n` : ""}${verdict === "ISSUES FOUND" ? "Fix the errors above with edit_file, then call verify_app again until it reports PASS." : ""}\n</tool_result>\n`);
          ctx.replaceStatus(
            verdict === "PASS"
              ? `[OK] Verified app — no console errors`
              : `[WARN] Verification found ${errors.length} console error(s)`
          );
        }
      } else {
        const rawErr = String(data.error || "verification failed");
        const isInfra = rawErr.includes("infrastructure-failure");
        result(`<tool_result name="verify_app">${isInfra ? "infrastructure-failure: the verification harness itself failed — this says NOTHING about your app; do not claim your app failed or passed. The platform re-verifies automatically." : "error"}: ${rawErr}</tool_result>\n`);
        ctx.replaceStatus(isInfra
          ? `[WARN] Verification harness failed (infrastructure, not your app)`
          : `[FAIL] Verification failed: ${rawErr.slice(0, 60)}`);
      }
    } catch (err) {
      result(`<tool_result name="verify_app">error: ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] Verification error: ${(err as Error).message.slice(0, 60)}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── browser_* (agent's own browser) ───────────────────────────────────
  // Two backends, one tool contract: the Electron desktop shell's dedicated
  // agent view when present (visible to the user), else the server-side
  // Playwright session (/api/agent/browser — SSRF-guarded, ephemeral profile,
  // per-user session with caps). The model sees identical result shapes.
  if (call.name?.startsWith("browser_")) {
    const bridge = (typeof window !== "undefined" ? (window as any).orplexDesktop?.agentBrowser : null) as any;
    if (!bridge) {
      // SERVER FALLBACK — browser as a first-class sensor, no desktop app needed.
      try {
        const opMap: Record<string, { op: string; pick: (c: any) => Record<string, unknown> }> = {
          browser_navigate: { op: "navigate", pick: (c) => ({ url: c.url }) },
          browser_read: { op: "read", pick: () => ({}) },
          browser_click: { op: "click", pick: (c) => ({ selector: c.selector, ref: c.ref }) },
          browser_type: { op: "type", pick: (c) => ({ selector: c.selector, ref: c.ref, text: c.text }) },
          browser_press: { op: "press", pick: (c) => ({ key: c.key }) },
          browser_scroll: { op: "scroll", pick: (c) => ({ dy: typeof c.amount === "number" ? c.amount : 600 }) },
          browser_console: { op: "console", pick: () => ({}) },
          browser_screenshot: { op: "screenshot", pick: (c) => ({ fullPage: !!c.fullPage, viewpoint: c.viewpoint }) },
          browser_find: { op: "find", pick: (c) => ({ text: c.text, role: c.role }) },
          browser_wait_for: { op: "wait_for", pick: (c) => ({ text: c.text, selector: c.selector, time: c.time, timeoutMs: c.timeoutMs }) },
          browser_hover: { op: "hover", pick: (c) => ({ selector: c.selector, ref: c.ref }) },
          browser_select: { op: "select", pick: (c) => ({ selector: c.selector, ref: c.ref, value: c.value }) },
          browser_tabs: { op: "tabs", pick: (c) => ({ tabAction: c.action, url: c.url, index: c.index }) },
          browser_network: { op: "network", pick: () => ({}) },
          browser_evaluate: { op: "evaluate", pick: (c) => ({ code: c.code }) },
        };
        const mapped = opMap[String(call.name)];
        if (!mapped) {
          result(`<tool_result name="${call.name}">error - browser op "${call.name}" is not available in server browser mode.</tool_result>\n`);
          ctx.replaceStatus(`[WARN] ${call.name} unsupported in server browser mode`);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
        ctx.setStatus("tool_executing", `Browser ${mapped.op}…`);
        ctx.syncDisplay();
        const res = await apiFetch("/api/agent/browser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: mapped.op, ...mapped.pick(call) }),
          signal: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
        });
        const r = await res.json().catch(() => ({ ok: false, error: "bad response from browser API" }));
        if (!r.ok) {
          result(`<tool_result name="${call.name}">error - ${r.error || "browser op failed"}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] ${call.name}: ${String(r.error || "failed").slice(0, 60)}`);
          ctx.syncDisplay();
          return { resultXml: toolResults, blocked: false };
        }
        const d = r.data || {};
        switch (mapped.op) {
          case "navigate":
            result(`<tool_result name="browser_navigate" url="${d.url}">success — HTTP ${d.status ?? "?"}, now on "${d.title || d.url}". Use browser_read to see the page content, browser_click/browser_type to interact.</tool_result>\n`);
            ctx.replaceStatus(`[OK] Browser: ${d.title || d.url}`);
            break;
          case "read": {
            const linkList = (d.interactives || []).slice(0, 25).join("\n");
            result(`<tool_result name="browser_read">\nURL: ${d.url}\nTitle: ${d.title}\n\nPAGE TEXT (first 4000 chars):\n${String(d.text || "").slice(0, 4000)}\n\nHEADINGS:\n${(d.headings || []).join("\n")}\n\nINTERACTIVE ELEMENTS (click with browser_click selector):\n${linkList}\n</tool_result>\n`);
            ctx.replaceStatus(`[OK] Read "${d.title}" (${String(d.text || "").length} chars)`);
            break;
          }
          case "click":
            result(`<tool_result name="browser_click" selector="${d.clicked}">success — clicked "${d.clicked}". Page now shows: "${d.title || d.url}". Use browser_read to see the result.</tool_result>\n`);
            ctx.replaceStatus(`[OK] Clicked ${d.clicked}`);
            break;
          case "type":
            result(`<tool_result name="browser_type" selector="${d.typed}">success — typed ${d.length ?? 0} chars into "${d.typed}"</tool_result>\n`);
            ctx.replaceStatus(`[OK] Typed ${d.length ?? 0} chars`);
            break;
          case "press":
            result(`<tool_result name="browser_press" key="${call.key}">success — key sent</tool_result>\n`);
            break;
          case "scroll":
            result(`<tool_result name="browser_scroll">success — scrolled ${d.scrolled}px. Use browser_read to see the new content.</tool_result>\n`);
            break;
          case "console": {
            const msgs = (d.messages || []).map((m: any) => `[${m.type}] ${m.text}`).join("\n");
            result(`<tool_result name="browser_console">${msgs.length ? msgs : "No console messages — no JS errors."}</tool_result>\n`);
            ctx.replaceStatus(`[OK] Console`);
            break;
          }
          case "screenshot": {
            const vp = d.viewport ? ` at ${d.viewport.width}x${d.viewport.height}` : "";
            const shot = await attachScreenshot(ctx, (d as any).screenshot, `browser screenshot — ${d.url || "page"}`);
            result(`<tool_result name="browser_screenshot">success — screenshot captured${d.fullPage ? " (full page)" : ""}${vp} (${d.url}) and attached inline in the chat below. Use browser_read for the text content.</tool_result>\n`);
            ctx.replaceStatus(`[OK] Screenshot captured`);
            if (shot) return { resultXml: toolResults, blocked: false, imageDataUrl: shot };
            break;
          }
          case "find": {
            const list = (d.matches || []).slice(0, 25).map((m: any) => `${m.ref}: ${m.role} "${m.name}" [${m.selector}]${m.enabled ? "" : " (disabled)"}`).join("\n");
            result(`<tool_result name="browser_find">\nMATCHES (${d.matches?.length ?? 0} of ${d.total} actionable elements):\n${list || "none"}\n\n${d.hint || ""}\n</tool_result>\n`);
            ctx.replaceStatus(`[OK] Find: ${d.matches?.length ?? 0} match(es)`);
            break;
          }
          case "wait_for":
            result(`<tool_result name="browser_wait_for">success — condition met after ${d.waitedMs}ms. Now on "${d.title || d.url}".</tool_result>\n`);
            ctx.replaceStatus(`[OK] Wait ${d.waitedMs}ms`);
            break;
          case "hover":
            result(`<tool_result name="browser_hover" selector="${d.hovered}">success — hovered "${d.hovered}". Check browser_screenshot/browser_read for what appeared.</tool_result>\n`);
            ctx.replaceStatus(`[OK] Hovered`);
            break;
          case "select":
            result(`<tool_result name="browser_select" selector="${d.in}">success — selected "${d.selected}" in "${d.in}"</tool_result>\n`);
            ctx.replaceStatus(`[OK] Selected`);
            break;
          case "tabs": {
            const tabs = (d.tabs || []).map((t: any) => `${t.active ? "→" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`).join("\n");
            const head = d.opened !== undefined ? `opened tab [${d.opened}] ${d.url}` : d.switchedTo !== undefined ? `switched to tab [${d.switchedTo}]` : d.closed !== undefined ? `closed tab [${d.closed}]` : `${(d.tabs || []).length} tab(s) open`;
            result(`<tool_result name="browser_tabs">${head}\n${tabs}</tool_result>\n`);
            ctx.replaceStatus(`[OK] Tabs: ${(d.tabs || []).length} open`);
            break;
          }
          case "network": {
            const events = (d.events || []).map((e: any) => `${e.status ? `HTTP ${e.status}` : "ABORTED"} ${e.method} ${e.url}${e.error ? ` (${e.error})` : ""}`).join("\n");
            result(`<tool_result name="browser_network">${events || "No failed requests (no 4xx/5xx responses, no aborted requests)."}</tool_result>\n`);
            ctx.replaceStatus(`[OK] Network: ${d.failedRequests ?? 0} failed`);
            break;
          }
          case "evaluate":
            result(`<tool_result name="browser_evaluate">result: ${d.result}</tool_result>\n`);
            ctx.replaceStatus(`[OK] Evaluated`);
            break;
        }
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      } catch (err) {
        result(`<tool_result name="${call.name}">error - server browser: ${(err as Error).message}</tool_result>\n`);
        ctx.replaceStatus(`[FAIL] ${call.name}`);
        ctx.syncDisplay();
        return { resultXml: toolResults, blocked: false };
      }
    }
    try {
      if (call.name === "browser_navigate" && call.url) {
        ctx.setStatus("tool_executing", `Browsing to ${call.url}…`);
        ctx.appendDisplay(`browsing [${String(call.url).slice(0, 60)}]\n`);
        ctx.syncDisplay();
        // No floating overlay: bridge.show() lifted the agent's WebContentsView
        // over the whole app (stale bounds = a window floating on the chat).
        // Open the right panel on Preview and hand the URL to that panel's
        // EXISTING webview through the preview bus instead — the panel's own
        // URL bar, tabs, loading state and nav buttons drive it from there.
        window.dispatchEvent(new CustomEvent("orplex:open-panel", { detail: { tab: "preview" } }));
        emitPreview(String(call.url), "preview_browser");
        // The agent's own view still loads the page (headless — never shown)
        // so browser_read / browser_click keep working against it.
        const r = await bridge.navigate(String(call.url));
        if (r.ok) {
          result(`<tool_result name="browser_navigate" url="${r.url}">success — now on "${r.title || r.url}". Use browser_read to see the page content.</tool_result>\n`);
          ctx.replaceStatus(`[OK] Browser: ${r.title || r.url}`);
        } else {
          result(`<tool_result name="browser_navigate" url="${call.url}">error - ${r.error || "load failed"}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Browser navigation failed`);
        }
      } else if (call.name === "browser_read") {
        ctx.setStatus("tool_executing", "Reading page…");
        const r = await bridge.read();
        if (r.ok) {
          const elements = await bridge.elements().catch(() => ({ ok: false }));
          const el = elements.ok ? elements : { links: [], buttons: [], inputs: [] };
          const linkList = (el.links || []).slice(0, 25).map((l: any) => `- "${l.text}" → ${l.href}`).join("\n");
          const buttonList = (el.buttons || []).slice(0, 15).map((b: any) => `- "${b.text}"`).join("\n");
          const inputList = (el.inputs || []).slice(0, 15).map((i: any) => `- ${i.tag}${i.name ? `[name=${i.name}]` : ""}${i.placeholder ? ` ("${i.placeholder}")` : ""}`).join("\n");
          result(`<tool_result name="browser_read">\nURL: ${r.url}\nTitle: ${r.title}\n\nPAGE TEXT (first 4000 chars):\n${String(r.text || "").slice(0, 4000)}\n\nHEADINGS:\n${(r.headings || []).join("\n")}\n\nLINKS:\n${linkList}\n\nBUTTONS:\n${buttonList}\n\nINPUTS:\n${inputList}\n</tool_result>\n`);
          ctx.replaceStatus(`[OK] Read "${r.title}" (${String(r.text || "").length} chars)`);
        } else {
          result(`<tool_result name="browser_read">error - ${r.error || "nothing loaded yet — navigate first"}</tool_result>\n`);
        }
      } else if (call.name === "browser_click" && (call.selector || call.ref)) {
        const target = String(call.ref || call.selector);
        ctx.setStatus("tool_executing", `Clicking ${target}…`);
        ctx.appendDisplay(`clicking [${target}]\n`);
        ctx.syncDisplay();
        const r = await bridge.interact({ kind: "click", selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined });
        result(r.ok
          ? `<tool_result name="browser_click" selector="${target}">success — clicked "${r.clicked ?? target}". Use browser_read to see the result.</tool_result>\n`
          : `<tool_result name="browser_click" selector="${target}">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Clicked ${target}` : `[FAIL] Click: ${r.error}`);
      } else if (call.name === "browser_type" && (call.selector || call.ref) && call.text !== undefined) {
        const target = String(call.ref || call.selector);
        const r = await bridge.interact({ kind: "type", selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined, text: String(call.text) });
        result(r.ok
          ? `<tool_result name="browser_type" selector="${target}">success — typed "${String(call.text).slice(0, 50)}" into "${r.typed ?? target}"</tool_result>\n`
          : `<tool_result name="browser_type" selector="${target}">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Typed ${String(call.text).length} chars` : `[FAIL] Type: ${r.error}`);
      } else if (call.name === "browser_press" && call.key) {
        const r = await bridge.interact({ kind: "press", key: String(call.key) });
        result(r.ok
          ? `<tool_result name="browser_press" key="${call.key}">success — key sent</tool_result>\n`
          : `<tool_result name="browser_press">error - ${r.error}</tool_result>\n`);
      } else if (call.name === "browser_scroll") {
        const r = await bridge.interact({ kind: "scroll", amount: typeof call.amount === "number" ? call.amount : 600 });
        result(`<tool_result name="browser_scroll">success — scrolled ${r.scrolled}px. Use browser_read to see the new content.</tool_result>\n`);
      } else if (call.name === "browser_console") {
        const r = await bridge.console();
        const msgs = (r.messages || []).map((m: any) => `[${m.level}] ${m.text}`).join("\n");
        result(`<tool_result name="browser_console">${msgs.length ? msgs : "No console messages since last navigation — no JS errors."}</tool_result>\n`);
        ctx.replaceStatus(`[OK] Console: ${(r.messages || []).length} message(s)`);
      } else if (call.name === "browser_screenshot") {
        ctx.setStatus("tool_executing", "Capturing browser…");
        ctx.syncDisplay();
        // Never bridge.show() — that attached the agent view above the app.
        // Ask the panel to display it as a tab instead (in-panel only).
        window.dispatchEvent(new CustomEvent("orplex:agent-browser-tab"));
        const d = await bridge.screenshot({ fullPage: !!call.fullPage, viewpoint: call.viewpoint });
        const vp = d?.viewport ? ` at ${d.viewport.width}x${d.viewport.height}` : "";
        const shot = await attachScreenshot(ctx, (d as any)?.screenshot, `browser screenshot — ${d?.url ?? "page"}`);
        result(`<tool_result name="browser_screenshot">success — screenshot captured${d?.fullPage ? " (full page)" : ""}${vp} (${d?.url ?? ""}) and attached inline in the chat below. The live view is shown in the preview panel; use browser_read for the text content.</tool_result>\n`);
        ctx.replaceStatus(`[OK] Screenshot captured`);
        ctx.syncDisplay();
        if (shot) return { resultXml: toolResults, blocked: false, imageDataUrl: shot };
      } else if (call.name === "browser_evaluate" && call.code) {
        const r = await bridge.evaluate(String(call.code));
        result(r.ok
          ? `<tool_result name="browser_evaluate">result: ${JSON.stringify(r.result)?.slice(0, 2000)}</tool_result>\n`
          : `<tool_result name="browser_evaluate">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Evaluated` : `[FAIL] Evaluate: ${r.error}`);
      } else if (call.name === "browser_find") {
        ctx.setStatus("tool_executing", "Finding elements…");
        ctx.syncDisplay();
        const r = await bridge.find({ text: call.text, role: call.role });
        if (!r.ok) {
          result(`<tool_result name="browser_find">error - ${r.error}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Find: ${r.error}`);
        } else {
          const list = (r.matches || []).slice(0, 25).map((m: any) => `${m.ref}: ${m.role} "${m.name}" [${m.selector}]${m.enabled ? "" : " (disabled)"}`).join("\n");
          result(`<tool_result name="browser_find">\nMATCHES (${r.matches?.length ?? 0} of ${r.total} actionable elements):\n${list || "none"}\n\n${r.hint || ""}\n</tool_result>\n`);
          ctx.replaceStatus(`[OK] Find: ${r.matches?.length ?? 0} match(es)`);
        }
      } else if (call.name === "browser_wait_for" && (call.text !== undefined || call.selector || call.time !== undefined)) {
        ctx.setStatus("tool_executing", "Waiting…");
        ctx.syncDisplay();
        const r = await bridge.waitFor({ text: call.text, selector: call.selector, time: call.time, timeoutMs: call.timeoutMs });
        result(r.ok
          ? `<tool_result name="browser_wait_for">success — condition met after ${r.waitedMs}ms. Now on "${r.title || r.url}".</tool_result>\n`
          : `<tool_result name="browser_wait_for">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Wait ${r.waitedMs}ms` : `[FAIL] Wait: ${r.error}`);
      } else if (call.name === "browser_hover" && (call.selector || call.ref)) {
        const r = await bridge.hover({ selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined });
        result(r.ok
          ? `<tool_result name="browser_hover" selector="${r.hovered ?? (call.ref || call.selector)}">success — hovered. Check browser_screenshot/browser_read for what appeared.</tool_result>\n`
          : `<tool_result name="browser_hover">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Hovered` : `[FAIL] Hover: ${r.error}`);
      } else if (call.name === "browser_select" && call.value !== undefined && (call.selector || call.ref)) {
        const r = await bridge.select({ selector: call.selector ? String(call.selector) : undefined, ref: call.ref ? String(call.ref) : undefined, value: String(call.value) });
        result(r.ok
          ? `<tool_result name="browser_select" selector="${call.ref || call.selector}">success — selected "${r.selected}"${r.label ? ` (${r.label})` : ""}</tool_result>\n`
          : `<tool_result name="browser_select">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Selected` : `[FAIL] Select: ${r.error}`);
      } else if (call.name === "browser_tabs") {
        ctx.setStatus("tool_executing", "Tabs…");
        ctx.syncDisplay();
        const r = await bridge.tabs({ action: call.action, url: call.url, index: call.index });
        if (!r.ok) {
          result(`<tool_result name="browser_tabs">error - ${r.error}</tool_result>\n`);
          ctx.replaceStatus(`[FAIL] Tabs: ${r.error}`);
        } else {
          const tabs = (r.tabs || []).map((t: any) => `${t.active ? "→" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`).join("\n");
          const head = r.opened !== undefined ? `opened tab [${r.opened}] ${r.url}` : r.switchedTo !== undefined ? `switched to tab [${r.switchedTo}]` : r.closed !== undefined ? `closed tab [${r.closed}]` : `${(r.tabs || []).length} tab(s) open`;
          result(`<tool_result name="browser_tabs">${head}\n${tabs}</tool_result>\n`);
          ctx.replaceStatus(`[OK] Tabs: ${(r.tabs || []).length} open`);
          if (r.opened !== undefined || r.switchedTo !== undefined) {
            // In-panel display only — never lift the view over the app.
            window.dispatchEvent(new CustomEvent("orplex:agent-browser-tab"));
          }
        }
      } else if (call.name === "browser_network") {
        const r = await bridge.network();
        const events = (r.events || []).map((e: any) => `${e.status ? `HTTP ${e.status}` : "ABORTED"} ${e.method} ${e.url}${e.error ? ` (${e.error})` : ""}`).join("\n");
        result(`<tool_result name="browser_network">${events || "No failed requests (no 4xx/5xx responses, no aborted requests)."}</tool_result>\n`);
        ctx.replaceStatus(`[OK] Network: ${r.failedRequests ?? 0} failed`);
      } else {
        result(`<tool_result name="${call.name}">error - missing required argument (url/selector/ref/key/code/value)</tool_result>\n`);
      }
    } catch (err) {
      result(`<tool_result name="${call.name}">error - ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] ${call.name}: ${(err as Error).message.slice(0, 60)}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── Unknown / not-implemented tool ────────────────────────────────────
    result(`<tool_result name="${call.name || "unknown"}">error — this tool is not available in this environment. Use one of: read_file, list_files, write_file, write_file_chunk, edit_file, batch_edit, search_code, code_search, run_command, run_in_sandbox, undo_last_change, take_screenshot, todo_list, ask_question, ask_clarification, scratchpad_update, preview_browser, verify_app, web_search, or browser_* tools.</tool_result>\n`);
  ctx.replaceStatus(`[WARN] Tool "${call.name}" is not available here`);
  ctx.syncDisplay();
  return { resultXml: toolResults, blocked: false };
}

function truncate(output: string, cap: number): string {
  return output.length > cap ? output.slice(0, cap) + "\n... [truncated]" : output;
}
