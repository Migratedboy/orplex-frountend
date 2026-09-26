"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getPendingApprovals,
  approveRequest,
  approveRequestAlways,
  rejectRequest,
  type PendingApproval,
} from "@/lib/approval-store";
import { apiFetch } from "@/lib/api-base";

type RiskLevel = "low" | "medium" | "high";

const RISK_STYLES: Record<RiskLevel, { label: string; className: string; icon: string }> = {
  low: { label: "Low risk", className: "approval-risk-low", icon: "-" },
  medium: { label: "Standard review", className: "approval-risk-medium", icon: "!" },
  high: { label: "Elevated risk", className: "approval-risk-high", icon: "!!" },
};

/**
 * Global approval dialog. Reads pending approvals directly from the in-memory
 * approval store (the background worker runs in this same JS realm, so the
 * store IS the source of truth — the /api/agent/approve poll is kept only as a
 * harmless fallback that adds server-side approvals if any exist).
 */
export default function ApprovalDialog() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const currentIdRef = useRef<string | null>(null);

  // Keep ref in sync
  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);

  const current = approvals.find(a => a.id === currentId) || null;

  // Poll the LOCAL store every 500ms (fast so the dialog feels instant), and
  // merge in any server-side approvals from the API as a fallback.
  useEffect(() => {
    let alive = true;

    const poll = async () => {
      try {
        const local = getPendingApprovals();
        let server: PendingApproval[] = [];
        try {
          const res = await apiFetch("/api/agent/approve");
          if (res.ok) {
            const data = await res.json();
            server = (data.approvals || []) as PendingApproval[];
          }
        } catch {}

        if (!alive) return;

        // Merge, de-dup by id (local wins — it has the live resolver).
        const seen = new Set(local.map(a => a.id));
        const merged = [...local, ...server.filter(a => !seen.has(a.id))];

        if (merged.length > 0) {
          setApprovals(merged);
          if (!currentIdRef.current) {
            setCurrentId(merged[0].id);
          } else if (!merged.some((a: PendingApproval) => a.id === currentIdRef.current)) {
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
    const interval = setInterval(poll, 500);
    return () => { alive = false; clearInterval(interval); };
  }, []); // Empty deps — uses ref for current ID

  const respond = useCallback(async (id: string, action: "approve" | "reject" | "always") => {
    // Approvals live in the local store (same realm as the worker) — resolve
    // there first; the server fallback also gets told for parity.
    if (action === "approve") approveRequest(id);
    else if (action === "always") approveRequestAlways(id);
    else rejectRequest(id);

    try {
      await apiFetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: action === "always" ? "approve" : action }),
      });
    } catch {}

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
  const hasDiff = Boolean(current.diff);

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
        {hasDiff && (
          <>
            <button
              className="approval-expand-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide diff" : "Show diff"}
            </button>
            {expanded && (
              <pre className="approval-diff">
                <code>{current.diff}</code>
              </pre>
            )}
          </>
        )}

        {/* Action buttons — Reject / Always allow / Approve */}
        <div className="approval-actions">
          <button
            className="approval-reject"
            onClick={() => respond(current.id, "reject")}
          >
            Reject
          </button>
          <button
            className="approval-always"
            onClick={() => respond(current.id, "always")}
            title="Approve and skip this dialog for identical future actions"
          >
            Always allow
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
