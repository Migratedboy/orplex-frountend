"use client";

import { useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import ThinkingCard from "./ThinkingCard";

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

// === Types ===

interface ContentSegment {
  type: "text" | "tool_call" | "tool_result" | "status" | "success" | "error" | "thinking" | "interrupted";
  content: string;
  name?: string;
  path?: string;
  action?: string;
  detail?: string;
}

// === Parse raw content into segments ===

function parseContent(raw: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  // Thinking pattern: a closed [THINKING]...[/THINKING] block (multi-line)
  // or a still-streaming unclosed block that runs to the end of the content.
  const pattern = /([<]tool_call[\s\S]*?[<]\/tool_call[>]|<tool_result[^>]*>[\s\S]*?<\/tool_result>|^(?:analysing|reading|writing|listing|thinking)[\s]+\[[^\]]+\]|^\[OK\]\s+.+|^\[FAIL\]\s+.+|^\[THINKING\]\n[\s\S]*?\[\/THINKING\]|^\[THINKING\][\s\S]*$|^\[INTERRUPTED\]$)/gm;

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index).trim();
      if (text) segments.push({ type: "text", content: text });
    }

    const line = match[0];

    if (line.startsWith("<tool_call>")) {
      const jsonMatch = line.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          segments.push({ type: "tool_call", content: jsonMatch[1].trim(), name: parsed.name, path: parsed.path });
        } catch {
          segments.push({ type: "tool_call", content: jsonMatch[1].trim(), name: "unknown" });
        }
      }
    } else if (line.startsWith("<tool_result")) {
      const resultMatch = line.match(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/);
      if (resultMatch) segments.push({ type: "tool_result", content: resultMatch[1].trim().slice(0, 500) });
    } else if (/^(analysing|reading|writing|listing|thinking)/.test(line)) {
      const statusMatch = line.match(/^(\w+[\s]+)\[([^\]]+)\]/);
      if (statusMatch) segments.push({ type: "status", content: line, action: statusMatch[1].trim(), path: statusMatch[2] });
    } else if (line.startsWith("[THINKING]")) {
      // M3/reasoning-model thinking — multi-line, optionally closed with
      // [/THINKING] once the turn's answer text has been appended.
      const thinkingText = line
        .replace(/^\[THINKING\]\s*/, "")
        .replace(/\s*\[\/THINKING\]$/, "")
        .trim();
      if (thinkingText) segments.push({ type: "thinking", content: thinkingText });
    } else if (/^\[OK\]/.test(line)) {
      segments.push({ type: "success", content: line, detail: line.replace(/^\[OK\]\s*/, "").trim() });
    } else if (/^\[FAIL\]/.test(line)) {
      segments.push({ type: "error", content: line, detail: line.replace(/^\[FAIL\]\s*/, "").trim() });
    } else if (line === "[INTERRUPTED]") {
      segments.push({ type: "interrupted", content: line });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < raw.length) {
    const text = raw.slice(lastIndex).trim();
    if (text) segments.push({ type: "text", content: text });
  }

  return segments;
}

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
      <span className="interrupted-notice-icon">⚠️</span>
      <div className="interrupted-notice-body">
        <div className="interrupted-notice-title">Interrupted — the page was reloaded mid-task</div>
        <div className="interrupted-notice-hint">This is the partial output; send a follow-up to continue.</div>
      </div>
    </div>
  );
}

// === Main component ===

export default function MessageContent({ content, isThinking = false }: { content: string; isThinking?: boolean }) {
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
          default:
            return null;
        }
      })}
    </div>
  );
}
