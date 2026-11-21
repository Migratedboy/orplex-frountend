"use client";

/**
 * ActionApprovalCard — the pre-existing approval card for NON-command actions
 * (file writes, edits, MCP tools, plan gates on writes).
 *
 * Split out of the deleted ApprovalDialog unchanged: same markup, same
 * .approval-* styles, same buttons. Command approvals moved to
 * CommandApprovalCard, so the old dialog's command branch is gone.
 */
import { useState } from "react";
import type { PendingApproval } from "@/lib/approval-store";
import type { ApprovalChoice } from "@/lib/approval-decision";

type RiskLevel = "low" | "medium" | "high";

const RISK_STYLES: Record<RiskLevel, { label: string; className: string; icon: string }> = {
  low: { label: "Low risk", className: "approval-risk-low", icon: "-" },
  medium: { label: "Standard review", className: "approval-risk-medium", icon: "!" },
  high: { label: "Elevated risk", className: "approval-risk-high", icon: "!!" },
};

export interface ActionApprovalCardProps {
  approval: PendingApproval;
  /** A decision is in flight — buttons must not resolve twice. */
  busy: boolean;
  onDecide: (choice: ApprovalChoice) => void;
}

export default function ActionApprovalCard({ approval, busy, onDecide }: ActionApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isWrite = approval.type === "write_file";
  const isEdit = approval.type === "edit_file";
  const rawPath = approval.details.path;
  const path = typeof rawPath === "string" ? rawPath : rawPath != null ? JSON.stringify(rawPath) : undefined;

  // Risk tier — defaults to medium for legacy approvals without a tier
  const risk: RiskLevel = approval.risk || "medium";
  const riskStyle = RISK_STYLES[risk];
  const hasDiff = Boolean(approval.diff);

  return (
    <div className="approval-overlay">
      <div className={`approval-dialog ${riskStyle.className}`} role="dialog" aria-modal="true" aria-label={approval.summary}>
        <div className="approval-header">
          <div className="approval-icon">
            {isWrite ? "+" : isEdit ? "~" : "!"}
          </div>
          <div className="approval-title">
            {isWrite ? "Write File" : isEdit ? "Edit File" : "Approve Action"}
          </div>
          <span className={`approval-risk-badge approval-risk-${risk}`}>
            <span className="approval-risk-glyph" aria-hidden="true">{riskStyle.icon}</span>
            {riskStyle.label}
          </span>
        </div>

        {risk === "high" && (
          <div className="approval-risk-warning" role="alert">
            <strong>{approval.riskReason || "Elevated risk"}</strong>. Review this
            action carefully — it may affect system configuration, secrets, or
            delete substantial work.
          </div>
        )}
        {risk === "medium" && approval.riskReason && (
          <div className="approval-risk-note">{approval.riskReason}</div>
        )}

        <div className="approval-summary">{approval.summary}</div>

        {path && (
          <div className="approval-path">
            <span className="approval-path-label">File:</span>
            <span className="approval-path-value">{path}</span>
          </div>
        )}

        {hasDiff && (
          <>
            <button
              className="approval-expand-btn"
              type="button"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide diff" : "Show diff"}
            </button>
            {expanded && (
              <pre className="approval-diff">
                <code>{approval.diff}</code>
              </pre>
            )}
          </>
        )}

        <div className="approval-actions">
          <button
            className="approval-reject"
            type="button"
            disabled={busy}
            onClick={() => onDecide("deny")}
          >
            Reject
          </button>
          <button
            className="approval-always"
            type="button"
            disabled={busy}
            onClick={() => onDecide("always")}
            title="Approve and skip this dialog for identical future actions"
          >
            Always allow
          </button>
          <button
            className="approval-approve"
            type="button"
            disabled={busy}
            onClick={() => onDecide("allow")}
            autoFocus={risk !== "high"}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
