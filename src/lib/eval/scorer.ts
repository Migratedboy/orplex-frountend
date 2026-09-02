// eval/scorer.ts — Compares agent output against expected files and assertions.
//
// Provides both exact-match and fuzzy-match (line similarity) scoring, plus
// assertion evaluation. Used by the runner after each task completes.

import type { EvalTask, FileDiff, TaskResult, Verdict } from "./types";

// ============================================================
// String Similarity
// ============================================================

/**
 * Compute a line-level similarity ratio between two strings (0–1).
 * Uses LCS-based approach: similarity = 2 * lcs_len / (len_a + len_b).
 */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const lcsLen = lcsLength(linesA, linesB);
  return (2 * lcsLen) / (linesA.length + linesB.length);
}

/** Longest common subsequence length (dynamic programming). */
function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  // Use two-row DP to save memory.
  let prev = new Uint32Array(n + 1);
  let curr = new Uint32Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n];
}

// ============================================================
// Diff Generation
// ============================================================

/**
 * Produce a unified-style diff snippet (up to maxLines) between expected
 * and actual content. Simplistic: line-by-line comparison with context.
 */
export function diffSnippet(expected: string, actual: string, maxLines = 20): string {
  if (expected === actual) return "(exact match)";

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const diff: string[] = [];

  const maxLen = Math.max(expectedLines.length, actualLines.length);
  let contextRun = 0;

  for (let i = 0; i < maxLen && diff.length < maxLines; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];

    if (e === a) {
      contextRun++;
      // Show at most 1 context line between hunks
      if (contextRun <= 1) {
        diff.push(`  ${e}`);
      } else if (contextRun === 2) {
        diff.push("  ...");
      }
    } else {
      contextRun = 0;
      if (e !== undefined) diff.push(`- ${e}`);
      if (a !== undefined) diff.push(`+ ${a}`);
    }
  }

  if (diff.length === 0) return "(no differences)";
  return diff.join("\n");
}

// ============================================================
// Per-File Scoring
// ============================================================

/**
 * Compare a single file's actual content against its expected content.
 * Returns a FileDiff record.
 */
export function scoreFile(
  path: string,
  actual: string,
  expected: string | undefined
): FileDiff {
  if (expected === undefined) {
    // Agent created a file that wasn't in the expected set — partial credit
    return {
      path,
      exactMatch: false,
      similarity: 0.5, // Created something, but we don't know if it's right
      diffSnippet: "(file not in expected set)",
    };
  }

  const exactMatch = actual === expected;
  const similarity = lineSimilarity(actual, expected);

  return {
    path,
    exactMatch,
    similarity,
    diffSnippet: exactMatch ? "(exact match)" : diffSnippet(expected, actual),
  };
}

// ============================================================
// Task-Level Scoring
// ============================================================

/**
 * Score a completed task run. Returns a fully-populated TaskResult.
 */
export function scoreTask(
  task: EvalTask,
  outputFiles: Record<string, string>,
  agentOutput: string,
  durationMs: number,
  error?: string
): TaskResult {
  // 1. Determine verdict from error/timeout
  let verdict: Verdict = "pass";
  if (error) {
    verdict = "error";
  } else if (durationMs >= task.timeout * 1000) {
    verdict = "timeout";
  }

  // 2. Per-file diffs
  const fileDiffs: FileDiff[] = [];

  // Check all expected files
  for (const [path, expectedContent] of Object.entries(task.expectedFiles)) {
    const actual = outputFiles[path];
    if (actual === undefined) {
      fileDiffs.push({
        path,
        exactMatch: false,
        similarity: 0,
        diffSnippet: "(file missing — agent did not create or modify it)",
      });
    } else {
      fileDiffs.push(scoreFile(path, actual, expectedContent));
    }
  }

  // Check for unexpected files the agent created
  for (const path of Object.keys(outputFiles)) {
    if (!(path in task.expectedFiles)) {
      fileDiffs.push(scoreFile(path, outputFiles[path], undefined));
    }
  }

  // 3. Assertions
  const assertionResults = task.assertions.map((a) => ({
    label: a.label,
    passed: a.check(outputFiles),
  }));

  // 4. Determine pass/fail
  if (verdict === "pass") {
    const allExpectedExact = fileDiffs
      .filter((d) => d.path in task.expectedFiles)
      .every((d) => d.exactMatch);
    const allAssertionsPassed = assertionResults.every((a) => a.passed);

    // Pass requires: all expected files exact-match OR all assertions pass
    // (assertions cover semantic checks the agent might satisfy differently)
    if (!allExpectedExact && !allAssertionsPassed) {
      verdict = "fail";
    }
  }

  return {
    taskId: task.id,
    verdict,
    fileDiffs,
    assertionResults,
    outputFiles,
    durationMs,
    agentOutput: agentOutput.slice(0, 4096),
    error,
  };
}

// ============================================================
// Aggregate Scoring
// ============================================================

import type { ScoreSummary, TaskCategory, Difficulty } from "./types";

export function aggregateScores(results: TaskResult[]): ScoreSummary {
  const passed = results.filter((r) => r.verdict === "pass").length;
  const failed = results.filter((r) => r.verdict === "fail").length;
  const timedOut = results.filter((r) => r.verdict === "timeout").length;
  const errored = results.filter((r) => r.verdict === "error").length;

  // Category breakdown — would need task metadata; store it externally
  // For now, return flat counts. Runner fills in the category/difficulty maps.
  return {
    totalTasks: results.length,
    passed,
    failed,
    timedOut,
    errored,
    score: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
    byCategory: {} as Record<TaskCategory, { total: number; passed: number; score: number }>,
    byDifficulty: {} as Record<Difficulty, { total: number; passed: number; score: number }>,
    results,
  };
}

/**
 * Fill in the category and difficulty breakdowns given the task registry.
 */
export function enrichWithMetadata(
  summary: ScoreSummary,
  tasks: Map<string, { category: TaskCategory; difficulty: Difficulty }>
): ScoreSummary {
  const byCategory: Record<string, { total: number; passed: number; score: number }> = {};
  const byDifficulty: Record<string, { total: number; passed: number; score: number }> = {};

  for (const result of summary.results) {
    const task = tasks.get(result.taskId);
    if (!task) continue;

    const cat = task.category;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0, score: 0 };
    byCategory[cat].total++;
    if (result.verdict === "pass") byCategory[cat].passed++;

    const diff = task.difficulty;
    if (!byDifficulty[diff]) byDifficulty[diff] = { total: 0, passed: 0, score: 0 };
    byDifficulty[diff].total++;
    if (result.verdict === "pass") byDifficulty[diff].passed++;
  }

  // Compute scores
  for (const key of Object.keys(byCategory)) {
    const b = byCategory[key];
    b.score = b.total > 0 ? Math.round((b.passed / b.total) * 100) : 0;
  }
  for (const key of Object.keys(byDifficulty)) {
    const b = byDifficulty[key];
    b.score = b.total > 0 ? Math.round((b.passed / b.total) * 100) : 0;
  }

  return {
    ...summary,
    byCategory: byCategory as Record<TaskCategory, { total: number; passed: number; score: number }>,
    byDifficulty: byDifficulty as Record<Difficulty, { total: number; passed: number; score: number }>,
  };
}
