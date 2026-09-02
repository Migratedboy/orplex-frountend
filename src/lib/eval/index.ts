// eval/index.ts — Public API for the evaluation harness.
//
// Usage:
//   import { runAll, ALL_TASKS, writeReport } from "@/lib/eval";
//   const summary = await runAll(ALL_TASKS, { baseUrl: "http://localhost:5000", concurrency: 1, verbose: true });
//   writeReport(summary, "./eval-report.json");

export type {
  EvalTask,
  EvalRunnerConfig,
  TaskResult,
  ScoreSummary,
  FileFixture,
  Assertion,
  FileDiff,
  Verdict,
  TaskCategory,
  Difficulty,
} from "./types";

export {
  runTask,
  runAll,
  printSummary,
  writeReport,
} from "./runner";

export {
  scoreTask,
  lineSimilarity,
  diffSnippet,
  aggregateScores,
  enrichWithMetadata,
} from "./scorer";

export {
  ALL_TASKS,
  TASK_REGISTRY,
  getTaskById,
  getTasksByCategory,
  getTasksByDifficulty,
  getTaskCount,
  printTaskSummary,
} from "./tasks";
