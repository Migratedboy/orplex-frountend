// eval/tasks/index.ts — Central export for all eval task categories.

import type { EvalTask } from "../types";
import { typeErrorTasks } from "./type-errors";
import { logicBugTasks } from "./logic-bugs";
import { reactBugTasks } from "./react-bugs";
import { apiRouteTasks } from "./api-route";
import { securityTasks } from "./security";
import { performanceTasks } from "./performance";
import { errorHandlingTasks } from "./error-handling";
import { apiIntegrationTasks } from "./api-integration";
import { refactorTasks } from "./refactor";
import { newFeatureTasks } from "./new-feature";

// ============================================================
// All Tasks — flat array for easy iteration
// ============================================================

export const ALL_TASKS: EvalTask[] = [
  ...typeErrorTasks,
  ...logicBugTasks,
  ...reactBugTasks,
  ...apiRouteTasks,
  ...securityTasks,
  ...performanceTasks,
  ...errorHandlingTasks,
  ...apiIntegrationTasks,
  ...refactorTasks,
  ...newFeatureTasks,
];

// ============================================================
// Task Registry — Map for O(1) lookup by ID
// ============================================================

export const TASK_REGISTRY = new Map<string, EvalTask>(
  ALL_TASKS.map((t) => [t.id, t])
);

// ============================================================
// Category exports for targeted runs
// ============================================================

export {
  typeErrorTasks,
  logicBugTasks,
  reactBugTasks,
  apiRouteTasks,
  securityTasks,
  performanceTasks,
  errorHandlingTasks,
  apiIntegrationTasks,
  refactorTasks,
  newFeatureTasks,
};

// ============================================================
// Metadata helpers
// ============================================================

export function getTaskById(id: string): EvalTask | undefined {
  return TASK_REGISTRY.get(id);
}

export function getTasksByCategory(category: string): EvalTask[] {
  return ALL_TASKS.filter((t) => t.category === category);
}

export function getTasksByDifficulty(difficulty: string): EvalTask[] {
  return ALL_TASKS.filter((t) => t.difficulty === difficulty);
}

export function getTaskCount(): number {
  return ALL_TASKS.length;
}

/** Print a summary of available tasks. */
export function printTaskSummary(): void {
  const categories = new Map<string, number>();
  const difficulties = new Map<string, number>();

  for (const task of ALL_TASKS) {
    categories.set(task.category, (categories.get(task.category) || 0) + 1);
    difficulties.set(task.difficulty, (difficulties.get(task.difficulty) || 0) + 1);
  }

  console.log(`\n📋 Eval Task Suite: ${ALL_TASKS.length} tasks\n`);
  console.log("  By Category:");
  for (const [cat, count] of categories) {
    console.log(`    ${cat.padEnd(20)} ${count} tasks`);
  }
  console.log("\n  By Difficulty:");
  for (const [diff, count] of difficulties) {
    console.log(`    ${diff.padEnd(20)} ${count} tasks`);
  }
  console.log("");
}
