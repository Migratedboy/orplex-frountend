#!/usr/bin/env node

// eval/cli.ts — Command-line interface for the evaluation harness.
//
// Usage:
//   npx ts-node src/lib/eval/cli.ts [options]
//
// Options:
//   --url <url>           Base URL of the running app (default: http://localhost:5000)
//   --prefix <prefix>     Run only tasks with this ID prefix (e.g. "TS-", "LOGIC-")
//   --category <cat>      Run only tasks in this category (e.g. "type-error")
//   --difficulty <diff>   Run only tasks of this difficulty (e.g. "easy")
//   --concurrency <n>     Max concurrent runs (default: 1)
//   --timeout <seconds>   Override timeout for all tasks (default: 0 = per-task)
//   --report <path>       Write JSON report to this path
//   --verbose             Show detailed output
//   --list                List all available tasks and exit
//   --help                Show this help message
//
// Examples:
//   npx ts-node src/lib/eval/cli.ts --list
//   npx ts-node src/lib/eval/cli.ts --prefix TS- --verbose
//   npx ts-node src/lib/eval/cli.ts --category security --report ./security-report.json
//   npx ts-node src/lib/eval/cli.ts --url http://localhost:3000 --concurrency 3

import { runAll, writeReport, printSummary } from "./runner";
import { printTaskSummary, getTasksByCategory, getTasksByDifficulty, ALL_TASKS } from "./tasks";
import type { EvalRunnerConfig } from "./types";

// ============================================================
// Argument Parsing
// ============================================================

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--list" || arg === "-l") {
      args.list = true;
    } else if (arg === "--verbose" || arg === "-v") {
      args.verbose = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function showHelp(): void {
  console.log(`
eval-harness — Agent evaluation suite for Orplex Tech

USAGE:
  npx ts-node src/lib/eval/cli.ts [options]

OPTIONS:
  --url <url>           Base URL of the running app (default: http://localhost:5000)
  --prefix <prefix>     Run only tasks with this ID prefix (e.g. "TS-", "LOGIC-")
  --category <cat>      Run only tasks in this category
  --difficulty <diff>   Run only tasks of this difficulty
  --concurrency <n>     Max concurrent runs (default: 1)
  --timeout <seconds>   Override timeout for all tasks (default: 0 = per-task)
  --report <path>       Write JSON report to this path
  --verbose             Show detailed output
  --list                List all available tasks and exit
  --help                Show this help message

CATEGORIES:
  type-error, logic-bug, react-bug, api-route, security,
  performance, error-handling, api-integration, refactor, new-feature

DIFFICULTIES:
  easy, medium, hard

EXAMPLES:
  npx ts-node src/lib/eval/cli.ts --list
  npx ts-node src/lib/eval/cli.ts --prefix TS- --verbose
  npx ts-node src/lib/eval/cli.ts --category security --report ./security-report.json
  npx ts-node src/lib/eval/cli.ts --url http://localhost:3000 --concurrency 3
`);
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.list) {
    printTaskSummary();
    // Also print all task IDs
    console.log("  All Task IDs:");
    for (const task of ALL_TASKS) {
      console.log(`    ${task.id.padEnd(16)} [${task.difficulty}] ${task.name}`);
    }
    console.log("");
    process.exit(0);
  }

  // Build config
  const config: EvalRunnerConfig = {
    baseUrl: (args.url as string) || "http://localhost:5000",
    concurrency: parseInt(args.concurrency as string) || 1,
    globalTimeout: parseInt(args.timeout as string) || 0,
    verbose: !!args.verbose,
    reportPath: args.report as string | undefined,
  };

  // Filter tasks
  let tasks = ALL_TASKS;

  if (args.prefix) {
    const prefix = args.prefix as string;
    tasks = tasks.filter((t) => t.id.startsWith(prefix));
    console.log(`Filtering by prefix: ${prefix} → ${tasks.length} tasks`);
  }

  if (args.category) {
    tasks = getTasksByCategory(args.category as string);
    console.log(`Filtering by category: ${args.category} → ${tasks.length} tasks`);
  }

  if (args.difficulty) {
    tasks = getTasksByDifficulty(args.difficulty as string);
    console.log(`Filtering by difficulty: ${args.difficulty} → ${tasks.length} tasks`);
  }

  if (tasks.length === 0) {
    console.error("No tasks matched the filter criteria.");
    process.exit(1);
  }

  // Run
  const startTime = Date.now();
  const summary = await runAll(tasks, config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n⏱  Total time: ${elapsed}s`);

  // Write report
  if (config.reportPath) {
    writeReport(summary, config.reportPath);
  }

  // Exit code: 0 if all passed, 1 otherwise
  process.exit(summary.score === 100 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
