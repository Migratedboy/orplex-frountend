// approval-store.ts — Manages pending approvals for AI tool calls
// When the AI wants to write a file or run a command, it pauses here
// until the user approves or rejects via the API.
//
// Risk-tiered: low-risk calls are auto-approved before they ever reach this
// store (see risk-classifier.ts). Only medium/high risk calls create dialogs,
// and the dialog renders high-risk ones with elevated styling.

import { classifyRisk, riskRank, type RiskLevel } from "./risk-classifier";

export type ApprovalType = "write_file" | "edit_file" | "run_command";

export interface PendingApproval {
  id: string;
  type: ApprovalType;
  summary: string;       // Human-readable description
  details: Record<string, unknown>; // Full payload (path, content, command, etc.)
  risk: RiskLevel;       // Approval tier — drives dialog styling and ordering
  riskReason: string;    // Why this tier was assigned
  diff?: string;         // For write_file/edit_file: the diff to show
  createdAt: number;
  status: "pending" | "approved" | "rejected";
  resolve?: (approved: boolean) => void; // Promise resolver
}

// In-memory store: approvalId -> PendingApproval
const pending = new Map<string, PendingApproval>();

let _counter = 0;
function nextId(): string {
  return `appr_${Date.now()}_${++_counter}`;
}

/**
 * Request approval for a tool call. Returns a Promise that resolves
 * when the user approves or rejects (or after 5 minutes = auto-reject).
 *
 * Risk tier is derived automatically from the tool name + args; callers may
 * override it via `riskHint` (e.g. run_in_sandbox passes "medium").
 */
export function requestApproval(
  type: ApprovalType,
  summary: string,
  details: Record<string, unknown>,
  diff?: string,
  riskHint?: RiskLevel
): Promise<boolean> {
  const assessment = riskHint
    ? { level: riskHint, reason: "Caller-classified", autoApprovable: false }
    : classifyRisk(toolForType(type), details);

  return new Promise<boolean>((resolve) => {
    const id = nextId();
    const approval: PendingApproval = {
      id,
      type,
      summary,
      details,
      risk: assessment.level,
      riskReason: assessment.reason,
      diff,
      createdAt: Date.now(),
      status: "pending",
      resolve,
    };
    pending.set(id, approval);

    // Auto-reject after 5 minutes
    setTimeout(() => {
      const a = pending.get(id);
      if (a && a.status === "pending") {
        a.status = "rejected";
        a.resolve?.(false);
        pending.delete(id);
      }
    }, 5 * 60 * 1000);
  });
}

/** User approves a pending request */
export function approveRequest(id: string): boolean {
  const a = pending.get(id);
  if (!a || a.status !== "pending") return false;
  a.status = "approved";
  a.resolve?.(true);
  pending.delete(id);
  return true;
}

/** User rejects a pending request */
export function rejectRequest(id: string): boolean {
  const a = pending.get(id);
  if (!a || a.status !== "pending") return false;
  a.status = "rejected";
  a.resolve?.(false);
  pending.delete(id);
  return true;
}

/** Get all pending approvals (for the client to poll), highest risk first */
export function getPendingApprovals(): PendingApproval[] {
  const now = Date.now();
  return Array.from(pending.values())
    .filter(a => a.status === "pending" && (now - a.createdAt) < 5 * 60 * 1000)
    .sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || a.createdAt - b.createdAt)
    .map(a => ({
      ...a,
      resolve: undefined, // Don't serialize the resolver
    }));
}

/** Map a legacy ApprovalType back to the tool name for classification */
function toolForType(type: ApprovalType): string {
  return type === "run_command" ? "run_command" : type; // write_file / edit_file match tool names 1:1
}

/** Get a specific approval by ID */
export function getApproval(id: string): PendingApproval | undefined {
  return pending.get(id);
}
