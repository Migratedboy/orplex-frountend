"use client";

import { memo, useState } from "react";
import { ErrorInline } from "../StateViews";
import { IconMcp } from "../Icons";
import { formatActivityTime, type ActivityStep } from "@/lib/activity";

const KIND_ICON: Record<ActivityStep["kind"], string> = {
  think: "psychology",
  list: "folder_open",
  search: "search",
  read: "description",
  edit: "edit",
  run: "terminal",
  browser: "language",
  agent: "account_tree",
  mcp: "extension",
  other: "build",
};

function ActivityStepRow({ step, now }: { step: ActivityStep; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasBody = Boolean(step.body || step.detail);
  const duration = step.startedAt > 0 && step.endedAt
    ? formatActivityTime(step.endedAt - step.startedAt)
    : step.startedAt > 0 && step.status === "live"
      ? formatActivityTime(now - step.startedAt)
      : "";

  return (
    <div className={`tp-activity-step tp-activity-step-${step.status}`} data-kind={step.kind}>
      <button
        type="button"
        className="tp-activity-step-trigger"
        aria-expanded={hasBody ? expanded : undefined}
        onClick={() => hasBody && setExpanded((value) => !value)}
        disabled={!hasBody}
      >
        {step.kind === "mcp"
          ? <IconMcp size={14} className="tp-activity-step-icon" />
          : <span className="tp-activity-step-icon ms" aria-hidden="true">{KIND_ICON[step.kind]}</span>}
        <span className="tp-activity-step-title">{step.title}</span>
        {step.chip && <span className="tp-activity-step-chip" title={step.chip}>{step.chip}</span>}
        {step.status === "live" && <span className="tp-activity-step-live" aria-label="In progress" />}
        {step.status === "approval" && <span className="tp-activity-step-state">Needs approval</span>}
        {step.status === "error" && <span className="tp-activity-step-state">Failed</span>}
        {step.meta && <span className="tp-activity-step-meta">{step.meta}</span>}
        {duration && <span className="tp-activity-step-duration">{duration}</span>}
        {hasBody && (
          <span className={`tp-activity-step-chevron ms${expanded ? " is-open" : ""}`} aria-hidden="true">
            expand_more
          </span>
        )}
      </button>
      {hasBody && (
        <div className="tp-activity-step-details" hidden={!expanded}>
          {step.detail && <p className="tp-activity-step-description">{step.detail}</p>}
          {step.status === "error" && <ErrorInline error={step.body || step.detail} />}
          {step.body && (
            <pre className="tp-activity-step-output" tabIndex={0}>
              <code>{step.body}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ActivityStepRow);
