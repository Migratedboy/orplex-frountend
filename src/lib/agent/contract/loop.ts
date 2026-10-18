// contract/loop.ts — Shared loop-detection contract (Step A).
//
// Single import point for streak-based loop detection used by BOTH execution
// modes (interactive client worker + claimed server executor). Re-exports the
// canonical implementation in ../../loop-detect — no logic lives here, so the
// two loops can never drift apart again.
export {
  MAX_SAME_TOOL,
  MAX_SAME_CALL,
  MAX_SAME_TARGET,
  MAX_SAME_TURN,
  READ_ONLY_TOOLS,
  createLoopStreaks,
  stableCallKey,
  callTarget,
  trackToolTurn,
  buildLoopBreakDirective,
  // Phase 5 extensions (loop & progress guard) — same additive contract:
  // pure helpers, no I/O, shared by both lanes.
  OSCILLATION_HISTORY_LIMIT,
  OSCILLATION_MIN_PERIOD,
  OSCILLATION_MAX_PERIOD,
  OSCILLATION_MIN_PERIODS,
  PROGRESS_STALL_STEPS,
  STEP_SNAPSHOT_LIMIT,
  BUDGET_MAX_WALL_MS,
  BUDGET_MAX_TOKENS,
  HARD_DENY_AFTER,
  normalizeCallSignature,
  trackOscillation,
  trackProgress,
  recordBudget,
  checkWallClock,
  recordCallFailure,
  buildHardDenylist,
  buildInterventionDirective,
  type LoopStreaks,
  type CallTarget,
  type LoopVerdict,
  type InterventionRung,
  type InterventionContext,
} from "../../loop-detect";
