"use client";

import { useState, useEffect, useRef } from "react";
import ProgressBar from "./ProgressBar";
import StepList, { type Step } from "./StepList";
import AgentActivityLog, { type ActivityEntry } from "./AgentActivityLog";

interface AgentProgressProps {
  /** Current status text */
  status?: string;
  /** Agent name (coordinator, planner, coder, etc.) */
  agent?: string;
  /** 0-100 progress */
  progress: number | null;
  /** Steps being executed */
  steps?: Step[];
  /** Activity log entries */
  activityLog?: ActivityEntry[];
  /** Whether the process is still running */
  isRunning: boolean;
  /** Elapsed time in ms */
  elapsed?: number;
}

export default function AgentProgress({
  status = "Processing...",
  agent,
  progress,
  steps = [],
  activityLog = [],
  isRunning,
  elapsed,
}: AgentProgressProps) {
  const [showLog, setShowLog] = useState(false);

  if (!isRunning && steps.length === 0 && activityLog.length === 0) return null;

  return (
    <div className="agent-progress-upgraded" aria-live="polite">
      {/* Progress bar with timer */}
      <ProgressBar
        progress={progress}
        status={status}
        agent={agent}
        elapsed={elapsed}
        isRunning={isRunning}
      />

      {/* Step list (collapsible) */}
      {steps.length > 0 && (
        <StepList steps={steps} defaultCollapsed={steps.length > 8} />
      )}

      {/* Activity log toggle */}
      {activityLog.length > 0 && (
        <>
          <button
            className="activity-log-toggle"
            onClick={() => setShowLog(!showLog)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 17 10 11 4 5" />
            </svg>
            <span>{showLog ? "Hide" : "Show"} activity log ({activityLog.length})</span>
          </button>
          {showLog && (
            <AgentActivityLog
              entries={activityLog}
              isRunning={isRunning}
              maxHeight={160}
            />
          )}
        </>
      )}
    </div>
  );
}
