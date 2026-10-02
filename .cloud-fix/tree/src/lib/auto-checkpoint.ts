// auto-checkpoint.ts — Claude-Code-grade rewind granularity, laptop-sized.
//
// A checkpoint is taken BEFORE the first mutating write to each distinct
// file (so the pre-write state is always restorable), with three caps that
// keep an 8GB machine happy:
//   cooldownMs  — bursty agents editing one file repeatedly don't spam
//                 git tree-commits (default 15s per file)
//   maxPerRun   — hard queue cap; once reached, only checkpoints for
//                 never-before-seen files still happen... until the cap
//                 halts auto checkpoints entirely (explicit/rewind-requested
//                 checkpoints are unaffected)
//   RAM guard   — under high memory pressure (the hardware watchdog),
//                 auto checkpoints pause entirely; durability yields to
//                 stability, exactly like claims and verify lanes.
//
// Pure decision logic here (fully unit-testable, no fs); the executor owns
// the side effects (createCheckpoint + DB + event emission).

import { isMemoryPressureHigh } from "./hardware";

export const AUTO_CP_COOLDOWN_MS_DEFAULT = 15_000;
export const AUTO_CP_MAX_PER_RUN_DEFAULT = 20;
/** Delta bytes accumulated since the last auto checkpoint that make the
 * next checkpoint "cheap enough" to skip the cooldown entirely. Small diffs
 * cost almost nothing in git (tree-commit shares unchanged blobs), so edit
 * bursts under this threshold checkpoint every time. */
export const AUTO_CP_DELTA_BYTES_DEFAULT = 50 * 1024;

export function autoCpDeltaBytes(): number {
  const raw = Number(process.env.ORPLEX_AUTO_CHECKPOINT_DELTA_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : AUTO_CP_DELTA_BYTES_DEFAULT;
}

export function autoCpCooldownMs(): number {
  const raw = Number(process.env.ORPLEX_AUTO_CHECKPOINT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : AUTO_CP_COOLDOWN_MS_DEFAULT;
}

export function autoCpMaxPerRun(): number {
  const raw = Number(process.env.ORPLEX_AUTO_CHECKPOINT_MAX_PER_RUN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUTO_CP_MAX_PER_RUN_DEFAULT;
}

export function autoCheckpointsEnabled(): boolean {
  return process.env.ORPLEX_AUTO_CHECKPOINTS !== "0";
}

export interface AutoCheckpointState {
  lastAtByFile: Map<string, number>; // workspace-relative path → last auto-cp time
  countThisRun: number;
  halted: boolean; // cap reached — stop auto checkpoints for this run
  deltaSinceLastCp: number; // bytes written/edited since the last checkpoint
}

export function newAutoCheckpointState(): AutoCheckpointState {
  return { lastAtByFile: new Map(), countThisRun: 0, halted: false, deltaSinceLastCp: 0 };
}

export interface AutoCheckpointDecision {
  take: boolean;
  reason:
    | "disabled"
    | "memory-pressure"
    | "halted-cap"
    | "cooldown"
    | "already-covered"
    | "take";
}

/**
 * Decide whether a pre-write auto checkpoint should run for `path` now.
 * `now` and `incomingBytes` are injectable for tests. Rules in priority order:
 *   1. env kill-switch
 *   2. memory pressure (hardware watchdog high)
 *   3. per-run cap (latched)
 *   4. per-file cooldown — BYPASSED when the accumulated delta since the
 *      last checkpoint is under the cheap-diff threshold (small git diffs
 *      cost almost nothing, so checkpoint every write in that regime)
 */
export function shouldAutoCheckpoint(
  state: AutoCheckpointState,
  path: string,
  now: number,
  opts?: { cooldownMs?: number; maxPerRun?: number; enabled?: boolean; memoryHigh?: boolean; deltaBytesThreshold?: number }
): AutoCheckpointDecision {
  const enabled = opts?.enabled ?? autoCheckpointsEnabled();
  if (!enabled) return { take: false, reason: "disabled" };

  const memoryHigh = opts?.memoryHigh ?? isMemoryPressureHigh();
  if (memoryHigh) return { take: false, reason: "memory-pressure" };

  const max = opts?.maxPerRun ?? autoCpMaxPerRun();
  if (state.halted || state.countThisRun >= max) {
    state.halted = true;
    return { take: false, reason: "halted-cap" };
  }

  const last = state.lastAtByFile.get(path);
  if (last !== undefined) {
    const cooldown = opts?.cooldownMs ?? autoCpCooldownMs();
    const threshold = opts?.deltaBytesThreshold ?? autoCpDeltaBytes();
    const cheapDiff = state.deltaSinceLastCp < threshold;
    if (now - last < cooldown && !cheapDiff) {
      return { take: false, reason: "cooldown" };
    }
  }

  return { take: true, reason: "take" };
}

/** Accumulate the payload size of a write/edit into the run's delta counter.
 * Call BEFORE the decision for the current write so its own bytes count. */
export function accumulateDelta(state: AutoCheckpointState, bytes: number): void {
  if (Number.isFinite(bytes) && bytes > 0) state.deltaSinceLastCp += bytes;
}

/**
 * Record that an auto checkpoint for `path` was taken at `now`.
 * Only call after a SUCCESSFUL createCheckpoint. Resets the delta window —
 * the next cooldown comparison starts from zero accumulated change.
 */
export function recordAutoCheckpoint(state: AutoCheckpointState, path: string, now: number): void {
  state.lastAtByFile.set(path, now);
  state.countThisRun++;
  state.deltaSinceLastCp = 0;
}

/** Reset per-run state (also used by tests). */
export function resetAutoCheckpointState(state: AutoCheckpointState): void {
  state.lastAtByFile.clear();
  state.countThisRun = 0;
  state.halted = false;
  state.deltaSinceLastCp = 0;
}
