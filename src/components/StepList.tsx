"use client";

import { useState } from "react";
import { IconCheck, IconX, IconChevronDown } from "./Icons";

export interface Step {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
}

interface StepListProps {
  steps: Step[];
  defaultCollapsed?: boolean;
}

export default function StepList({ steps, defaultCollapsed = false }: StepListProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (!steps || steps.length === 0) return null;

  const completed = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  const allDone = completed === total && total > 0;
  const activeStep = steps.find((s) => s.status === "active");

  return (
    <div className="step-list">
      <button
        className="step-list-header"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <div className="step-list-header-left">
          <div className={`step-list-progress-ring ${allDone ? "done" : ""}`}>
            <svg width="20" height="20" viewBox="0 0 20 20">
              <circle
                cx="10" cy="10" r="8"
                fill="none"
                stroke="var(--border, #e5e7eb)"
                strokeWidth="2"
              />
              <circle
                cx="10" cy="10" r="8"
                fill="none"
                stroke={allDone ? "var(--success, #22c55e)" : "var(--accent, #ff6b00)"}
                strokeWidth="2"
                strokeDasharray={`${(completed / total) * 50.26} 50.26`}
                strokeLinecap="round"
                transform="rotate(-90 10 10)"
                style={{ transition: "stroke-dasharray 0.3s ease" }}
              />
            </svg>
            {allDone && (
              <span className="step-list-check-icon">
                <IconCheck size={10} />
              </span>
            )}
          </div>
          <span className="step-list-title">
            {allDone ? "All steps complete" : activeStep ? activeStep.label : `Steps (${completed}/${total})`}
          </span>
        </div>
        <span className="step-list-chevron">
          <IconChevronDown size={14} className={collapsed ? "rotated" : ""} />
        </span>
      </button>

      {!collapsed && (
        <div className="step-list-items">
          {steps.map((step) => (
            <div
              key={step.id}
              className={`step-list-item step-list-item--${step.status}`}
            >
              <div className="step-list-item-icon">
                {step.status === "active" ? (
                  <span className="step-list-spinner" />
                ) : step.status === "done" ? (
                  <IconCheck size={12} />
                ) : step.status === "error" ? (
                  <IconX size={12} />
                ) : (
                  <span className="step-list-pending-dot" />
                )}
              </div>
              <div className="step-list-item-content">
                <span className="step-list-item-label">{step.label}</span>
                {step.detail && (
                  <span className="step-list-item-detail">{step.detail}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
