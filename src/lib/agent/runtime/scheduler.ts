import {
  completeRuntimeTask,
  failRuntimeTask,
  leaseNextRuntimeTask,
} from "./service";
import type { RuntimeArtifact } from "./types";

export interface TaskGraphNode {
  id: string;
  dependsOn: string[];
}

export interface RuntimeWorkerResult {
  output?: unknown;
  artifacts?: RuntimeArtifact[];
}

export type RuntimeWorker = (task: {
  id: string;
  runId: string;
  role: string;
  title: string;
  input: unknown;
}) => Promise<RuntimeWorkerResult>;

export function validateTaskGraph(nodes: TaskGraphNode[]) {
  const ids = new Set<string>();
  const graph = new Map<string, string[]>();

  for (const node of nodes) {
    if (!node.id || ids.has(node.id)) throw new Error("Task graph contains a duplicate or empty task id");
    ids.add(node.id);
    graph.set(node.id, node.dependsOn);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${node.id} depends on missing task ${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Task graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export async function runRuntimeScheduler(
  userId: string,
  runId: string,
  worker: RuntimeWorker,
  options: { concurrency?: number; leaseOwner?: string } = {}
) {
  const concurrency = Math.max(1, Math.min(options.concurrency || 2, 8));
  const leaseOwner = options.leaseOwner || `runtime-${process.pid}-${Date.now()}`;
  const active = new Set<Promise<void>>();
  let completed = 0;
  let failed = 0;

  const launch = async (task: NonNullable<Awaited<ReturnType<typeof leaseNextRuntimeTask>>>) => {
    try {
      const result = await worker({
        id: task.id,
        runId: task.runId,
        role: task.role,
        title: task.title,
        input: task.input,
      });
      await completeRuntimeTask(userId, task.id, result.output ?? {});
      completed += 1;
    } catch (error) {
      failed += 1;
      await failRuntimeTask(userId, task.id, error instanceof Error ? error.message : String(error));
    }
  };

  while (true) {
    while (active.size < concurrency) {
      const task = await leaseNextRuntimeTask(userId, runId, leaseOwner);
      if (!task) break;
      const operation = launch(task).finally(() => active.delete(operation));
      active.add(operation);
    }

    if (active.size === 0) break;
    await Promise.race(active);
  }

  return { completed, failed };
}