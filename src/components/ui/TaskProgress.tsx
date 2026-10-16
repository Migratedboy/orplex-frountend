"use client";
import React from "react";

interface TaskProgressProps {
  current: number;
  total: number;
  currentFile?: string;
  status: "running" | "paused" | "done" | "error";
  /** Unit label for the counter ("files", "tasks", …). Defaults to "files". */
  unit?: string;
}

export default function TaskProgress({ current, total, currentFile, status, unit = "files" }: TaskProgressProps) {
  if (total === 0) return null;
  const percent = Math.round((current / total) * 100);

  return (
    <div className="tp-card">
      <div className="tp-head">
        <span>{status === "done" ? "Complete" : status === "error" ? "Error" : "Generating…"}</span>
        <span className="tp-count">{current}/{total} {unit}</span>
      </div>
      <div className="tp-body">
        <div className="tp-track">
          <div
            className={`tp-fill${
              status === "done" ? " tp-fill--done" : status === "error" ? " tp-fill--error" : ""
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        {currentFile && status === "running" && (
          <p className="tp-file">Writing: {currentFile}</p>
        )}
      </div>
    </div>
  );
}
