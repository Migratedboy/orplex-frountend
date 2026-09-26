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
} from "../tool-text";
import { recordFailure } from "../failure-memory";
import { emitActivity, emitPreview } from "../agent-events";
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
    setQuestion(question: string, options: string[], allowFreeText: boolean): void;
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

export async function dispatchToolCall(
  call: ToolCall,
  ctx: ToolContext
): Promise<DispatchOutcome> {
  let toolResults = "";
  const result = (xml: string) => {
    toolResults += xml;
  };

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
      ctx.appendDisplay(`read [${call.path}] (cached — already read ${readCount}×)\n`);
      return { resultXml: toolResults, blocked: false };
    }

    ctx.readFiles.set(call.path, readCount + 1);
    ctx.setStatus("tool_executing", `Reading ${call.path}…`);
    emitActivity({ type: "tool", message: `Reading ${call.path}`, agent: "coder" });
    ctx.appendDisplay(`analysing [${call.path}]\n`);
    ctx.syncDisplay();

    const content = (await ctx.fs.readFile?.(call.path)) || "(file not available)";
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
      const prevContent = await ctx.fs.readFile?.(call.path).catch(() => null);
      const existed = !!prevContent && !prevContent.startsWith("[Error");
      if (existed) {
        ctx.setStatus("awaiting_approval", `Waiting for approval: overwrite ${call.path}`);
        ctx.appendDisplay(`overwriting [${call.path}] — awaiting approval\n`);
        ctx.syncDisplay();
        const approved = await requestApproval(
          "write_file",
          `Overwrite ${call.path} (${lineCount} lines)`,
          { path: call.path, existed },
          computeDiff(prevContent!, call.content)
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
    const editDiff = computeDiff(call.old_text, call.new_text);
    const editRisk = classifyRisk("edit_file", { path: call.path, old_text: call.old_text, new_text: call.new_text });
    let approved = true;
    if (!editRisk.autoApprovable) {
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

    if (isServerCommand(call.command)) {
      // SERVER LANE: dev/preview servers never exit — run detached.
      try {
        const serveRes = await ctxFetch("/api/agent/serve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start", command: call.command }),
        }, ctx);
        const serveData = await serveRes.json();
        if (serveData.ok) {
          ctx.stats.commandRun();
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

    // Execute via server-side API (child_process can't run in the browser)
    try {
      const execRes = await ctxFetch("/api/agent/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: call.command }),
      }, ctx);
      const execData = await execRes.json();
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
        result(`<tool_result name="take_screenshot" url="${call.url}">success - screenshot captured (${data.width || 1280}x${data.height || 720}). Page opened in the live preview panel.</tool_result>\n`);
        ctx.replaceStatus(`[OK] Screenshot captured: ${call.url} (shown in live preview)`);
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
          browser_click: { op: "click", pick: (c) => ({ selector: c.selector }) },
          browser_type: { op: "type", pick: (c) => ({ selector: c.selector, text: c.text }) },
          browser_press: { op: "press", pick: (c) => ({ key: c.key }) },
          browser_scroll: { op: "scroll", pick: (c) => ({ dy: typeof c.amount === "number" ? c.amount : 600 }) },
          browser_console: { op: "console", pick: () => ({}) },
          browser_screenshot: { op: "screenshot", pick: () => ({}) },
        };
        const mapped = opMap[String(call.name)];
        if (!mapped) {
          result(`<tool_result name="${call.name}">error - browser_evaluate is not available in server browser mode; use browser_read or browser_screenshot instead.</tool_result>\n`);
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
            result(`<tool_result name="browser_click" selector="${call.selector}">success — clicked. Page now shows: "${d.title || d.url}". Use browser_read to see the result.</tool_result>\n`);
            ctx.replaceStatus(`[OK] Clicked`);
            break;
          case "type":
            result(`<tool_result name="browser_type" selector="${call.selector}">success — typed ${d.length ?? 0} chars</tool_result>\n`);
            ctx.replaceStatus(`[OK] Typed`);
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
          case "screenshot":
            result(`<tool_result name="browser_screenshot">success — screenshot captured (${d.url}). Use browser_read for the text content.</tool_result>\n`);
            ctx.replaceStatus(`[OK] Screenshot captured`);
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
        await bridge.show().catch(() => {});
        window.dispatchEvent(new CustomEvent("orplex:agent-browser-tab"));
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
      } else if (call.name === "browser_click" && call.selector) {
        ctx.setStatus("tool_executing", `Clicking ${call.selector}…`);
        ctx.appendDisplay(`clicking [${call.selector}]\n`);
        ctx.syncDisplay();
        const r = await bridge.interact({ kind: "click", selector: String(call.selector) });
        result(r.ok
          ? `<tool_result name="browser_click" selector="${call.selector}">success — clicked "${r.clicked}". Use browser_read to see the result.</tool_result>\n`
          : `<tool_result name="browser_click" selector="${call.selector}">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Clicked` : `[FAIL] Click: ${r.error}`);
      } else if (call.name === "browser_type" && call.selector && call.text !== undefined) {
        const r = await bridge.interact({ kind: "type", selector: String(call.selector), text: String(call.text) });
        result(r.ok
          ? `<tool_result name="browser_type" selector="${call.selector}">success — typed "${String(call.text).slice(0, 50)}"</tool_result>\n`
          : `<tool_result name="browser_type" selector="${call.selector}">error - ${r.error}</tool_result>\n`);
        ctx.replaceStatus(r.ok ? `[OK] Typed` : `[FAIL] Type: ${r.error}`);
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
        await bridge.screenshot();
        result(`<tool_result name="browser_screenshot">success — the current page is shown live in the preview panel (the user can see it). Use browser_read for the text content.</tool_result>\n`);
        ctx.replaceStatus(`[OK] Screenshot shown in preview`);
      } else if (call.name === "browser_evaluate" && call.code) {
        const r = await bridge.evaluate(String(call.code));
        result(r.ok
          ? `<tool_result name="browser_evaluate">result: ${JSON.stringify(r.result)?.slice(0, 2000)}</tool_result>\n`
          : `<tool_result name="browser_evaluate">error - ${r.error}</tool_result>\n`);
      } else {
        result(`<tool_result name="${call.name}">error - missing required argument (url/selector/key/code)</tool_result>\n`);
      }
    } catch (err) {
      result(`<tool_result name="${call.name}">error - ${(err as Error).message}</tool_result>\n`);
      ctx.replaceStatus(`[FAIL] ${call.name}: ${(err as Error).message.slice(0, 60)}`);
    }
    ctx.syncDisplay();
    return { resultXml: toolResults, blocked: false };
  }

  // ── Unknown / not-implemented tool ────────────────────────────────────
  result(`<tool_result name="${call.name || "unknown"}">error — this tool is not available in this environment. Use one of: read_file, list_files, write_file, write_file_chunk, edit_file, batch_edit, search_code, run_command, run_in_sandbox, undo_last_change, take_screenshot, todo_list, ask_question, preview_browser, verify_app, web_search, or browser_* tools.</tool_result>\n`);
  ctx.replaceStatus(`[WARN] Tool "${call.name}" is not available here`);
  ctx.syncDisplay();
  return { resultXml: toolResults, blocked: false };
}

function truncate(output: string, cap: number): string {
  return output.length > cap ? output.slice(0, cap) + "\n... [truncated]" : output;
}
