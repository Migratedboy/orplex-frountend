"use client";

import { useState, useEffect, useRef } from "react";

interface ProgressBarProps {
  /** 0-100 progress value. If null, shows indeterminate animation */
  progress: number | null;
  /** Current status text */
  status?: string;
  /** Elapsed time in ms — if provided, shows timer */
  elapsed?: number;
  /** Whether the process is still running */
  isRunning?: boolean;
  /** Agent name for display */
  agent?: string;
}

export default function ProgressBar({
  progress,
  status = "Processing...",
  elapsed: externalElapsed,
  isRunning = true,
  agent,
}: ProgressBarProps) {
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime.current);
    }, 100);
    return () => clearInterval(interval);
  }, [isRunning]);

  const displayElapsed = externalElapsed ?? elapsed;
  const seconds = (displayElapsed / 1000).toFixed(1);
  const minutes = Math.floor(displayElapsed / 60000);
  const secs = ((displayElapsed % 60000) / 1000).toFixed(0);
  const timeStr = minutes > 0 ? `${minutes}:${secs.padStart(2, "0")}` : `${seconds}s`;

  return (
    <div className="progress-bar-container">
      {/* Status row */}
      <div className="progress-bar-status">
        <div className="progress-bar-status-left">
          {isRunning && (
            <span className="progress-bar-pulse" />
          )}
          {agent && (
            <span className="progress-bar-agent">{agent}</span>
          )}
          <span className="progress-bar-text">{status}</span>
        </div>
        <div className="progress-bar-status-right">
          {isRunning && (
            <span className="progress-bar-timer">{timeStr}</span>
          )}
          {progress !== null && (
            <span className="progress-bar-pct">{Math.round(progress)}%</span>
          )}
        </div>
      </div>

      {/* Bar */}
      <div className="progress-bar-track">
        {progress !== null ? (
          <div
            className="progress-bar-fill"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        ) : (
          <div className="progress-bar-fill progress-bar-fill--indeterminate" />
        )}
      </div>
    </div>
  );
}
