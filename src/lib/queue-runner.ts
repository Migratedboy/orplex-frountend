// queue-runner.ts — The Manager→execution bridge.
//
// Runs spawned from the Manager board used to be rows that nothing executed.
// This module closes that loop: when the browser tab is NOT already running a
// chat task, it claims the oldest pending Manager-spawned run and feeds it to
// the same runInBackground loop a chat send uses. Sequencing is guaranteed by
// claiming one at a time (TPM-safe on free providers); concurrency across
// tabs is arbitrated server-side by the claim CAS.
//
// Scope guards: browser-only, and hard-disabled during tests
// (window.__ORPLEX_TEST__).

import { getCurrentTask } from "./background-chat";
import { apiFetch } from "@/lib/api-base";

const CLAIM_POLL_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Modes safe to run concurrently (no workspace writes by design). */
const PARALLEL_SAFE_MODES = new Set(["ask", "plan"]);

/**
 * Concurrency: 1 (default) = strict serial queue — required on free providers
 * sharing one TPM window. Users can opt into parallelism for read-only tasks
 * via localStorage (orplex.queue.concurrency = 2..3). Write tasks NEVER run
 * in parallel from the client: real isolation needs server-side workspaces
 * (parallel-workspaces + git worktrees), which is the server-executor path.
 */
function getConcurrency(): number {
  if (typeof window === "undefined") return 1;
  const n = parseInt(localStorage.getItem("orplex.queue.concurrency") || "1", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 3) : 1;
}

/** Same surface the chat page passes to runInBackground (subset it uses). */
export interface QueueFS {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<boolean>;
  editFile: (path: string, oldText: string, newText: string) => Promise<boolean>;
  directoryName: string | null;
  fileTree: unknown;
  fileContents: Record<string, string>;
}

let fsAccess: QueueFS | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let activeRuns = 0;
let consecutiveFailures = 0;
let unsub: (() => void) | null = null;

function canRun(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __ORPLEX_TEST__?: boolean }).__ORPLEX_TEST__ !== true &&
    typeof fetch === "function"
  );
}

function snapshotTaskEnd(runId: string): "completed" | "failed" {
  const task = getCurrentTask();
  if (!task) return "completed";
  if (task.status === "error") return "failed";
  return "completed";
}

async function claimAndRun(): Promise<void> {
  if (activeRuns >= getConcurrency()) return;
  activeRuns++;
  let detached = false;

  try {
    const res = await apiFetch("/api/agent/runs/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    const run = data?.run;
    if (!run) {
      consecutiveFailures = 0;
      return; // queue empty — stay idle
    }

    const { runInBackground } = await import("./background-worker");

    // Chat-mode tasks occupy the single foreground loop: they must run
    // exclusively. ask/plan can go parallel (concurrency > 1) detached.
    const canDetach =
      PARALLEL_SAFE_MODES.has(run.mode || "code") && getConcurrency() > 1;
    detached = canDetach;

    const promise = runInBackground(
      run.prompt,
      null, // new conversation per queued run
      [],
      run.mode || "code",
      [],
      undefined, // fullPrompt
      undefined, // effort
      { autoVerify: true }
    );

    const checkpoint = async () => {
      await promise.catch(() => {});
      const task = getCurrentTask();
      const finalStatus = task?.status === "error" ? "failed" : "completed";
      await apiFetch(`/api/agent/runs/${run.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: finalStatus }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
      activeRuns--;
      consecutiveFailures = 0;
    };

    if (detached) {
      void checkpoint(); // parallel lane — don't block the slot
    } else {
      await checkpoint(); // serial lane — occupy the slot to completion
    }
  } catch {
    consecutiveFailures++;
    if (!detached) activeRuns--;
    // Repeated claim failures back off via the breaker in the tick below.
  }
}

/** Start polling (no-op if already started, in tests, or server-side). */
export function startQueueRunner(): void {
  if (!canRun() || timer) return;
  timer = setInterval(() => {
    // Never claim while a chat task occupies the foreground loop.
    if (getCurrentTask()) return;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    void claimAndRun();
  }, CLAIM_POLL_MS);
  timer.unref?.();
}

/** Stop polling. */
export function stopQueueRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (unsub) {
    unsub();
    unsub = null;
  }
}

/**
 * Inject real FS access (called by QueueRunnerProvider). Manager-spawned
 * tasks use the SAME audited FS path as chat tasks — a queued run has exactly
 * the permissions of a chat send.
 */
export function setQueueFileSystemAccess(fs: QueueFS): void {
  fsAccess = fs;
  import("./background-worker")
    .then(({ setFileSystemAccess }) => {
      setFileSystemAccess(
        fs.readFile,
        fs.writeFile,
        fs.editFile,
        fs.fileTree as never,
        fs.fileContents,
        fs.directoryName || ""
      );
    })
    .catch(() => {});
}

/** Test/reset hook. */
export function resetQueueRunnerForTests(): void {
  stopQueueRunner();
  activeRuns = 0;
  consecutiveFailures = 0;
}
