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

  // A remembered "Always allow" rule silently approves identical requests
  // (never high-risk ones — those always require explicit review).
  if (assessment.level !== "high" && hasAlwaysRule(type, details)) {
    return Promise.resolve(true);
  }

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

    // Auto-reject after 5 minutes. Unref'd where available (node/jest) so a
    // pending approval never keeps the process alive — in the browser the
    // timer handle is a plain number and this is a no-op.
    const rejectTimer = setTimeout(() => {
      const a = pending.get(id);
      if (a && a.status === "pending") {
        a.status = "rejected";
        a.resolve?.(false);
        pending.delete(id);
      }
    }, 5 * 60 * 1000);
    if (typeof rejectTimer === "object" && rejectTimer && "unref" in rejectTimer) {
      (rejectTimer as { unref: () => void }).unref();
    }
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

// ---------------------------------------------------------------------------
// "Always allow" rules — remembered per (type, key) so the user doesn't have
// to re-approve identical actions every turn. Persisted to localStorage when
// available (browser) so they survive reloads.
// ---------------------------------------------------------------------------

interface AlwaysRule {
  type: ApprovalType;
  /** Command head (first two words) for commands; normalized path for files */
  key: string;
}

const ALWAYS_KEY = "orplex:always-allow";

function loadAlwaysRules(): AlwaysRule[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(ALWAYS_KEY);
    return raw ? (JSON.parse(raw) as AlwaysRule[]) : [];
  } catch {
    return [];
  }
}

function saveAlwaysRules(rules: AlwaysRule[]): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ALWAYS_KEY, JSON.stringify(rules));
  } catch {}
}

/** Stable identity of an approval for "always allow" matching. */
export function approvalKey(type: ApprovalType, details: Record<string, unknown>): string {
  if (type === "run_command") {
    return String(details.command || "").trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  }
  return String(details.path || "").replace(/\\/g, "/");
}

/**
 * Approve AND remember: resolves this request and stores a rule so identical
 * future actions (same command head / file path) skip the dialog. High-risk
 * actions are never auto-approved by rules.
 */
export function approveRequestAlways(id: string): boolean {
  const a = pending.get(id);
  if (!a || a.status !== "pending") return false;

  if (a.risk !== "high") {
    const rules = loadAlwaysRules();
    const rule: AlwaysRule = { type: a.type, key: approvalKey(a.type, a.details) };
    if (!rules.some(r => r.type === rule.type && r.key === rule.key)) {
      rules.push(rule);
      saveAlwaysRules(rules);
    }
  }

  a.status = "approved";
  a.resolve?.(true);
  pending.delete(id);
  return true;
}

/** True if a matching "always allow" rule exists for this request. */
export function hasAlwaysRule(type: ApprovalType, details: Record<string, unknown>): boolean {
  const key = approvalKey(type, details);
  return loadAlwaysRules().some(r => r.type === type && r.key === key);
}

/** Map a legacy ApprovalType back to the tool name for classification */
function toolForType(type: ApprovalType): string {
  return type === "run_command" ? "run_command" : type; // write_file / edit_file match tool names 1:1
}

/** Get a specific approval by ID */
export function getApproval(id: string): PendingApproval | undefined {
  return pending.get(id);
}
