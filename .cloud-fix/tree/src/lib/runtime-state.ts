// runtime-state.ts — Cross-bundle runtime state singleton.
//
// In `next dev` each route/entry can get its OWN instance of a module (per-
// bundle compilation), so module-level `let` state in executor.ts/backup.ts/
// cron-reset.ts is invisible to other consumers — the /api/admin/system route
// would report "not running" while the executor demonstrably runs. This is
// the same dev-mode duplication problem prisma.ts solves with globalThis.
//
// Everything operational that must be process-wide lives on ONE object stored
// on globalThis (dev) / module scope (prod, single bundle). Consumers mutate
// fields directly; api/admin/system reads them. Not a lock, not a queue — a
// mutable status snapshot.

export type RuntimeLogLevel = "info" | "warn" | "error";
export type RuntimeComponent = "executor" | "backup" | "cron" | "server" | "workspace" | "hardware" | "janitor";

export interface RuntimeLogEntry {
  ts: string;
  component: RuntimeComponent;
  level: RuntimeLogLevel;
  message: string;
}

export interface ExecutorRuntimeState {
  running: boolean;
  startedAt: string | null;
  lastPollAt: string | null;
  inFlight: number;
  claimed: number;
  completed: number;
  failed: number;
}

export interface BackupRuntimeState {
  lastBackupAt: string | null;
  lastBackupError: string | null;
  /** Backup-cron lifecycle: does the setInterval loop exist in this process? */
  cronRunning: boolean;
  /** Last time fullBackupCycle ran (success OR failure) — proves the cron ticks. */
  lastCronTickAt: string | null;
  /** Success/failure of the most recent backup attempt ("ok" | "failed" | "unconfigured" | null). */
  lastBackupOutcome: "ok" | "failed" | "unconfigured" | null;
  /** Human-readable one-liner of the latest attempt (error text or "file (N MB)"). */
  lastBackupMessage: string | null;
}

export interface CronRuntimeState {
  scheduled: boolean;
  lastResetAt: string | null;
  nextResetAt: string | null;
}

export interface WorkspaceRuntimeState {
  /** Times the git-worktree path FAILED and silently degraded to a copy. */
  fallbackCount: number;
  lastFallbackAt: string | null;
  lastFallbackReason: string | null;
}

export interface HardwareRuntimeState {
  pressure: "ok" | "elevated" | "high" | "critical";
  lastCheckAt: string | null;
  usedRatio: number;
  rssBytes: number;
  freememBytes: number;
  totalBytes: number;
}

export interface JanitorRuntimeState {
  lastSweepAt: string | null;
  lastResult: { candidates: number; deleted: number; bytesFreed: number; skipped: string[] } | null;
  running: boolean;
}

export interface RuntimeState {
  logs: RuntimeLogEntry[];
  executor: ExecutorRuntimeState;
  backup: BackupRuntimeState;
  cron: CronRuntimeState;
  workspaces: WorkspaceRuntimeState;
  hardware: HardwareRuntimeState;
  janitor: JanitorRuntimeState;
}

const globalForRuntime = globalThis as unknown as { __orplexRuntimeState?: Partial<RuntimeState> };

function freshState(): RuntimeState {
  return {
    logs: [],
    executor: { running: false, startedAt: null, lastPollAt: null, inFlight: 0, claimed: 0, completed: 0, failed: 0 },
    backup: { lastBackupAt: null, lastBackupError: null, cronRunning: false, lastCronTickAt: null, lastBackupOutcome: null, lastBackupMessage: null },
    cron: { scheduled: false, lastResetAt: null, nextResetAt: null },
    workspaces: { fallbackCount: 0, lastFallbackAt: null, lastFallbackReason: null },
    hardware: { pressure: "ok", lastCheckAt: null, usedRatio: 0, rssBytes: 0, freememBytes: 0, totalBytes: 0 },
    janitor: { lastSweepAt: null, lastResult: null, running: false },
  };
}

// Merge (not blindly reuse) any stored state: a persisted instance created by
// OLDER code (missing newer sections like `hardware`/`janitor`) must not
// break newer readers — HMR can mix bundle generations within one dev process.
function hydrateState(): RuntimeState {
  const base = freshState();
  const stored = globalForRuntime.__orplexRuntimeState;
  if (!stored) return base;
  return {
    logs: stored.logs ?? base.logs,
    executor: { ...base.executor, ...stored.executor },
    backup: { ...base.backup, ...stored.backup },
    cron: { ...base.cron, ...stored.cron },
    workspaces: { ...base.workspaces, ...stored.workspaces },
    hardware: { ...base.hardware, ...stored.hardware },
    janitor: { ...base.janitor, ...stored.janitor },
  };
}

export const runtimeState: RuntimeState = hydrateState();

// Persist across dev-mode bundle instances (same trick as globalForPrisma).
if (process.env.NODE_ENV !== "production") globalForRuntime.__orplexRuntimeState = runtimeState;
