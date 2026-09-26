// plan-gate.ts — The hard plan-approval latch (Claude Code parity).
//
// In plan mode the agent MUST present a plan and WAIT for explicit user
// approval before any state-changing tool runs. The latch is a small
// module-level map: taskId → approved?, flipped only by the approval
// decision. Writes before approval are refused with a tool result the model
// can read and adapt to (same UX as toolHooks deny / the plan-first gate).
//
// Server-executor parity: the executor checks ApprovalRequest.status in the
// DB (its approvals flow through /api/agent/approve), so this module also
// exposes seedApproved() for the route that records the DB decision.

type LatchState = "unlatched" | "approved" | "rejected";

const latches = new Map<string, LatchState>();

/** Test hook. */
export function resetPlanGate(): void {
  latches.clear();
}

export function isPlanApproved(taskId: string): boolean {
  return latches.get(taskId) === "approved";
}

export function isPlanRejected(taskId: string): boolean {
  return latches.get(taskId) === "rejected";
}

/** The user approved the plan — the latch opens for this task. */
export function approvePlan(taskId: string): void {
  latches.set(taskId, "approved");
}

/** The user rejected — the agent must re-plan (latch stays closed). */
export function rejectPlan(taskId: string): void {
  latches.set(taskId, "rejected");
}

/** A finished/cleared task drops its latch (bounded map). */
export function clearPlanLatch(taskId: string): void {
  latches.delete(taskId);
}

const WRITE_TOOLS = new Set(["write_file", "edit_file", "run_command", "move_file", "delete_file"]);

/**
 * Should this tool call be blocked by the plan latch? Only meaningful in
 * plan mode — callers gate the call itself.
 */
export function planGateBlocks(taskId: string, toolName: string): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false;
  return !isPlanApproved(taskId);
}

export function planGateMessage(toolName: string): string {
  return (
    `BLOCKED by plan gate: in plan mode, ${toolName} requires an approved plan. ` +
    `Present your plan (todo_list + a clear proposal), then wait for the user's approval. ` +
    `If the plan was rejected, revise it before retrying.`
  );
}
