"use client";

/**
 * QueueTab.tsx — the Queue tab of the right panel: what the agent is doing
 * now. Moved verbatim from RightPanel.tsx (behavior unchanged in P1; the
 * Freebuff visual treatment lands in P2).
 */
import { useState, useEffect, useRef } from "react";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { QueuePanelSkeleton } from "../PanelSkeletons";

export function QueueTab() {
  const { task } = useBackgroundChat();
  // Skeleton only while the first read is in flight. useBackgroundChat starts
  // with task === undefined, which is indistinguishable from "no task" — showing
  // the skeleton on a genuine no-task state would leave it spinning forever, so
  // the skeleton is confined to the very first paint.
  const firstPaint = useRef(true);
  useEffect(() => { firstPaint.current = false; }, []);
  if (!task && firstPaint.current) return <QueuePanelSkeleton />;
  if (!task) return <div className="rp-empty">No active tasks</div>;

  const statusColor = task.status === "done" ? "#22c55e" : task.status === "error" ? "#ef4444" : "#f97316";

  return (
    <div className="rp-queue">
      <div className="rp-queue-item">
        <div className="rp-queue-dot" style={{ background: statusColor }} />
        <div className="rp-queue-info">
          <span className="rp-queue-msg">{task.userMessage.slice(0, 60)}{task.userMessage.length > 60 ? "..." : ""}</span>
          <span className="rp-queue-status">{task.statusDetail || task.status}</span>
        </div>
      </div>
    </div>
  );
}
