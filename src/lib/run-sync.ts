// run-sync.ts — Best-effort browser-side mirror of live agent tasks into durable
// AgentRun rows, so reloads, the manager page, and the runs board reflect real work.
//
// Every background task (one per chat send) creates an AgentRun via the existing
// POST /api/agent/runs endpoint, then checkpoints a terminal status when the task
// settles. All failures are swallowed — durability must never block chat.
//
// Runs only in the browser (needs the session cookie + fetch); no-ops under
// Node/SSR/jest so unit tests and server-side imports are unaffected.

import type { BackgroundTask } from "./background-chat";
import { apiFetch } from "@/lib/api-base";

interface SyncRecord {
  /** In-flight create call — resolves to the run id (or null on failure). */
  create: Promise<string | null>;
  /** True once a terminal checkpoint has been sent (or skipped). */
  settled: boolean;
}

const records = new Map<string, SyncRecord>();

/**
 * Drop records for tasks that can no longer report a terminal status.
 *
 * background-worker has several early returns (abort, superseded by a newer
 * task) that bypass completeTask/failTask - the only callers of the cleanup
 * path. Without this, a record - and its plan-gate latch - survived forever, and
 * the run also never recorded its terminal status on the AgentRun row. Bounded by
 * running this periodically, so it cannot grow without limit.
 */
export function sweepDeadTaskRecords(liveIds: Set<string>): number {
  let dropped = 0;
  for (const id of Array.from(records.keys())) {
    if (!liveIds.has(id)) {
      records.delete(id);
      dropped++;
    }
  }
  return dropped;
}

function canSync(): boolean {
  return typeof window !== "undefined" && typeof fetch === "function";
}

async function createRun(task: BackgroundTask): Promise<string | null> {
  try {
    const res = await apiFetch("/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: task.userMessage || "Agent task",
        mode: "code",
        autonomyPolicy: "approval",
        executionTarget: "client",
      }),
      // Never let durability slow the chat down
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success && data?.run?.id) {
      return data.run.id as string;
    }
    return null;
  } catch {
    return null;
  }
}

/** Begin tracking a freshly started task (call once, right after startTask). */
export function trackTaskStart(task: BackgroundTask): void {
  // Only mirror agentic work (code/plan/multi-agent) as runs. Plain "ask"
  // Q&A has no tools/artifacts and is already persisted as a conversation.
  if (!canSync() || task.mode === "ask" || records.has(task.id)) return;
  records.set(task.id, { create: createRun(task), settled: false });
}

/**
 * Checkpoint a terminal state (done / error / cancelled). Idempotent: only the
 * first terminal call for a task writes; later duplicates are ignored.
 */
export async function trackTaskEnd(task: BackgroundTask): Promise<void> {
  if (!canSync()) return;
  const rec = records.get(task.id);
  if (!rec || rec.settled) return;
  rec.settled = true;

  // Wait for the create to finish (a task can settle before the POST resolves).
  const runId = await rec.create.catch(() => null);
  records.delete(task.id);
  if (!runId) return; // never created (unauthenticated / offline / failure)

  const status = task.aborted
    ? "cancelled"
    : task.status === "done"
      ? "completed"
      : "failed";

  const payload: Record<string, unknown> = { status };
  // Telemetry: how many workspace learnings were injected into this task's
  // prompt (worker stamps it on the task; 0 when retrieval never fired).
  const memoriesUsed = (task as BackgroundTask & { memoriesUsed?: number }).memoriesUsed ?? 0;
  if (task.displayContent) {
    payload.result = {
      content: task.displayContent.slice(0, 200000),
      ...(task.error ? { error: task.error.slice(0, 1000) } : {}),
      memoriesUsed,
    };
  } else if (task.error) {
    payload.result = { error: task.error.slice(0, 1000), memoriesUsed };
  }

  try {
    await apiFetch(`/api/agent/runs/${runId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Best effort — ignore network failures
  }
}
