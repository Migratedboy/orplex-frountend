// eval/types.ts — Core type definitions for the evaluation harness.
//
// Each eval task represents a real repo-fix scenario: broken code that the
// agent must repair. Tasks carry their own initial file state, fix
// instructions, expected outcomes, and pass/fail assertions.

// ============================================================
// Task Definition
// ============================================================

export type TaskCategory =
  | "type-error"
  | "logic-bug"
  | "react-bug"
  | "api-route"
  | "security"
  | "performance"
  | "error-handling"
  | "api-integration"
  | "refactor"
  | "new-feature";

export type Difficulty = "easy" | "medium" | "hard";

/** A single file in the initial (broken) state. */
export interface FileFixture {
  /** Relative path from project root, e.g. "src/utils/parse.ts" */
  path: string;
  /** Full file content — the broken version the agent must fix. */
  content: string;
}

/** A named assertion applied after the agent finishes. */
export interface Assertion {
  /** Human-readable label, e.g. "function returns number not string". */
  label: string;
  /**
   * Predicate evaluated against the final file map.
   * Return true = pass, false = fail.
   * The map is path → full file content after the agent ran.
   */
  check: (files: Record<string, string>) => boolean;
}

/** One evaluation task. */
export interface EvalTask {
  /** Unique slug, e.g. "TS-001-nullable-map-key" */
  id: string;
  /** Short human label */
  name: string;
  /** Longer description of what's broken and what the agent should do */
  description: string;
  category: TaskCategory;
  difficulty: Difficulty;

  /**
   * Instructions sent to the agent as the user message.
   * Should be self-contained — the agent won't see the expected output.
   */
  fixInstruction: string;

  /** Files in their broken state — written to the virtual FS before the run. */
  initialFiles: FileFixture[];

  /**
   * Expected files after the fix. Keys are paths; values are the full
   * expected content. Used for exact-match and fuzzy-match scoring.
   * If `expectedFiles` is empty, only assertions determine pass/fail.
   */
  expectedFiles: Record<string, string>;

  /**
   * Additional semantic assertions beyond exact file matching.
   * ALL must pass for the task to count as solved.
   */
  assertions: Assertion[];

  /** Max seconds before the run is killed. Default 120. */
  timeout: number;

  /**
   * Files the agent is allowed to modify. If empty, any file may be changed.
   * Paths listed here that don't exist in initialFiles are new-file targets.
   */
  allowedPaths?: string[];
}

// ============================================================
// Run Results
// ============================================================

export type Verdict = "pass" | "fail" | "timeout" | "error";

export interface FileDiff {
  path: string;
  /** Exact-match: did the agent produce the expected content? */
  exactMatch: boolean;
  /** Line-level similarity ratio (0–1) when contents differ. */
  similarity: number;
  /** Unified diff snippet (up to 20 lines) for reports. */
  diffSnippet: string;
}

export interface TaskResult {
  taskId: string;
  verdict: Verdict;
  /** Per-file comparison details. */
  fileDiffs: FileDiff[];
  /** Assertion results. */
  assertionResults: Array<{ label: string; passed: boolean }>;
  /** Agent's final file map (path → content). */
  outputFiles: Record<string, string>;
  /** Wall-clock milliseconds the run took. */
  durationMs: number;
  /** Agent's raw text output (truncated to 4KB). */
  agentOutput: string;
  /** Error message if verdict is "error". */
  error?: string;
}

// ============================================================
// Scoring
// ============================================================

export interface ScoreSummary {
  totalTasks: number;
  passed: number;
  failed: number;
  timedOut: number;
  errored: number;
  /** 0–100 overall score: (passed / totalTasks) * 100 */
  score: number;
  /** Per-category breakdown. */
  byCategory: Record<TaskCategory, { total: number; passed: number; score: number }>;
  /** Per-difficulty breakdown. */
  byDifficulty: Record<Difficulty, { total: number; passed: number; score: number }>;
  /** Individual task results. */
  results: TaskResult[];
}

// ============================================================
// Runner Config
// ============================================================

export interface EvalRunnerConfig {
  /**
   * Base URL of the running Next.js app.
   * The runner POSTs to /api/chat to invoke the agent.
   */
  baseUrl: string;

  /** Optional auth header (Bearer token). */
  authHeader?: string;

  /** Override timeout for all tasks (seconds). 0 = use per-task default. */
  globalTimeout?: number;

  /** Max concurrent task runs. Default 1. */
  concurrency: number;

  /**
   * Task ID filter — if set, only tasks whose ID starts with one of
   * these prefixes are included. Useful for running a subset.
   */
  filterPrefixes?: string[];

  /** Verbose logging. Default false. */
  verbose: boolean;

  /** Where to write the JSON report. */
  reportPath?: string;
}
