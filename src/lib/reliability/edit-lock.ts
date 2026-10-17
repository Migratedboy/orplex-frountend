/**
 * reliability/edit-lock.ts — plan §6.2. When a gate lane is red, refuse further
 * mutations until a repair turns it green.
 *
 * Why this exists: before this module, a failed typecheck was *displayed* and
 * the loop kept writing. The plan's central claim — "the pipeline detects,
 * reports, annotates, and remembers. It does not gate" — is exactly the gap
 * this closes. The lock is the mechanism that turns a detection into a refusal.
 *
 * Scope: per-task, in-memory, server-agnostic. The lock is held by whichever
 * process owns the task (today the client worker). It is deliberately NOT
 * persisted: a lock that survives a reload would refuse writes with no pipeline
 * able to clear it, wedging the workspace.
 *
 * Lifecycle: acquire on first red gate → refuse mutations → release when a
 * repair run turns every red lane green, or when the task ends. A task that
 * ends red does NOT leave the lock held (see releaseOnTaskEnd).
 */

export interface EditLockState {
  taskId: string;
  /** Lanes currently red. Emptied when a repair clears them. */
  redLanes: Set<string>;
  /** Human-readable reason for the UI, refreshed on each acquire. */
  reason: string;
  acquiredAt: number;
  /** How many times a write was refused while locked — surfaced in the report. */
  refusedWrites: number;
}

const locks = new Map<string, EditLockState>();

/**
 * Mark a lane red and take the lock for this task. Idempotent per lane: a
 * second failure on the same lane refreshes the reason and timestamp but does
 * not double-count refused writes.
 *
 * Returns the lock state, or null when no lock is held (nothing red).
 */
export function acquireEditLock(taskId: string, lane: string, reason: string): EditLockState {
  let state = locks.get(taskId);
  if (!state) {
    state = { taskId, redLanes: new Set(), reason, acquiredAt: Date.now(), refusedWrites: 0 };
    locks.set(taskId, state);
  }
  state.redLanes.add(lane);
  state.reason = reason;
  state.acquiredAt = Date.now();
  return state;
}

/**
 * Turn a lane green. When the last red lane clears, the lock releases and
 * writes flow again. Returns true when the lock was released by this call.
 */
export function clearLane(taskId: string, lane: string): boolean {
  const state = locks.get(taskId);
  if (!state) return false;
  state.redLanes.delete(lane);
  if (state.redLanes.size === 0) {
    locks.delete(taskId);
    return true;
  }
  return false;
}

/**
 * True when a mutation should be refused. The caller (the write path) checks
 * this BEFORE touching the filesystem and returns an explicit refusal to the
 * model rather than silently dropping the write.
 */
export function isEditLocked(taskId: string): EditLockState | null {
  return locks.get(taskId) ?? null;
}

/**
 * Count a refused write against the lock so the Verification Report can state
 * how many mutations were blocked, not just that some were.
 */
export function recordRefusedWrite(taskId: string): void {
  const state = locks.get(taskId);
  if (state) state.refusedWrites += 1;
}

/**
 * Drop the lock unconditionally. Called when a task ends (done, error, or
 * aborted) so a red close does not leak a lock into the next task.
 */
export function releaseEditLock(taskId: string): void {
  locks.delete(taskId);
}

/** Snapshot for the Verification Report / tests. */
export function getEditLock(taskId: string): EditLockState | null {
  return locks.get(taskId) ?? null;
}

/** Test hook: clear every lock. */
export function resetEditLocksForTests(): void {
  locks.clear();
}
