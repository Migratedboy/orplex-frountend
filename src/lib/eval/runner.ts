// eval/runner.ts — Orchestrates evaluation runs.
//
// For each task:
//   1. Populates a virtual filesystem with the broken initialFiles
//   2. Sends the fixInstruction as a chat message via /api/chat
//   3. Captures the agent's file writes
//   4. Scores the output against expected files + assertions
//
// This module is designed to run server-side (Node.js) or in a browser
// test environment. It does NOT depend on React components.

import type {
  EvalTask,
  EvalRunnerConfig,
  TaskResult,
  ScoreSummary,
} from "./types";
import { scoreTask, aggregateScores, enrichWithMetadata } from "./scorer";

// ============================================================
// Virtual FS (lightweight in-memory copy for eval)
// ============================================================

class EvalVirtualFS {
  private files = new Map<string, string>();

  write(path: string, content: string) {
    this.files.set(path, content);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  getAllFiles(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  clear() {
    this.files.clear();
  }
}

// ============================================================
// Agent Caller
// ============================================================

interface AgentResponse {
  content: string;
  fileWrites: Array<{ path: string; content: string }>;
  fileEdits: Array<{ path: string; oldText: string; newText: string }>;
}

/**
 * Send a fix instruction to the agent and capture its response.
 *
 * This calls the /api/chat endpoint which triggers the background worker.
 * The worker executes tool calls (write_file, edit_file) which we intercept
 * by monitoring the virtual FS changes.
 *
 * For the eval harness, we use a simplified approach: we call the chat API
 * and parse the tool calls from the streamed response.
 */
async function callAgent(
  instruction: string,
  initialFiles: Record<string, string>,
  config: EvalRunnerConfig,
  timeoutMs: number
): Promise<AgentResponse> {
  const startTime = Date.now();

  // Build the user message with workspace context
  const fileContext = Object.entries(initialFiles)
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join("\n\n");

  const fullMessage = `[EVAL MODE — FIX THE BUG]\n\n${instruction}\n\n=== WORKSPACE FILES ===\n${fileContext}\n\n=== END WORKSPACE ===\n\nFix the bug using write_file or edit_file tool calls. Do NOT describe the fix — apply it.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.authHeader) {
      headers["Authorization"] = config.authHeader;
    }

    const res = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: fullMessage }],
        mode: "code",
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "unknown");
      throw new Error(`Agent API returned ${res.status}: ${errBody}`);
    }

    // Read the SSE stream to collect content and tool calls
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        for (const line of event.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) fullContent += parsed.content;
            } catch {}
          }
        }
      }
    }

    // Parse tool calls from the accumulated content
    const fileWrites = parseWriteCalls(fullContent);
    const fileEdits = parseEditCalls(fullContent);

    return { content: fullContent, fileWrites, fileEdits };
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("Agent timed out");
    }
    throw err;
  }
}

// ============================================================
// Tool Call Parsing
// ============================================================

/**
 * Parse write_file tool calls from agent output (both XML and native formats).
 */
function parseWriteCalls(content: string): Array<{ path: string; content: string }> {
  const writes: Array<{ path: string; content: string }> = [];

  // XML format: <tool_call>{"name":"write_file","path":"...","content":"..."}</tool_call>
  const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = xmlRegex.exec(content)) !== null) {
    try {
      const call = JSON.parse(match[1].trim());
      if (call.name === "write_file" && call.path && call.content !== undefined) {
        writes.push({ path: call.path, content: call.content });
      }
    } catch {}
  }

  // Also look for JSON object patterns in the content
  const jsonRegex = /"name"\s*:\s*"write_file"[^}]*"path"\s*:\s*"([^"]+)"[^}]*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const path = match[1];
      const contentStr = match[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      // Avoid duplicates
      if (!writes.some((w) => w.path === path && w.content === contentStr)) {
        writes.push({ path, content: contentStr });
      }
    } catch {}
  }

  return writes;
}

/**
 * Parse edit_file tool calls from agent output.
 */
function parseEditCalls(content: string): Array<{ path: string; oldText: string; newText: string }> {
  const edits: Array<{ path: string; oldText: string; newText: string }> = [];

  const xmlRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = xmlRegex.exec(content)) !== null) {
    try {
      const call = JSON.parse(match[1].trim());
      if (call.name === "edit_file" && call.path && call.old_text && call.new_text) {
        edits.push({ path: call.path, oldText: call.old_text, newText: call.new_text });
      }
    } catch {}
  }

  return edits;
}

/**
 * Apply edits to the file map (simulates the agent's edit_file tool).
 */
function applyEdits(
  files: Record<string, string>,
  edits: Array<{ path: string; oldText: string; newText: string }>
): Record<string, string> {
  const result = { ...files };
  for (const edit of edits) {
    const current = result[edit.path];
    if (current && current.includes(edit.oldText)) {
      result[edit.path] = current.replace(edit.oldText, edit.newText);
    }
  }
  return result;
}

// ============================================================
// Task Runner
// ============================================================

/**
 * Run a single eval task. Returns the scored result.
 */
export async function runTask(
  task: EvalTask,
  config: EvalRunnerConfig
): Promise<TaskResult> {
  const timeout = config.globalTimeout || task.timeout;
  const timeoutMs = timeout * 1000;
  const startTime = Date.now();

  try {
    // Build initial file map
    const initialFiles: Record<string, string> = {};
    for (const f of task.initialFiles) {
      initialFiles[f.path] = f.content;
    }

    // Call the agent
    const response = await callAgent(
      task.fixInstruction,
      initialFiles,
      config,
      timeoutMs
    );

    const durationMs = Date.now() - startTime;

    // Build output files: start with initial state, apply writes, then edits
    let outputFiles = { ...initialFiles };

    // Apply write_file calls (last write wins for same path)
    for (const write of response.fileWrites) {
      outputFiles[write.path] = write.content;
    }

    // Apply edit_file calls
    outputFiles = applyEdits(outputFiles, response.fileEdits);

    // Score the result
    return scoreTask(task, outputFiles, response.content, durationMs);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    return scoreTask(task, {}, "", durationMs, err.message || String(err));
  }
}

// ============================================================
// Batch Runner
// ============================================================

/**
 * Run all tasks (or a filtered subset) and return aggregate scores.
 */
export async function runAll(
  tasks: EvalTask[],
  config: EvalRunnerConfig
): Promise<ScoreSummary> {
  // Filter tasks by prefix if configured
  let filtered = tasks;
  if (config.filterPrefixes && config.filterPrefixes.length > 0) {
    filtered = tasks.filter((t) =>
      config.filterPrefixes!.some((prefix) => t.id.startsWith(prefix))
    );
  }

  if (config.verbose) {
    console.log(`\n🚀 Eval harness: running ${filtered.length} tasks`);
    console.log(`   Base URL: ${config.baseUrl}`);
    console.log(`   Concurrency: ${config.concurrency}`);
    if (config.filterPrefixes) {
      console.log(`   Filter prefixes: ${config.filterPrefixes.join(", ")}`);
    }
  }

  const results: TaskResult[] = [];

  // Run tasks (with optional concurrency)
  if (config.concurrency <= 1) {
    // Sequential
    for (let i = 0; i < filtered.length; i++) {
      const task = filtered[i];
      if (config.verbose) {
        console.log(`\n  [${i + 1}/${filtered.length}] ${task.id}: ${task.name}`);
      }
      const result = await runTask(task, config);
      results.push(result);

      const icon = result.verdict === "pass" ? "✅" : result.verdict === "fail" ? "❌" : result.verdict === "timeout" ? "⏰" : "💥";
      if (config.verbose) {
        console.log(`    ${icon} ${result.verdict} (${result.durationMs}ms)`);
      }
    }
  } else {
    // Concurrent (with semaphore)
    const semaphore = new Array(config.concurrency).fill(null);
    let nextIdx = 0;

    const runNext = async (): Promise<void> => {
      while (nextIdx < filtered.length) {
        const idx = nextIdx++;
        const task = filtered[idx];
        const result = await runTask(task, config);
        results.push(result);

        const icon = result.verdict === "pass" ? "✅" : result.verdict === "fail" ? "❌" : result.verdict === "timeout" ? "⏰" : "💥";
        if (config.verbose) {
          console.log(`  [${idx + 1}/${filtered.length}] ${task.id} ${icon} ${result.verdict} (${result.durationMs}ms)`);
        }
      }
    };

    await Promise.all(semaphore.map(() => runNext()));
  }

  // Build summary with metadata
  const taskMeta = new Map(
    filtered.map((t) => [t.id, { category: t.category, difficulty: t.difficulty }])
  );

  let summary = aggregateScores(results);
  summary = enrichWithMetadata(summary, taskMeta);

  if (config.verbose) {
    printSummary(summary);
  }

  return summary;
}

// ============================================================
// Report Printing
// ============================================================

export function printSummary(summary: ScoreSummary): void {
  console.log("\n" + "=".repeat(60));
  console.log("📊 EVAL RESULTS");
  console.log("=".repeat(60));
  console.log(`\n  Overall: ${summary.passed}/${summary.totalTasks} passed (${summary.score}%)`);
  console.log(`  Failed: ${summary.failed} | Timed out: ${summary.timedOut} | Errors: ${summary.errored}`);

  // By category
  const cats = Object.entries(summary.byCategory);
  if (cats.length > 0) {
    console.log("\n  By Category:");
    for (const [cat, stats] of cats) {
      console.log(`    ${cat.padEnd(20)} ${stats.passed}/${stats.total} (${stats.score}%)`);
    }
  }

  // By difficulty
  const diffs = Object.entries(summary.byDifficulty);
  if (diffs.length > 0) {
    console.log("\n  By Difficulty:");
    for (const [diff, stats] of diffs) {
      console.log(`    ${diff.padEnd(20)} ${stats.passed}/${stats.total} (${stats.score}%)`);
    }
  }

  // Failed tasks detail
  const failures = summary.results.filter((r) => r.verdict !== "pass");
  if (failures.length > 0) {
    console.log("\n  Failed Tasks:");
    for (const r of failures) {
      console.log(`    ${r.taskId}: ${r.verdict}${r.error ? ` — ${r.error}` : ""}`);
      // Show first failing file diff
      const failingDiff = r.fileDiffs.find((d) => !d.exactMatch);
      if (failingDiff) {
        console.log(`      File: ${failingDiff.path}`);
        if (failingDiff.diffSnippet !== "(exact match)") {
          console.log(`      Diff: ${failingDiff.diffSnippet.split("\n").slice(0, 4).join("\n            ")}`);
        }
      }
    }
  }

  console.log("\n" + "=".repeat(60));
}

// ============================================================
// JSON Report Writer
// ============================================================

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export function writeReport(summary: ScoreSummary, reportPath: string): void {
  const dir = dirname(reportPath);
  mkdirSync(dir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalTasks: summary.totalTasks,
      passed: summary.passed,
      failed: summary.failed,
      timedOut: summary.timedOut,
      errored: summary.errored,
      score: summary.score,
    },
    byCategory: summary.byCategory,
    byDifficulty: summary.byDifficulty,
    results: summary.results.map((r) => ({
      taskId: r.taskId,
      verdict: r.verdict,
      durationMs: r.durationMs,
      fileDiffs: r.fileDiffs.map((d) => ({
        path: d.path,
        exactMatch: d.exactMatch,
        similarity: d.similarity,
      })),
      assertionResults: r.assertionResults,
      error: r.error,
    })),
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report written to ${reportPath}`);
}
