"use client";

import { useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import ThinkingCard from "./ThinkingCard";
import { IconRefresh } from "./Icons";
import { parseContent, type ContentSegment } from "@/lib/message-content";

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
        className="collapsible-text-btn"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Show less" : `Show all (${wordCount} words)`}
      </button>
    </div>
  );
}

// === Types & parser live in @/lib/message-content (pure, unit-testable) ===

// === Tool config ===

const TOOL_CONFIG: Record<string, { label: string; color: string }> = {
  read_file: { label: "Read File", color: "#3B82F6" },
  write_file: { label: "Write File", color: "#F97316" },
  list_files: { label: "List Files", color: "#8B5CF6" },
  search_code: { label: "Search", color: "#06B6D4" },
  run_command: { label: "Run Command", color: "#EF4444" },
};

function getToolConfig(name: string) {
  return TOOL_CONFIG[name] || { label: name, color: "#71717A" };
}

// === Components ===

function ToolCallCard({ segment }: { segment: ContentSegment }) {
  const [expanded, setExpanded] = useState(false);
  const config = getToolConfig(segment.name || "");
  const args = segment.content;

  return (
    <div className="tool-card">
      <button className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-card-left">
          <div className="tool-card-indicator" style={{ background: config.color }} />
          <span className="tool-card-label">{config.label}</span>
          {segment.path && <span className="tool-card-path">{segment.path}</span>}
        </div>
        <div className="tool-card-right">
          <span className="tool-card-chevron">{expanded ? "−" : "+"}</span>
        </div>
      </button>
      {expanded && (
        <div className="tool-card-body">
          <pre className="tool-card-args">{args}</pre>
        </div>
      )}
    </div>
  );
}

function ToolResultCard({ segment }: { segment: ContentSegment }) {
  const [expanded, setExpanded] = useState(false);
  const preview = segment.content.slice(0, 120);
  const hasMore = segment.content.length > 120;

  return (
    <div className="tool-result-card">
      <button className="tool-result-header" onClick={() => hasMore && setExpanded(!expanded)}>
        <div className="tool-result-left">
          <span className="tool-result-label">Result</span>
          <span className="tool-result-preview">{expanded ? "" : preview}{!expanded && hasMore ? "…" : ""}</span>
        </div>
        {hasMore && <span className="tool-card-chevron">{expanded ? "−" : "+"}</span>}
      </button>
      {expanded && (
        <div className="tool-result-body">
          <pre className="tool-result-full">{segment.content}</pre>
        </div>
      )}
    </div>
  );
}

function StatusPill({ segment }: { segment: ContentSegment }) {
  return (
    <div className="tool-status-pill">
      <div className="tool-status-dot tool-status-dot--active" />
      <span className="tool-status-text">{segment.action}</span>
      <span className="tool-status-file">{segment.path}</span>
    </div>
  );
}

function ResultPill({ segment, type }: { segment: ContentSegment; type: "success" | "error" }) {
  return (
    <div className={`tool-result-pill tool-result-pill--${type}`}>
      <div className={`tool-result-dot tool-result-dot--${type}`} />
      <span className="tool-result-text">{segment.detail}</span>
    </div>
  );
}

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

export default function MessageContent({ content, isThinking = false, onRetry, retrying = false }: { content: string; isThinking?: boolean; onRetry?: () => void; retrying?: boolean }) {
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

  return (
    <div className="message-content-mixed">
      {/* Show active thinking pill even before thinking content arrives */}
      {isThinking && !hasThinking && (
        <ThinkingCard content="" isThinking={true} />
      )}
      {segments.map((segment, i) => {
        const isLastThinking = segment.type === "thinking" && i === segments.length - 1;
        switch (segment.type) {
          case "text":
            return <CollapsibleText key={i} content={segment.content} />;
          case "thinking":
            return <ThinkingCard key={i} content={segment.content} isThinking={isThinking && isLastThinking} />;
          case "tool_call":
            return <ToolCallCard key={i} segment={segment} />;
          case "tool_result":
            return <ToolResultCard key={i} segment={segment} />;
          case "status":
            return <StatusPill key={i} segment={segment} />;
          case "success":
            return <ResultPill key={i} segment={segment} type="success" />;
          case "error":
            return <ResultPill key={i} segment={segment} type="error" />;
          case "interrupted":
            return <InterruptedNotice key={i} />;
          case "failed":
            return <FailedNotice key={i} onRetry={onRetry} retrying={retrying} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
