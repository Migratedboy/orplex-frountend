"use client";

import { useState, useEffect, useCallback, useRef } from "react";

type RiskLevel = "low" | "medium" | "high";

interface PendingApproval {
  id: string;
  type: "write_file" | "edit_file" | "run_command";
  summary: string;
  details: Record<string, unknown>;
  risk?: RiskLevel;
  riskReason?: string;
  diff?: string;
  createdAt: number;
}

const RISK_STYLES: Record<RiskLevel, { label: string; className: string; icon: string }> = {
  low: { label: "Low risk", className: "approval-risk-low", icon: "-" },
  medium: { label: "Standard review", className: "approval-risk-medium", icon: "!" },
  high: { label: "Elevated risk", className: "approval-risk-high", icon: "!!" },
};

export default function ApprovalDialog() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const currentIdRef = useRef<string | null>(null);

  // Keep ref in sync
  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);

  const current = approvals.find(a => a.id === currentId) || null;

  // Poll for pending approvals every 2 seconds — no dependency on `current`
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/agent/approve");
        const data = await res.json();
        if (!alive) return;
        if (data.approvals?.length > 0) {
          setApprovals(data.approvals);
          // Auto-select first approval (server sorts highest-risk first)
          if (!currentIdRef.current) {
            setCurrentId(data.approvals[0].id);
          } else if (!data.approvals.some((a: PendingApproval) => a.id === currentIdRef.current)) {
            // Current approval was resolved — clear it
            setCurrentId(null);
            setExpanded(false);
          }
        } else {
          setApprovals([]);
          setCurrentId(null);
          setExpanded(false);
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(interval); };
  }, []); // Empty deps — uses ref for current ID

  const respond = useCallback(async (id: string, action: "approve" | "reject") => {
    await fetch("/api/agent/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    setCurrentId(null);
    setExpanded(false);
    // Remove from list
    setApprovals(prev => prev.filter(a => a.id !== id));
  }, []);

  if (!current) return null;

  const isCommand = current.type === "run_command";
  const isWrite = current.type === "write_file";
  const isEdit = current.type === "edit_file";
  const rawCommand = current.details.command;
  const rawPath = current.details.path;
  const command = typeof rawCommand === "string" ? rawCommand : rawCommand != null ? JSON.stringify(rawCommand) : undefined;
  const path = typeof rawPath === "string" ? rawPath : rawPath != null ? JSON.stringify(rawPath) : undefined;

  // Risk tier — defaults to medium for legacy approvals without a tier
  const risk: RiskLevel = current.risk || "medium";
  const riskStyle = RISK_STYLES[risk];

  return (
    <div className="approval-overlay">
      <div className={`approval-dialog ${riskStyle.className}`}>
        <div className="approval-header">
          <div className="approval-icon">
            {isCommand ? "$" : isWrite ? "+" : "~"}
          </div>
          <div className="approval-title">
            {isCommand ? "Run Command" : isWrite ? "Write File" : "Edit File"}
          </div>
          <span className={`approval-risk-badge approval-risk-${risk}`}>
            <span className="approval-risk-glyph" aria-hidden="true">{riskStyle.icon}</span>
            {riskStyle.label}
          </span>
        </div>

        {risk === "high" && (
          <div className="approval-risk-warning" role="alert">
            <strong>{current.riskReason || "Elevated risk"}.</strong> Review this
            action carefully — it may affect system configuration, secrets, or
            delete substantial work.
          </div>
        )}
        {risk === "medium" && current.riskReason && (
          <div className="approval-risk-note">{current.riskReason}</div>
        )}

        <div className="approval-summary">{current.summary}</div>

        {/* Command display */}
        {isCommand && command && (
          <pre className="approval-command">{command}</pre>
        )}

        {/* File path */}
        {path && (
          <div className="approval-path">
            <span className="approval-path-label">File:</span>
            <span className="approval-path-value">{path}</span>
          </div>
        )}

        {/* Diff display */}
        {current.diff && (
          <>
            <button
              className="approval-expand-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide changes" : "Show changes"}
            </button>
            {expanded && (
              <pre className="approval-diff">
                <code>{current.diff}</code>
              </pre>
            )}
          </>
        )}

        {/* Action buttons */}
        <div className="approval-actions">
          <button
            className="approval-reject"
            onClick={() => respond(current.id, "reject")}
          >
            Reject
          </button>
          <button
            className="approval-approve"
            onClick={() => respond(current.id, "approve")}
            autoFocus={risk !== "high"}
          >
            Approve
          </button>
        </div>

        {/* Queue indicator */}
        {approvals.length > 1 && (
          <div className="approval-queue">
            +{approvals.length - 1} more pending
          </div>
        )}
      </div>
    </div>
  );
}
