/**
 * run-ledger.ts — Browser-side client for the persistent run ledger
 * (task_runs / task_failures in Postgres via /api/agent/ledger).
 *
 * Mission: the agent learns ACROSS RESTARTS. sessionStorage failure-memory
 * dies with the session; the ledger doesn't. At task start the worker pulls
 * this workspace's active failures (with recurrence counts) and hydrates the
 * Failure Doctrine; at finalize it records the run + verdicts + economics.
 *
 * Endpoint note: this used to POST to /api/agent/history, which is the FILE
 * UNDO route (it requires {path, next} and answered 400 to every ledger
 * payload), so cross-restart learning never worked. /api/agent/ledger is the
 * route that accepts { workspaceKey, task, mode, finalStatus, lanes,
 * durationMs } and persists to task_runs / task_failures.
 *
 * Best-effort by design: every call is guarded so a missing session, an
 * unreachable server, an absent route (older deployment), or an old DB schema
 * can never break a task — the worker runs in the browser and a 401/404 here
 * must degrade to { ok:false } / null, never to an unhandled rejection.
 */

import { computeTaskSavings } from "./prompt-meter";
import { getFailures, mergeServerFailures, type FailureRecord, type FailureKind } from "./failure-memory";
import { apiFetch } from "@/lib/api-base";

/** The ledger route. Kept as one constant so POST and GET cannot drift apart. */
export const LEDGER_ENDPOINT = "/api/agent/ledger";

export interface RunLedgerResult {
  ok: boolean;
  error?: string;
}

/** Stable scope for learning: "orplex-local:<folder name or none>". */
export function getWorkspaceKey(directoryName: string | null | undefined): string {
  const folder = (directoryName || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "(no-folder)";
  const machine = typeof process !== "undefined" && process.env?.ORPLEX_MACHINE_ID ? process.env.ORPLEX_MACHINE_ID : "orplex-local";
  return `${machine}:${folder}`.slice(0, 200);
}

/** Build the finalize payload the route expects, from what already exists. */
export function buildFinalizePayload(opts: {
  taskId: string;
  workspaceKey: string;
  task: string;
  mode: string;
  finalStatus: "done" | "error" | "aborted";
  lanes: { typecheck: "pass" | "fail" | "skipped"; browser: "pass" | "fail" | "skipped"; swarm: "pass" | "fail" | "skipped" };
  durationMs: number;
}): Record<string, unknown> {
  const savings = computeTaskSavings(opts.taskId);
  const failures = getFailures();
  const passedLanes = (Object.keys(opts.lanes) as Array<keyof typeof opts.lanes>)
    .filter((k) => opts.lanes[k] === "pass")
    // lane key → failure kind ("typecheck"/"browser" map 1:1; swarm failures
    // are recorded under "review" — a passing swarm resolves nothing extra)
    .map((k) => k as string);

  return {
    workspaceKey: opts.workspaceKey,
    run: {
      task: opts.task,
      mode: opts.mode,
      finalStatus: opts.finalStatus,
      lanes: opts.lanes,
      modelCalls: savings?.calls ?? 0,
      fullCalls: savings?.fullCalls ?? 0,
      compactCalls: savings?.compactCalls ?? 0,
      systemTokensSpent: savings?.systemTokensSpent ?? 0,
      systemTokensFull: savings?.systemTokensFullCounterfactual ?? 0,
      tokensSaved: savings?.tokensSaved ?? 0,
      savedPct: savings?.savedPct ?? 0,
      durationMs: opts.durationMs,
    },
    // Unresolved failures this session still remembers (recurrence counts
    // continue server-side; resolved-by-pass handled via passedLanes).
    failures: failures.map((f) => ({ kind: f.kind, detail: f.detail, files: f.files })),
    passedLanes,
  };
}

/** POST a finished run to the ledger. Resolves {ok:false} on any failure. */
export async function postRunToLedger(payload: Record<string, unknown>): Promise<RunLedgerResult> {
  try {
    const res = await apiFetch(LEDGER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: data?.ok === true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
}

/** Active failure signatures for a workspace, from the server ledger. */
export async function fetchLedgerFailures(workspaceKey: string): Promise<FailureRecord[] | null> {
  try {
    const res = await apiFetch(`${LEDGER_ENDPOINT}?workspaceKey=${encodeURIComponent(workspaceKey)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.failures)) return null;
    return data.failures.map((f: { kind: string; detail: string; files: string[]; count: number; when: number }) => ({
      kind: f.kind as FailureKind,
      detail: f.detail,
      files: Array.isArray(f.files) ? f.files : [],
      count: Number(f.count) || 1,
      when: Number(f.when) || Date.now(),
    }));
  } catch {
    return null;
  }
}

/**
 * Hydrate the session Failure Doctrine from the persistent ledger: merges the
 * server's active signatures into the in-memory store so the FIRST task after
 * a restart already knows what failed last time (recurrence counts preserved).
 */
export async function hydrateFailureMemoryFromLedger(workspaceKey: string): Promise<boolean> {
  const remote = await fetchLedgerFailures(workspaceKey);
  if (!remote || remote.length === 0) return false;
  mergeServerFailures(remote);
  return true;
}
