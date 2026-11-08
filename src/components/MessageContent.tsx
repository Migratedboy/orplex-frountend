"use client";

import { useMemo, useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import ActivityGroup from "./activity/ActivityGroup";
import ClarificationCard from "./ClarificationCard";
import FileCard from "./FileCard";
import SandboxArtifact from "./SandboxArtifact";
import { IconRefresh, IconChevronUp, IconChevronDown } from "./Icons";
import { parseContent, type ContentSegment } from "@/lib/message-content";
import { appendLiveToolSteps, combineActivityGroups, type ActivityTiming } from "@/lib/activity";

// === Collapsible text for long content ===

const COLLAPSE_THRESHOLD = 150; // words

function CollapsibleText({ content }: { content: string }) {
  // One split, not two. This ran `content.split(/\s+/)` twice per render (once
  // for the count, once for the preview) — measured at 1.59ms on a 51KB
  // message, ~10x the cost of the markdown parse it feeds, and it re-ran on
  // every one of the 8 frames/sec the store notifies during streaming.
  const words = useMemo(() => content.split(/\s+/), [content]);
  const wordCount = words.length;
  const needsCollapse = wordCount > COLLAPSE_THRESHOLD;
  // Long answers start fully expanded — the reader should never have to reveal
  // the reply that was already written for them. The control still lets them
  // fold a long message back down to its preview.
  const [expanded, setExpanded] = useState(true);
  // Unconditional: a hook after the early return below would be a
  // rules-of-hooks violation.
  const preview = useMemo(() => words.slice(0, 100).join(" "), [words]);

  if (!needsCollapse) {
    return <MarkdownRenderer content={content} />;
  }

  return (
    <div className="collapsible-text">
      <MarkdownRenderer content={expanded ? content : preview + "…"} />
      <button
        type="button"
        className="collapsible-text-btn"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? "Show less" : `Show all (${wordCount} words)`}
        {expanded ? (
          <IconChevronUp size={15} className="collapsible-text-chevron" />
        ) : (
          <IconChevronDown size={15} className="collapsible-text-chevron" />
        )}
      </button>
    </div>
  );
}

// === Types & parser live in @/lib/message-content (pure, unit-testable) ===

function InterruptedNotice() {
  return (
    <div className="interrupted-notice" role="status">
      <span className="interrupted-notice-icon"><span className="ms">warning</span></span>
      <div className="interrupted-notice-body">
        <div className="interrupted-notice-title">Interrupted — the page was reloaded mid-task</div>
        <div className="interrupted-notice-hint">This is the partial output; send a follow-up to continue.</div>
      </div>
    </div>
  );
}

function FailedNotice({ onRetry, retrying }: { onRetry?: () => void; retrying?: boolean }) {
  return (
    <div className="failed-notice" role="status">
      <span className="failed-notice-icon"><span className="ms">error</span></span>
      <div className="failed-notice-body">
        <div className="failed-notice-title">This response failed</div>
        <div className="failed-notice-hint">The model stopped before finishing — nothing was lost.</div>
      </div>
      {onRetry && (
        <button className="failed-retry-btn" onClick={onRetry} disabled={retrying} title="Resend the same prompt">
          <IconRefresh size={13} /> {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}

// === Main component ===

export default function MessageContent({
  content,
  isThinking = false,
  runLive = false,
  runStartedAt,
  activityTiming,
  liveToolCalls = [],
  onRetry,
  retrying = false,
}: {
  content: string;
  isThinking?: boolean;
  /** The turn is still running — pending tool rows keep their running state. */
  runLive?: boolean;
  runStartedAt?: number;
  activityTiming?: ActivityTiming;
  liveToolCalls?: Array<{ id: string; tool: string; args: Record<string, unknown>; startedAt?: number }>;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  // Parse only when transcript or live activity inputs change.
  const segments = useMemo(() => {
    let parsed = parseContent(content, {
      live: runLive || isThinking,
      startedAt: runStartedAt,
      activityTiming,
      activity: true,
    });
    if (liveToolCalls.length > 0) {
      parsed = appendLiveToolSteps(parsed, liveToolCalls, runStartedAt || 0);
    }
    if ((runLive || isThinking) && !parsed.some((segment) => segment.type === "activity")) {
      parsed = [{
        type: "activity",
        content: "",
        activity: { id: "activity-live", steps: [], startedAt: runStartedAt || 0 },
      }, ...parsed];
    }
    const activitySegments = parsed.filter((segment) => segment.type === "activity" && segment.activity);
    if (activitySegments.length <= 1) return parsed;

    const combined = combineActivityGroups(
      activitySegments.flatMap((segment) => segment.activity ? [segment.activity] : [])
    );
    if (!combined) return parsed;

    let inserted = false;
    return parsed.flatMap((segment) => {
      if (segment.type !== "activity") return [segment];
      if (inserted) return [];
      inserted = true;
      return [{ ...segment, activity: combined }];
    });
  }, [content, runLive, isThinking, runStartedAt, activityTiming, liveToolCalls]);

  if (segments.length === 0) {
    return null;
  }

  if (segments.length === 1 && segments[0].type === "text") {
    return <MarkdownRenderer content={segments[0].content} />;
  }

  return (
    <div className="message-content-mixed">
      {segments.map((segment: ContentSegment, i) => {
        switch (segment.type) {
          case "text":
            return <CollapsibleText key={`${segment.type}-${i}`} content={segment.content} />;
          case "activity":
            return segment.activity
              ? <ActivityGroup key={segment.activity.id} activity={segment.activity} live={runLive || isThinking} />
              : null;
          case "interrupted":
            return <InterruptedNotice key={`${segment.type}-${i}`} />;
          case "clarified":
            return segment.data ? (
              <ClarificationCard key={`${segment.type}-${i}`} compact data={segment.data} />
            ) : null;
          case "filecard":
            return segment.file ? (
              <FileCard key={`${segment.type}-${i}`} file={segment.file} />
            ) : null;
          case "artifact":
            return segment.artifact ? (
              <SandboxArtifact key={`${segment.type}-${i}`} artifact={segment.artifact} />
            ) : null;
          case "failed":
            return <FailedNotice key={`${segment.type}-${i}`} onRetry={onRetry} retrying={retrying} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
