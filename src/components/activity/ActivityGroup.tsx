"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "../Icons";
import ActivityStepRow from "./ActivityStepRow";
import type { ActivityGroup as ActivityGroupData, ActivityStep } from "@/lib/activity";

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
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [fallbackStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(fallbackStartedAt);
  const observedLive = useRef(isLive);
  if (isLive) observedLive.current = true;
  const open = userOpen ?? true;
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
  const statusText = isLive
    ? waitingApproval
      ? "Waiting for approval"
      : `Working for ${formatElapsed(elapsed, true)}`
    : hasError
      ? "Stopped"
      : `Worked for ${formatElapsed(elapsed)}`;
  const displaySteps: ActivityStep[] = activity.steps.length > 0
    ? activity.steps
    : isLive
      ? [{
        id: `${activity.id}-thinking`,
        kind: "think",
        title: "Thinking",
        detail: "",
        status: "live",
        startedAt,
      }]
      : [];
  const toggleOpen = () => setUserOpen((current) => !(current ?? true));

  return (
    <section
      className="tp-activity-group"
      data-live={isLive ? "true" : "false"}
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
      <div className="otc-feed" hidden={!open}>
        {displaySteps.map((step, index) => (
          <ActivityStepRow
            key={step.id}
            step={step}
            now={now}
            fallbackStartedAt={startedAt}
            entryDelay={index * 30}
          />
        ))}
      </div>
    </section>
  );
}
