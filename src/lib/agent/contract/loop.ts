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
  type LoopStreaks,
  type CallTarget,
  type LoopVerdict,
} from "../../loop-detect";
