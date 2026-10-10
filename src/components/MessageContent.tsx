"use client";

import { useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import ThinkingCard from "./ThinkingCard";
import ToolChain from "./ToolChain";
import ClarificationCard from "./ClarificationCard";
import { IconRefresh, IconChevronUp, IconChevronDown } from "./Icons";
import { parseContent, type ContentSegment } from "@/lib/message-content";
import { buildChainGroups } from "@/lib/tool-chain";

// === Collapsible text for long content ===

const COLLAPSE_THRESHOLD = 150; // words

function CollapsibleText({ content }: { content: string }) {
  const wordCount = content.split(/\s+/).length;
  const needsCollapse = wordCount > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  if (!needsCollapse) {
    return <MarkdownRenderer content={content} />;
  }

  // Show first ~100 words when collapsed
  const words = content.split(/\s+/);
  const preview = words.slice(0, 100).join(" ");

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

// === Tool calls render as one connector-lined chain (see ToolChain) ===
// Status/result segments never reach the solo path below — buildChainGroups
// folds them (plus any adjacent reasoning) into a chain group.

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
  onRetry,
  retrying = false,
}: {
  content: string;
  isThinking?: boolean;
  /** The turn is still running — pending tool rows keep their running state. */
  runLive?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const segments = parseContent(content);

  // If no segments but thinking is active, show empty thinking pill
  if (segments.length === 0) {
    if (isThinking) {
      return <ThinkingCard content="" isThinking={true} />;
    }
    return null;
  }

  if (segments.length === 1 && segments[0].type === "text") {
    return <MarkdownRenderer content={segments[0].content} />;
  }

  // Check if any thinking segment exists
  const hasThinking = segments.some(s => s.type === "thinking");
  const groups = buildChainGroups(segments, isThinking);

  return (
    <div className="message-content-mixed">
      {/* Show active thinking pill even before thinking content arrives */}
      {isThinking && !hasThinking && (
        <ThinkingCard content="" isThinking={true} />
      )}
      {groups.map((group, i) => {
        if (group.type === "chain") {
          return <ToolChain key={`chain-${i}`} items={group.items} runLive={runLive} />;
        }
        const segment: ContentSegment = group.segment;
        switch (segment.type) {
          case "text":
            return <CollapsibleText key={i} content={segment.content} />;
          case "thinking":
            return (
              <ThinkingCard
                key={i}
                content={segment.content}
                isThinking={Boolean(group.live)}
              />
            );
          case "interrupted":
            return <InterruptedNotice key={i} />;
          case "clarified":
            return segment.data ? (
              <ClarificationCard key={i} compact data={segment.data} />
            ) : null;
          case "failed":
            return <FailedNotice key={i} onRetry={onRetry} retrying={retrying} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
