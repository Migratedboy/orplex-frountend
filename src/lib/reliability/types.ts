/**
 * reliability/types.ts — shared types for the reliability gate pipeline.
 * Split out so edit-lock.ts and gates.ts can depend on a common shape without
 * a circular import.
 */

/**
 * A verification lane. `test` is NEW (D-7): rubric-recorder's computeVerdict
 * models typecheck/browser/swarm but its lane union has no `test` member, so
 * jest results could never reach the verdict. Adding it is additive and matches
 * master-prompt rule 4 (new lanes alongside, old ones untouched).
 */
export type LaneName = "typecheck" | "lint" | "test" | "browser" | "swarm";

/**
 * `skipped` means the lane did not run. It is NEVER a pass. This mirrors the
 * careful semantics already in background-worker.ts:1872, where an unreachable
 * exec route records "skipped" precisely so computeVerdict treats it as
 * never-a-pass.
 */
export type LaneOutcome = "pass" | "fail" | "skipped";

export interface LaneResult {
  lane: LaneName;
  outcome: LaneOutcome;
  /** Summarized findings for display / the repair prompt. "" when clean. */
  findings: string;
  /** Real exit code, or null when the lane could not execute at all. */
  exitCode: number | null;
  durationMs: number;
  /**
   * True when the lane failed AND every one of its errors was already present
   * in the pre-task baseline. A pre-existing failure is not this task's fault
   * and does not block by default.
   */
  preExisting: boolean;
  /** Error signatures NOT present in the baseline — this task's fault. */
  newErrors: string[];
  /** Error signatures that WERE present in the baseline. */
  baselineErrors: string[];
  /** Baseline errors that this run resolved (present before, gone now). */
  resolvedErrors?: string[];
  /** Why the lane was skipped, when outcome === "skipped". */
  skipReason?: string;
}

/**
 * The pre-task snapshot. Captured once, before the first write, by
 * gates.captureBaseline. Without it the gate cannot distinguish a regression
 * from a pre-existing failure.
 */
export interface WorkspaceBaseline {
  capturedAt: number;
  typecheck: {
    ran: boolean;
    exitCode: number | null;
    /** Normalized `path:TSxxxx` signatures. */
    errors: string[];
  } | null;
}

/**
 * The injected command runner. The gate pipeline never talks to the network or
 * the exec route directly — the caller (the worker) passes this in, which is
 * what makes the pipeline testable with a scripted sequence and what keeps the
 * client-bundle import graph free of Node builtins.
 */
export type GateExec = (
  command: string,
  timeoutMs: number,
) => Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
