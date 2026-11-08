"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { IconChevronDown } from "../Icons";
import ActivityStepRow from "./ActivityStepRow";
import { activitySummary, formatActivityTime, type ActivityGroup as ActivityGroupData } from "@/lib/activity";

interface ActivityGroupProps {
  activity: ActivityGroupData;
  live?: boolean;
}

function formatElapsed(ms: number, live = false): string {
  const seconds = live
    ? Math.max(0, Math.floor(Math.max(0, ms) / 1000))
    : Math.max(1, Math.floor(Math.max(0, ms) / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export default function ActivityGroup({ activity, live = false }: ActivityGroupProps) {
  const isLive = live && (
    activity.steps.length === 0 ||
    activity.steps.some((step) => step.status === "live" || step.status === "approval")
  );
  const reduceMotion = useReducedMotion();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const [fallbackStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(fallbackStartedAt);
  const observedLive = useRef(isLive);
  if (isLive) observedLive.current = true;
  const open = userOpen ?? isLive;
  const timelineOpen = detailsOpen ?? isLive;
  const firstStepStart = activity.steps.reduce<number | undefined>(
    (earliest, step) => step.startedAt > 0 ? Math.min(earliest ?? step.startedAt, step.startedAt) : earliest,
    undefined
  );
  const durationStart = activity.startedAt || firstStepStart;
  const startedAt = durationStart || fallbackStartedAt;
  const endedAt = activity.endedAt || activity.steps.reduce<number | undefined>(
    (latest, step) => step.endedAt ? Math.max(latest ?? 0, step.endedAt) : latest,
    undefined
  );
  const stepElapsed = activity.steps.reduce(
    (total, step) => step.startedAt > 0 && step.endedAt
      ? total + Math.max(0, step.endedAt - step.startedAt)
      : total,
    0
  );

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isLive]);

  const elapsed = isLive
    ? now - startedAt
    : endedAt && durationStart
      ? Math.max(0, endedAt - durationStart)
      : stepElapsed || (observedLive.current
        ? Math.max(0, now - (durationStart || fallbackStartedAt))
        : 0);
  const hasError = activity.steps.some((step) => step.status === "error");
  const waitingApproval = activity.steps.some((step) => step.status === "approval");
  const summary = activitySummary(activity.steps);
  const statusText = isLive
    ? waitingApproval
      ? "Waiting for approval"
      : `Working for ${formatElapsed(elapsed, true)}`
    : hasError
      ? "Stopped"
      : `Worked for ${formatElapsed(elapsed)}`;
  const displaySummary = summary
    .split(", ")
    .map((part, index) => index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1))
    .join(", ");
  const title = isLive && activity.steps.length === 0
    ? "Thinking..."
    : summary === "Finished thinking"
      ? "Thinking..."
      : displaySummary;
  const toggleOpen = () => setUserOpen((current) => !(current ?? isLive));

  return (
    <section
      className="tp-activity-group"
      data-live={isLive ? "true" : "false"}
      data-reduced-motion={reduceMotion ? "true" : "false"}
    >
      <button
        type="button"
        className="tp-activity-status"
        aria-expanded={open}
        aria-label={`${statusText}. ${open ? "Collapse" : "Expand"} activity`}
        onClick={toggleOpen}
      >
        <span role="status" aria-live={isLive ? "polite" : undefined}>
          {statusText}
        </span>
        <IconChevronDown size={12} className={`tp-activity-status-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      <div className="tp-activity-card" hidden={!open}>
        <button
          type="button"
          className="tp-activity-summary"
          aria-expanded={timelineOpen}
          aria-label={`${title}. ${timelineOpen ? "Collapse" : "Expand"} details`}
          onClick={() => setDetailsOpen((current) => !(current ?? isLive))}
        >
          <span className={`tp-activity-summary-indicator${isLive ? " is-live" : ""}`} aria-hidden="true" />
          <span className={`tp-activity-summary-title${title === "Thinking..." && isLive ? " is-thinking" : ""}`}>
            {title}
          </span>
          <IconChevronDown size={14} className={`tp-activity-summary-chevron${timelineOpen ? " is-open" : ""}`} aria-hidden="true" />
        </button>
        <div className="tp-activity-body" hidden={!timelineOpen} aria-hidden={!timelineOpen}>
          <div className="tp-activity-timeline">
            {activity.steps.map((step) => (
              <ActivityStepRow key={step.id} step={step} now={now} />
            ))}
            {activity.steps.length === 0 && isLive && (
              <div className="tp-activity-empty" role="status">Thinking through the next step…</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
