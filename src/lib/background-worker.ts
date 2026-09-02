// background-worker.ts — Runs the tool-calling loop in the background
// Not tied to any React component — survives page navigation
// Features: file deduplication, loop detection, line range display

import { recordChange, computeDiff } from "./file-history";
import { analyzeCodeQuality, analyzeProjectQuality } from "./code-quality-checker";
import { withRetry, isRateLimitError } from "./rate-limit-retry";
import { quickQualityCheck } from "./reflection-loop";
import { retrievePatterns } from "./rag-retriever";
import { ENHANCED_SYSTEM_PROMPT } from "./enhanced-system-prompt";
import { requestApproval } from "./approval-store";
import { classifyRisk } from "./risk-classifier";
import { virtualFS } from "./virtual-fs";
import { beforeToolCall, afterToolCall, onFileWrite, onFileEdit, onTaskStart, onTaskComplete, onTaskFail } from "./plugins/registry";
import { initializePlugins, isPluginEnabled } from "./plugins/initializer";
import { TIMEOUTS, LIMITS, isBlockedCommand } from "./constants";
import { readStream, deduplicateWords, replaceLastStatus, parseToolCalls, type ToolCall, type StreamResult } from "./stream-reader";
import { emitStatus, emitActivity, emitPreview } from "./agent-events";

let _pluginsInitialized = false;
import {
  startTask,
  updateTaskStatus,
  setDisplayContent,
  appendToDisplayContent,
  completeTask,
  failTask,
  isCurrentTask,
  getCurrentTask,
  setTodos,
  completeTodo,
  clearTodos,
  setQuestion,
  answerQuestion,
  bumpStat,
  setFilesChanged,
  type ChatMessage,
} from "./background-chat";

// Types re-exported from stream-reader.ts: ToolCall, StreamResult

// Re-export event functions so existing imports from background-worker still work
export { onPreviewEvent, onAgentStatus } from "./agent-events";
export type { PreviewEvent } from "./agent-events";
// === Filesystem access ===

let _readFile: ((path: string) => Promise<string>) | null = null;
let _writeFile: ((path: string, content: string) => Promise<boolean>) | null = null;
let _editFile: ((path: string, oldText: string, newText: string) => Promise<boolean>) | null = null;
let _fileTree: any[] = [];
let _fileContents: Record<string, string> = {};
let _directoryName = "";

export function setFileSystemAccess(
  readFile: (path: string) => Promise<string>,
  writeFile: (path: string, content: string) => Promise<boolean>,
  editFile: (path: string, oldText: string, newText: string) => Promise<boolean>,
  fileTree: any[],
  fileContents: Record<string, string>,
  directoryName: string
) {
  _readFile = readFile;
  _writeFile = writeFile;
  _editFile = editFile;
  _fileTree = fileTree;
  _fileContents = fileContents;
  _directoryName = directoryName;
}

function listFilesUnderPath(path: string): string {
  const results: string[] = [];
  const walk = (ns: any[]) => {
    for (const n of ns) {
      if (n.kind === "file" && (path === "" || path === "." || n.path.startsWith(path))) {
        results.push(n.path);
      }
      if (n.kind === "directory" && n.children) walk(n.children);
    }
  };
  walk(_fileTree);
  return results.length > 0 ? results.join("\n") : "No files found at that path.";
}

function searchCode(query: string): string {
  const results: string[] = [];
  const maxResults = 20;
  for (const [filePath, content] of Object.entries(_fileContents)) {
    if (results.length >= maxResults) break;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query.toLowerCase())) {
        results.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results.length > 0 ? results.join("\n") : `No matches found for "${query}"`;
}

// readStream is imported from stream-reader.ts
// Tool calls are returned as part of StreamResult.toolCalls

// === Build workspace context ===

async function buildContext(userMessage: string): Promise<string> {
  // Use M3-aware context builder — leverages 1M token context window
  const { buildM3Context } = await import("./context-builder");
  const { context } = buildM3Context(_fileTree, _fileContents, userMessage, _directoryName);
  return context;
}

// === File content preview (for status display) ===

function getContentPreview(content: string, maxLines: number = 3): string {
  const lines = content.split("\n").filter(l => l.trim());
  const preview = lines.slice(0, maxLines).join(" ").slice(0, 80);
  return preview + (lines.length > maxLines ? "…" : "");
}

// === Main background loop ===

const MAX_TOOL_TURNS = Infinity; // Unlimited — smart loop detection (MAX_SAME_TOOL, MAX_TOTAL_WRITES) prevents infinite loops
const MAX_DUPLICATE_READS = 3; // Stop if same file read more than this many times
const MAX_SAME_TOOL = 5; // Stop if same tool called more than this many times in a row
const MAX_TOTAL_WRITES = 15; // Safety cap on total file writes per task

// === Complexity detection — auto-route complex tasks to multi-agent ===
function isComplexTask(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  // Multi-file / full-project requests
  const complexPatterns = /(build|create|make|generate|implement|develop|scaffold|setup|set up)\b.*\b(full|complete|production|entire|whole|complex|multi|enterprise|website|app|application|dashboard|platform|system)\b/i;
  // Explicit multi-agent trigger
  const multiAgentTrigger = /\b(multi.?agent|@multi|@agents|orchestrat|parallel)\b/i;
  // Very long prompts with multiple requirements
  const hasMultipleRequirements = userMessage.split(/\n|\.|;|\band\b/).filter(s => s.trim().length > 10).length >= 5;
  return complexPatterns.test(userMessage) || multiAgentTrigger.test(userMessage) || hasMultipleRequirements;
}

export async function runInBackground(
  userMessage: string,
  conversationId: string | null,
  priorMessages: ChatMessage[],
  mode: string = "ask",
  imageDataUrls: string[] = []
) {
  // Clear any stale task before starting a new one
  const existing = await import("./background-chat").then(m => m.getCurrentTask());
  if (existing && existing.status !== "done" && existing.status !== "error") {
    const { cancelTask } = await import("./background-chat");
    cancelTask();
  }

  // === AUTO-ROUTE: Complex tasks go to multi-agent system ===
  if (isComplexTask(userMessage) && mode !== "ask") {
    console.log("[MULTI-AGENT] Auto-routing complex task:", userMessage.slice(0, 100));
    return runMultiAgentBackground(userMessage, conversationId, priorMessages);
  }

  // Only add workspace context to the FIRST message (no prior messages)
  const isFirstMessage = priorMessages.length === 0;
  let contentWithFiles = userMessage;
  if (isFirstMessage) {
    try {
      contentWithFiles = await buildContext(userMessage);
    } catch {}
  }

  const userMsg: ChatMessage = {
    role: "user",
    content: userMessage,
    time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };

  const allMessages = [...priorMessages, userMsg];
  const taskId = startTask(conversationId, userMessage, allMessages);

  // Initialize plugins once
  if (!_pluginsInitialized) {
    _pluginsInitialized = true;
    initializePlugins().catch(() => {});
  }

  // Fire plugin hooks
  onTaskStart(userMessage).catch(() => {});

  // Build API messages — first user msg gets workspace context, rest stay plain
  let apiMessages: { role: string; content: string }[] = allMessages.map((m, idx) => {
    const isFirstUser = idx === 0 && m.role === "user" && isFirstMessage;
    return { role: m.role, content: isFirstUser ? contentWithFiles : m.content };
  });

  let lastStreamedContent = "";
  let fullDisplayContent = "";

  // === Loop detection state ===
  const readFiles = new Map<string, number>(); // path → count of times read
  const readResults = new Map<string, string>(); // path → content preview
  const toolCounts = new Map<string, number>(); // tool name → count of times called
  let turnsWithTools = 0;
  let hasShownText = false;
  let totalWrites = 0;

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      updateTaskStatus("streaming", turn === 0 ? "Thinking…" : "Processing…");

      // Emit structured status for frontend progress display
      emitStatus({
        type: "step",
        agent: turn === 0 ? "coordinator" : "coder",
        label: turn === 0 ? "Analyzing request…" : `Processing turn ${turn + 1}…`,
        status: "active",
      });

      let thinkingDisplay = "";
      const streamResult = await readStream(
        apiMessages,
        conversationId,
        {
          onChunk: (content) => {
            setDisplayContent(fullDisplayContent + content);
          },
          onThinking: (thinking) => {
            // Display M3 thinking in real-time
            thinkingDisplay += thinking;
            setDisplayContent(fullDisplayContent + `\n[THINKING] ${thinkingDisplay}\n`);
            // Emit thinking activity
            emitActivity({ type: "thinking", message: thinking.slice(-80) });
          },
        },
        mode,
        imageDataUrls
      );

      const streamedContent = streamResult.content;
      if (!streamedContent && streamResult.toolCalls.length === 0) {
        // Empty response — set minimal content so message isn't stuck on "Thinking..."
        if (!fullDisplayContent.trim()) {
          fullDisplayContent = "*No response from the model. Try again.*";
        }
        break;
      }
      lastStreamedContent = streamedContent || "";

      // Use native tool calls from stream, fall back to XML parsing
      const rawToolCalls = streamResult.toolCalls.length > 0
        ? streamResult.toolCalls
        : parseToolCalls(streamedContent || "");
      // Detect truncated tool calls (missing required args due to token limit)
      const truncatedCalls = rawToolCalls.filter(tc => {
        if (tc.name === 'write_file' && (!tc.path || tc.content === undefined)) return true;
        if (tc.name === 'edit_file' && (!tc.path || !tc.old_text || !tc.new_text)) return true;
        if (tc.name === 'read_file' && !tc.path) return true;
        return false;
      });
      const toolCalls = rawToolCalls.filter(tc => !truncatedCalls.includes(tc));
      const textOnly = (streamedContent || "").replace(/[<]tool_call[\s\S]*?[<]\/tool_call[>]/g, "").trim();

      // === TRUNCATION DETECTION: Auto-continue if tool calls were truncated ===
      if (truncatedCalls.length > 0 && toolCalls.length === 0) {
        // All tool calls were truncated — send a continue message
        const truncatedPaths = truncatedCalls.map(tc => tc.path || 'unknown').join(', ');
        fullDisplayContent += `[Truncated: ${truncatedPaths} — continuing...]\n`;
        setDisplayContent(fullDisplayContent);
        apiMessages.push({ role: "assistant", content: streamedContent || "" });
        apiMessages.push({ role: "user", content: `Continue where you left off. The previous response was truncated. ${truncatedCalls[0]?.path ? `Complete the file: ${truncatedCalls[0].path}` : 'Please try again with shorter chunks.'}` });
        continue; // Skip to next turn instead of breaking
      }

      // === STOP: No valid tool calls => final answer ===
      if (toolCalls.length === 0) {
        // AUTO-RETRY: If user asked to build/create/make something, force tool usage
        const buildKeywords = /build|create|make|generate|write|code|develop|implement|set up|set up/i;
        const userWantsFiles = userMessage && buildKeywords.test(userMessage);
        const hasTextResponse = textOnly.length > 20;
        const alreadyRetried = apiMessages.some(m => m.role === "user" && m.content?.includes("[FORCE TOOLS]"));

        if (userWantsFiles && hasTextResponse && !alreadyRetried) {
          // M3 described what it would do but didn't use tools — force it
          fullDisplayContent += textOnly + "\n\n";
          apiMessages.push({ role: "assistant", content: streamedContent || "" });
          apiMessages.push({ role: "user", content: "[FORCE TOOLS] You described the plan but did not create any files. You MUST use the write_file tool NOW to create the actual files. Do NOT describe code — WRITE IT using write_file tool calls. Create each file one by one. For HTML sites: write_file({path: \"index.html\", content: \"<!DOCTYPE html>...\"})" });
          continue; // Retry with forced tool usage
        }

        fullDisplayContent += streamedContent || "";
        break;
      }

      // M3 outputs text AND tool calls together — execute the tools, show the text
      // (Previously this broke the loop — tools were never executed)

      // === STOP: Smart loop detection ===
      turnsWithTools++;

      // Track tool usage for deduplication
      for (const call of toolCalls) {
        toolCounts.set(call.name, (toolCounts.get(call.name) || 0) + 1);
        if (call.name === "write_file" || call.name === "edit_file") totalWrites++;
      }

      // Stop if: too many consecutive tool-only turns, same tool looping, or too many writes
      const dominantTool = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1])[0];
      const isLooping = dominantTool && dominantTool[1] >= MAX_SAME_TOOL && toolCalls.length === 1;
      if (turnsWithTools >= MAX_TOOL_TURNS - 2 || isLooping || totalWrites >= MAX_TOTAL_WRITES) {
        const reason = isLooping
          ? `Looping on ${dominantTool![0]} (${dominantTool![1]}x)`
          : totalWrites >= MAX_TOTAL_WRITES
            ? `Too many file writes (${totalWrites})`
            : `Reached ${turnsWithTools} tool turns`;
        fullDisplayContent += textOnly || `\n*[Stopped — ${reason}]*\n`;
        break;
      }

      if (textOnly) fullDisplayContent += textOnly + "\n\n";

      // === Execute tools with deduplication ===
      let toolResults = "";
      let skippedDueToDup = false;

      for (const call of toolCalls) {
        // === PLUGIN HOOK: beforeToolCall ===
        const pluginArgs = await beforeToolCall(call.name, call as any).catch(() => call as any);
        if (!pluginArgs || pluginArgs._blocked) {
          toolResults += `<tool_result name="${call.name}">BLOCKED by plugin</tool_result>\n`;
          continue;
        }

        if (call.name === "read_file" && call.path) {
          const readCount = readFiles.get(call.path) || 0;

          // === DEDUP: Skip if already read enough times ===
          if (readCount >= MAX_DUPLICATE_READS) {
            skippedDueToDup = true;
            // Return cached preview instead of re-reading
            const preview = readResults.get(call.path) || "(already read)";
            toolResults += `<tool_result name="read_file" path="${call.path}">\n[Already read ${readCount} times — showing cached summary]\n${preview}\n</tool_result>\n`;
            fullDisplayContent += `read [${call.path}] (cached — already read ${readCount}×)\n`;
            continue;
          }

          // === Read the file ===
          readFiles.set(call.path, readCount + 1);
          updateTaskStatus("tool_executing", `Reading ${call.path}…`); emitActivity({ type: "tool", message: `Reading ${call.path}`, agent: "coder" });
          fullDisplayContent += `analysing [${call.path}]\n`;
          setDisplayContent(fullDisplayContent);

          const content = await _readFile?.(call.path) || "(file not available)";
          const contentLength = content.length;
          const lineCount = content.split("\n").length;

          // Cache the result
          readResults.set(call.path, getContentPreview(content, 5));
          toolResults += `<tool_result name="read_file" path="${call.path}">\n${content}\n</tool_result>\n`;

          // Show line range in status
          fullDisplayContent = replaceLastStatus(
            fullDisplayContent,
            `[OK] Read \`${call.path}\` (lines 1–${lineCount}, ${contentLength} chars)`
          );
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "list_files") {
          updateTaskStatus("tool_executing", `Listing ${call.path || "."}…`); emitActivity({ type: "tool", message: `Listing ${call.path || "."}`, agent: "coder" });
          fullDisplayContent += `analysing [${call.path || "."}]\n`;
          setDisplayContent(fullDisplayContent);

          const listing = listFilesUnderPath(call.path || "");
          const fileCount = listing.split("\n").length;
          toolResults += `<tool_result name="list_files" path="${call.path || "."}">\n${listing}\n</tool_result>\n`;
          fullDisplayContent = replaceLastStatus(fullDisplayContent, `[SUCCESS] Listed ${fileCount} file(s) in \`${call.path || "."}\``);
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "write_file" && call.path && call.content !== undefined) {
          updateTaskStatus("tool_executing", `Writing ${call.path}...`);
          emitActivity({ type: "file", message: `Creating ${call.path}`, agent: "coder" });
          fullDisplayContent += `writing [${call.path}]\n`;
          setDisplayContent(fullDisplayContent);

          const lineCount = call.content.split("\n").length;
          let success = false;

          if (_writeFile) {
            // Real filesystem — write to the open folder
            const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
            const hasPrev = prevContent && !prevContent.startsWith("[Error");
            recordChange(call.path, hasPrev ? prevContent : null, call.content);
            success = await _writeFile(call.path, call.content);
          } else {
            // No folder open — write to virtual filesystem
            success = virtualFS.writeFile(call.path, call.content);
          }
          if (success) {
            bumpStat("toolCalls");
            setFilesChanged(totalWrites + 1);
          }

          toolResults += `<tool_result name="write_file" path="${call.path}">${success ? "success" : "error"}</tool_result>\n`;
          fullDisplayContent = replaceLastStatus(
            fullDisplayContent,
            success
              ? `[SUCCESS] Wrote \`${call.path}\` (${lineCount} lines)`
              : `[ERROR] Failed to write \`${call.path}\``
          );
          setDisplayContent(fullDisplayContent);

          // === PLUGIN HOOK: onFileWrite ===
          if (success) onFileWrite(call.path, call.content).catch(() => {});

        } else if (call.name === "write_file_chunk" && call.path && call.content !== undefined && _writeFile && _readFile) {
          updateTaskStatus("tool_executing", `Appending to ${call.path}...`); emitActivity({ type: "file", message: `Appending to ${call.path}`, agent: "coder" });
          fullDisplayContent += `appending [${call.path}]\n`;
          setDisplayContent(fullDisplayContent);

          // Read existing content, append the chunk, write back
          const existing = await _readFile(call.path).catch(() => "");
          const newContent = (existing || "") + call.content;
          const chunkLines = call.content.split("\n").length;
          const totalLines = newContent.split("\n").length;
          const success = await _writeFile(call.path, newContent);
          toolResults += `<tool_result name="write_file_chunk" path="${call.path}">${success ? `appended ${chunkLines} lines (total: ${totalLines} lines)` : "error"}</tool_result>\n`;
          fullDisplayContent = replaceLastStatus(
            fullDisplayContent,
            success
              ? `[SUCCESS] Appended ${chunkLines} lines to \`${call.path}\` (total: ${totalLines} lines)`
              : `[ERROR] Failed to append to \`${call.path}\``
          );
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text && _editFile) {
          updateTaskStatus("awaiting_approval", `Waiting for approval: edit ${call.path}`);
          fullDisplayContent += `editing [${call.path}] — awaiting approval\n`;
          setDisplayContent(fullDisplayContent);

          const editDiff = computeDiff(call.old_text, call.new_text);

          // Risk-tiered approvals: low-risk edits run without interrupting the user
          const editRisk = classifyRisk("edit_file", { path: call.path, old_text: call.old_text, new_text: call.new_text });
          let approved = true;
          if (!editRisk.autoApprovable) {
            approved = await requestApproval(
              "edit_file",
              `Edit ${call.path}`,
              { path: call.path, old_text: call.old_text, new_text: call.new_text },
              editDiff
            );
          }

          if (!approved) {
            bumpStat("rejectedActions");
            toolResults += `<tool_result name="edit_file" path="${call.path}">rejected by user</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Edit \`${call.path}\` — rejected`);
            setDisplayContent(fullDisplayContent);
          } else {
            updateTaskStatus("tool_executing", `Editing ${call.path}...`);
            const success = await _editFile(call.path, call.old_text, call.new_text);
            if (success) {
              bumpStat("toolCalls");
              setFilesChanged(totalWrites + 1);
            }
            toolResults += `<tool_result name="edit_file" path="${call.path}">${success ? "success — verify changes with read_file" : "error: text not found"}</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(
              fullDisplayContent,
              success
                ? `[SUCCESS] Edited \`${call.path}\``
                : `[FAIL] Failed to edit \`${call.path}\` — text not found`
            );
            // === PLUGIN HOOK: onFileEdit ===
            if (success) onFileEdit(call.path, call.old_text, call.new_text).catch(() => {});
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "batch_edit" && Array.isArray(call.edits)) {
          const edits = call.edits as { path: string; old_text: string; new_text: string }[];
          updateTaskStatus("awaiting_approval", `Waiting for approval: batch edit ${edits.length} file(s)`);
          fullDisplayContent += `batch editing [${edits.length} files] — awaiting approval\n`;
          setDisplayContent(fullDisplayContent);

          // Build combined diff for approval
          const diffs = edits.map(e => `--- ${e.path}\n+++ ${e.path}\n${computeDiff(e.old_text, e.new_text)}`).join("\n\n");
          // Risk-tiered: batch edits are at least medium (multiple files at once)
          const batchRisk = edits.some(e => classifyRisk("edit_file", e).level === "high")
            ? { level: "high" as const, autoApprovable: false }
            : { level: "medium" as const, autoApprovable: false };
          let approved = true;
          if (!batchRisk.autoApprovable) {
            approved = await requestApproval(
              "edit_file",
              `Batch edit ${edits.length} file(s)`,
              { edits },
              diffs
            );
          }

          if (!approved) {
            bumpStat("rejectedActions");
            toolResults += `<tool_result name="batch_edit">rejected by user</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Batch edit rejected`);
          } else {
            let successCount = 0;
            let failCount = 0;
            for (const edit of edits) {
              if (_editFile) {
                const ok = await _editFile(edit.path, edit.old_text, edit.new_text);
                if (ok) successCount++; else failCount++;
              }
            }
            if (successCount > 0) {
              bumpStat("toolCalls");
              setFilesChanged(totalWrites + successCount);
            }
            toolResults += `<tool_result name="batch_edit">${successCount} succeeded, ${failCount} failed</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Batch edit: ${successCount} files edited, ${failCount} failed`);
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "search_code" && call.query) {
          updateTaskStatus("tool_executing", `Searching "${call.query}"…`);
          fullDisplayContent += `searching [${call.query}]\n`;
          setDisplayContent(fullDisplayContent);

          const results = searchCode(call.query);
          toolResults += `<tool_result name="search_code" query="${call.query}">\n${results}\n</tool_result>\n`;
          fullDisplayContent = replaceLastStatus(
            fullDisplayContent,
            `[OK] Search "${call.query}" — ${results.split("\n").length} match(es)`
          );
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "web_search" && call.query) {
          updateTaskStatus("tool_executing", `Searching web: "${call.query.slice(0, 30)}"…`);
          fullDisplayContent += `searching web [${call.query}]\n`;
          setDisplayContent(fullDisplayContent);

          try {
            const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000);
              const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000"}/api/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: call.query }),
                signal: controller.signal,
              });
              clearTimeout(timeoutId);
            const data = await res.json();
            const results = data.results || [];
            if (results.length > 0) {
              const formatted = results.map((r: any, i: number) =>
                `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
              ).join("\n\n");
              toolResults += `<tool_result name="web_search" query="${call.query}">\n${formatted}\n</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Web search "${call.query.slice(0, 30)}" — ${results.length} result(s)`);
            } else {
              toolResults += `<tool_result name="web_search" query="${call.query}">No results found</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Web search "${call.query.slice(0, 30)}" — no results`);
            }
          } catch (err) {
            toolResults += `<tool_result name="web_search" query="${call.query}">Search failed: ${(err as Error).message}</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Web search failed: ${(err as Error).message}`);
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "run_command" && call.command) {
          // Safety: block destructive commands (uses centralized blocklist)
          if (isBlockedCommand(call.command!)) {
            toolResults += `<tool_result name="run_command" command="${call.command}">BLOCKED: command is too dangerous to execute</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Command blocked for safety: \`${call.command!.slice(0, 50)}\``);
            setDisplayContent(fullDisplayContent);
          } else {
          // Risk-tiered: shell commands are never auto-approved, but high-risk
          // ones (destructive/system-level) get elevated styling in the dialog
          const commandRisk = classifyRisk("run_command", { command: call.command });
          if (commandRisk.level === "high") {
            emitActivity({ type: "tool", message: `High-risk command requires approval: ${call.command.slice(0, 40)}`, agent: "coder" });
          }

          let approved = true;
          if (commandRisk.autoApprovable === false) {
            updateTaskStatus("awaiting_approval", `Waiting for approval: ${call.command.slice(0, 40)}`);
            fullDisplayContent += `running [${call.command}] — awaiting approval\n`;
            setDisplayContent(fullDisplayContent);
            approved = await requestApproval(
              "run_command",
              `Run: ${call.command}`,
              { command: call.command }
            );
          } else {
            updateTaskStatus("tool_executing", `Running: ${call.command.slice(0, 40)}...`);
            emitActivity({ type: "tool", message: `Running ${call.command.slice(0, 40)}`, agent: "coder" });
            fullDisplayContent += `running [${call.command}]\n`;
            setDisplayContent(fullDisplayContent);
          }

          if (!approved) {
            bumpStat("rejectedActions");
            toolResults += `<tool_result name="run_command" command="${call.command}">rejected by user</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Command rejected: \`${call.command.slice(0, 50)}\``);
            setDisplayContent(fullDisplayContent);
          } else {
            // Execute via server-side API (child_process can't run in browser)
            const execRes = await fetch("/api/agent/exec", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: call.command }),
            });
            const result = await execRes.json();
            if (result.exitCode === 0) {
              bumpStat("commandsRun");
              toolResults += `<tool_result name="run_command" command="${call.command}">\n${result.stdout}${result.stderr ? `\nSTDERR: ${result.stderr}` : ""}\n</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Command completed: \`${call.command.slice(0, 50)}\``);
            } else {
              bumpStat("failedSteps");
              toolResults += `<tool_result name="run_command" command="${call.command}">\n${result.stdout}${result.stderr ? `\nSTDERR: ${result.stderr}` : result.stderr}\n</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Command failed: \`${call.command.slice(0, 50)}\` (exit ${result.exitCode})`);
            }
          }
          } // end safety block
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "run_in_sandbox" && call.command) {
          // Sandbox execution — tries E2B if API key exists, falls back to local with strict limits
          const e2bKey = process.env.E2B_API_KEY;
          const sandboxTimeout = (call.timeout as number) || TIMEOUTS.SANDBOX_EXEC / 1000;

          updateTaskStatus("awaiting_approval", `Waiting for approval: sandbox ${call.command.slice(0, 40)}`);
          fullDisplayContent += `sandbox [${call.command}] — awaiting approval\n`;
          setDisplayContent(fullDisplayContent);

          const approved = await requestApproval(
            "run_command",
            `Run in sandbox: ${call.command}`,
            { command: call.command, sandbox: true },
            undefined,
            "medium" // sandboxed execution is contained — never above medium
          );

          if (!approved) {
            toolResults += `<tool_result name="run_in_sandbox" command="${call.command}">rejected by user</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Sandbox command rejected`);
          } else if (e2bKey) {
            // E2B cloud sandbox
            updateTaskStatus("tool_executing", `Running in cloud sandbox…`);
            try {
              // @ts-ignore — e2b is an optional dependency
              const { Sandbox } = await import("e2b");
              const sandbox = await Sandbox.create({ apiKey: e2bKey });
              const execution = await sandbox.runCommand(call.command, { timeout: sandboxTimeout });
              const output = (execution.stdout || "") + (execution.stderr ? `\nSTDERR: ${execution.stderr}` : "");
              const truncated = output.length > LIMITS.SANDBOX_OUTPUT ? output.slice(0, LIMITS.SANDBOX_OUTPUT) + "\n... [truncated]" : output;
              toolResults += `<tool_result name="run_in_sandbox" command="${call.command}">\n${truncated}\n</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Sandbox completed: \`${call.command.slice(0, LIMITS.COMMAND_STATUS)}\``);
              await sandbox.kill();
            } catch (err) {
              toolResults += `<tool_result name="run_in_sandbox" command="${call.command}">error: ${(err as Error).message}</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Sandbox failed: ${(err as Error).message}`);
            }
          } else {
            // Fallback: local sandboxed execution via server API
            updateTaskStatus("tool_executing", `Running locally (no sandbox key)…`);
            const execRes = await fetch("/api/agent/exec", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                command: call.command,
                timeout: Math.min(sandboxTimeout * 1000, TIMEOUTS.COMMAND_EXEC),
                maxBuffer: LIMITS.SANDBOX_BUFFER,
              }),
            });
            const result = await execRes.json();
            const output = (result.stdout || "") + (result.stderr ? `\nSTDERR: ${result.stderr}` : "");
            toolResults += `<tool_result name="run_in_sandbox" command="${call.command}">\n${output}\n</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(
              fullDisplayContent,
              result.exitCode === 0
                ? `[OK] Command completed (local): \`${call.command.slice(0, 50)}\``
                : `[FAIL] Command failed: \`${call.command.slice(0, 50)}\` (exit ${result.exitCode})`
            );
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "undo_last_change" && call.path) {
          updateTaskStatus("tool_executing", `Undoing ${call.path}…`);
          fullDisplayContent += `undoing [${call.path}]\n`;
          setDisplayContent(fullDisplayContent);

          const { undoLastChange } = await import("./file-history");
          const prevContent = undoLastChange(call.path);
          if (prevContent !== null && _writeFile) {
            await _writeFile(call.path, prevContent);
            toolResults += `<tool_result name="undo_last_change" path="${call.path}">success - restored previous version</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Undid change to \`${call.path}\` — restored previous version`);
          } else {
            toolResults += `<tool_result name="undo_last_change" path="${call.path}">error - no previous version found</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] No previous version of \`${call.path}\` to undo`);
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "take_screenshot" && call.url) {
          updateTaskStatus("tool_executing", `Capturing ${call.url}...`);
          fullDisplayContent += `capturing [${call.url}]\n`;
          setDisplayContent(fullDisplayContent);

          try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000"}/api/agent/screenshot`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: call.url, width: 1280, height: 720 }),
            });
            const data = await res.json();
            if (data.screenshot) {
              // Push the URL to the live preview panel instead of leaving the
              // screenshot as a static artifact
              emitPreview(call.url, "take_screenshot");
              toolResults += `<tool_result name="take_screenshot" url="${call.url}">success - screenshot captured (${data.width || 1280}x${data.height || 720}). Page opened in the live preview panel.</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Screenshot captured: ${call.url} (shown in live preview)`);
            } else {
              toolResults += `<tool_result name="take_screenshot" url="${call.url}">error - ${data.error || "capture failed"}</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Screenshot failed: ${data.error || "unknown error"}`);
            }
          } catch (err) {
            toolResults += `<tool_result name="take_screenshot" url="${call.url}">error - ${(err as Error).message}</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Screenshot failed: ${(err as Error).message}`);
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "todo_list") {
          const action = typeof call.action === "string" ? call.action : "";
          // LLM may send objects in items[] — coerce each to string
          const items = Array.isArray(call.items)
            ? call.items.map((i: unknown) => typeof i === "string" ? i : JSON.stringify(i))
            : undefined;
          const completedIndex = typeof call.completed_index === "number" ? call.completed_index : undefined;

          if (action === "create" && items) {
            setTodos(items);
            toolResults += `<tool_result name="todo_list" action="create">Created ${items.length} tasks</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Todo list created (${items.length} items)`);
          } else if (action === "update" && items) {
            setTodos(items);
            toolResults += `<tool_result name="todo_list" action="update">Updated todo list</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Todo list updated`);
          } else if (action === "complete" && completedIndex !== undefined) {
            completeTodo(completedIndex);
            toolResults += `<tool_result name="todo_list" action="complete">Marked item ${completedIndex} done</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Task ${completedIndex + 1} completed`);
          } else if (action === "clear") {
            clearTodos();
            toolResults += `<tool_result name="todo_list" action="clear">Cleared todo list</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Todo list cleared`);
          }
          setDisplayContent(fullDisplayContent);

        } else if (call.name === "ask_question") {
          // LLM may send objects — coerce to strings
          const question = typeof call.question === "string" ? call.question : JSON.stringify(call.question ?? "");
          const options = Array.isArray(call.options)
            ? call.options.map((o: unknown) => typeof o === "string" ? o : JSON.stringify(o))
            : [];
          const allowFreeText = call.allow_free_text !== false;

          if (!question || options.length === 0) {
            toolResults += `<tool_result name="ask_question">error - missing question or options</tool_result>\n`;
          } else {
          setQuestion(question, options, allowFreeText);
          updateTaskStatus("awaiting_approval", "Waiting for user answer…");
          fullDisplayContent += `asking [${question.slice(0, 40)}]\n`;
          setDisplayContent(fullDisplayContent);

          // Poll until user answers — with timeout and cleanup
          const ANSWER_TIMEOUT = 300000; // 5 minutes
          const answer = await new Promise<string>((resolve) => {
            let resolved = false;
            const check = setInterval(() => {
              const bg = getCurrentTask();
              if (bg?.question?.answered) {
                resolved = true;
                clearInterval(check);
                resolve(bg.question.answer || "");
              }
              if (!bg || bg.status === "done" || bg.status === "error") {
                if (!resolved) {
                  resolved = true;
                  clearInterval(check);
                  resolve("(task cancelled)");
                }
              }
            }, 500);
            setTimeout(() => {
              if (!resolved) {
                resolved = true;
                clearInterval(check);
                resolve("(timed out)");
              }
            }, ANSWER_TIMEOUT);
          });

          toolResults += `<tool_result name="ask_question" question="${question}">User answered: ${answer}</tool_result>\n`;
          fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] User answered: "${answer}"`);
          setDisplayContent(fullDisplayContent);
          } // end else (valid question)

        } else if (call.name === "preview_browser" && call.url) {
          updateTaskStatus("tool_executing", `Previewing ${call.url}...`);
          emitActivity({ type: "tool", message: `Previewing ${call.url}`, agent: "coder" });
          fullDisplayContent += `previewing [${call.url}]\n`;
          setDisplayContent(fullDisplayContent);

          try {
            // Navigate the preview iframe in the right panel
            const { getPreviewIframe } = await import("@/components/RightPanel");
            const iframe = getPreviewIframe();
            if (iframe) {
              iframe.src = call.url;
            }

            // Also fetch the page content for the AI to analyze
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000"}/api/agent/preview`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: call.url, action: "fetch" }),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (data.success) {
              // Drive the live preview iframe (in addition to the fetch above
              // that gives the AI the page content)
              emitPreview(call.url, "preview_browser");
              toolResults += `<tool_result name="preview_browser" url="${call.url}">success — Title: "${data.title}" | Content-Type: ${data.contentType} | Size: ${data.size} chars | Status: ${data.statusCode}\nThe page is live in the preview panel.</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[OK] Preview loaded: "${data.title}" (${data.size} chars)`);
            } else {
              toolResults += `<tool_result name="preview_browser" url="${call.url}">error: ${data.error || "Failed to load"}</tool_result>\n`;
              fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Preview failed: ${data.error || "unknown"}`);
            }
          } catch (err) {
            toolResults += `<tool_result name="preview_browser" url="${call.url}">error: ${(err as Error).message}</tool_result>\n`;
            fullDisplayContent = replaceLastStatus(fullDisplayContent, `[FAIL] Preview failed: ${(err as Error).message}`);
          }
          setDisplayContent(fullDisplayContent);
        }

        // === PLUGIN HOOK: afterToolCall ===
        afterToolCall(call.name, call as any, toolResults.slice(-200)).catch(() => {});
      }

      // === LOOP DETECTION: If all reads were duplicates, stop ===
      if (skippedDueToDup && toolCalls.every(c => c.name !== "write_file")) {
        fullDisplayContent += "\n\n*[Stopping — agent was re-reading files it already has. Use the information above to answer.]*\n";
        break;
      }

      fullDisplayContent += "\n";

      apiMessages = [
        ...apiMessages,
        { role: "assistant", content: streamedContent || "" },
        { role: "user", content: `[TOOL RESULTS]\n${toolResults}\nYou now have all the information you need. Provide a clear, actionable summary. Do NOT re-read files you've already read.` },
      ];
    }

    // Keep [THINKING] content so ThinkingCard can render it after completion
    let cleanContent = fullDisplayContent
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // === CODE BLOCK EXTRACTION ===
    // If AI output markdown code blocks instead of using write_file,
    // extract them and write as files automatically
    let extractedFiles = 0;
    if (totalWrites === 0 && virtualFS.getFileCount() === 0) {
      // No files were created via tools — check for code blocks in output
      const codeBlockRegex = /```(\w+)?\s*(?:\w+)?\s*\n([\s\S]*?)```/g;
      let codeMatch;
      const headerRegex = /^(?:\d+\.\s*)?([A-Za-z .]+)\s*$/m;

      // Find section headers before code blocks to determine filenames
      while ((codeMatch = codeBlockRegex.exec(cleanContent)) !== null) {
        const lang = (codeMatch[1] || "text").toLowerCase();
        const code = codeMatch[2].trim();
        if (code.length < 10) continue; // Skip tiny snippets

        // Determine filename from language
        const extMap: Record<string, string> = {
          html: ".html", htm: ".html", css: ".css", js: ".js",
          javascript: ".js", typescript: ".ts", ts: ".ts",
          tsx: ".tsx", jsx: ".tsx", json: ".json", python: ".py",
          py: ".py", md: ".md", sh: ".sh", bash: ".sh",
          prisma: ".prisma", sql: ".sql", yaml: ".yml",
          yml: ".yml", toml: ".toml", xml: ".xml",
        };
        const ext = extMap[lang] || ".txt";

        // Try to find a section header above the code block
        const beforeBlock = cleanContent.slice(Math.max(0, codeMatch.index - 200), codeMatch.index);
        const sectionMatch = beforeBlock.match(/(?:\d+\.\s*)?([A-Za-z][A-Za-z .\-]+)$/m);
        let fileName = "generated-file" + ext;

        if (sectionMatch) {
          const sectionTitle = sectionMatch[1].trim().toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/\s+/g, "-")
            .slice(0, 40);
          if (sectionTitle.length > 2) {
            fileName = sectionTitle + ext;
          }
        }

        // Deduplicate filenames
        if (virtualFS.exists(fileName)) {
          const base = fileName.replace(/\.[^.]+$/, "");
          const ext2 = fileName.match(/\.[^.]+$/)?.[0] || ext;
          let counter = 2;
          while (virtualFS.exists(`${base}-${counter}${ext2}`)) counter++;
          fileName = `${base}-${counter}${ext2}`;
        }

        // Write to local FS if a folder is open, otherwise to virtual FS
        if (_writeFile) {
          await _writeFile(fileName, code);
        } else {
          virtualFS.writeFile(fileName, code);
        }
        extractedFiles++;
      }

      if (extractedFiles > 0) {
        // Replace code blocks with file references in display
        cleanContent = cleanContent.replace(
          /```(\w+)?\s*(?:\w+)?\s*\n[\s\S]*?```/g,
          ""
        );
        cleanContent += `\n\n[${extractedFiles} file(s) extracted from code blocks and saved to workspace]`;
      }
    }

    // If files were written, append a preview guide
    const virtualFileCount = virtualFS.getFileCount();
    const hasFiles = totalWrites > 0 || virtualFileCount > 0 || extractedFiles > 0;

    if (hasFiles) {
      const fileCount = totalWrites > 0 ? totalWrites : (virtualFileCount > 0 ? virtualFileCount : extractedFiles);
      let guide = "\n\n---\n\n";
      guide += `${fileCount} file(s) created.\n`;

      if (_directoryName) {
        guide += "Files saved to your open folder. Check the sidebar file tree to browse them.\n";
        guide += "To preview: open a terminal and run `npx serve .` or `python -m http.server 3001`.\n";
        guide += "Then open http://localhost:3001 in your browser.";
      } else {
        guide += "Files are in the virtual workspace.\n";
        guide += "Click 'Open' in the sidebar to sync with a local folder,\n";
        guide += "or click 'Export .zip' to download all files.\n";
        guide += "To preview: export the .zip, extract it, then run `npx serve .` or `python -m http.server 3001`.";
      }
      cleanContent += guide;
    }

    // Ensure display content is set one final time (covers edge cases)
    // Deduplicate repeated words in final content
    const finalContent = deduplicateWords(cleanContent || fullDisplayContent);
    setDisplayContent(finalContent);
    // Stale check: don't complete if user stopped/started a new task
    if (isCurrentTask(taskId)) {
      completeTask(finalContent);
      // === PLUGIN HOOK: onTaskComplete ===
      onTaskComplete(userMessage, finalContent).catch(() => {});
    }
  } catch (err) {
    // Stale check: don't fail a task that's no longer current
    if (isCurrentTask(taskId)) {
      failTask((err as Error).message || "Unknown error");
      // === PLUGIN HOOK: onTaskFail ===
      onTaskFail(userMessage, (err as Error).message || "Unknown error").catch(() => {});
    }
  }
}

// === Multi-Agent Mode ===
// Alternative entry point: runs the full multi-agent system
// triggered when user message starts with @multi or @agents

export async function runMultiAgentBackground(
  userMessage: string,
  conversationId: string | null,
  priorMessages: ChatMessage[]
) {
  const { runMultiAgent } = await import("./multi-agent");
  
  const taskId = startTask(conversationId, userMessage, [
    ...priorMessages,
    { role: "user", content: userMessage, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) },
  ]);

  updateTaskStatus("streaming", "Routing to agents...");
  setDisplayContent("[COORDINATOR] Analyzing request...");

  try {
    const result = await runMultiAgent(userMessage);
    
    // Build display content from agent results
    const display = [
      result.coordinatorDecision ? `[COORDINATOR] ${result.coordinatorDecision.slice(0, 200)}` : "",
      result.plan ? `[PLANNER] ${result.plan.slice(0, 500)}` : "",
      result.codeOutput ? `[CODER] ${result.codeOutput.slice(0, 1000)}` : "",
      result.reviewResult ? `[REVIEWER] ${result.reviewResult.slice(0, 500)}` : "",
      result.researchResult ? `[RESEARCHER] ${result.researchResult.slice(0, 500)}` : "",
      `\n--- Agents used: ${result.agentsUsed.join(", ")} | Turns: ${result.turnCount} ---`,
    ].filter(Boolean).join("\n");

    setDisplayContent(display || result.finalAnswer);
    
    if (isCurrentTask(taskId)) {
      completeTask(result.finalAnswer || display);
    }
  } catch (err) {
    if (isCurrentTask(taskId)) {
      failTask((err as Error).message || "Unknown error");
    }
  }
}
