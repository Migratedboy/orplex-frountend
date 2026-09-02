"use client";

import { useState } from "react";
import { IconChevronRight, IconCheck, IconX, IconFile, IconTerminal, IconSearch } from "./Icons";

interface ToolCallProps {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  success?: boolean;
}

const TOOL_CONFIG: Record<string, { color: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  read_file: { color: "#3b82f6", Icon: IconFile },
  list_files: { color: "#3b82f6", Icon: IconFile },
  search_code: { color: "#3b82f6", Icon: IconSearch },
  write_file: { color: "#f59e0b", Icon: IconFile },
  write_file_chunk: { color: "#f59e0b", Icon: IconFile },
  edit_file: { color: "#f59e0b", Icon: IconFile },
  run_command: { color: "#ef4444", Icon: IconTerminal },
  run_in_sandbox: { color: "#ef4444", Icon: IconTerminal },
  web_search: { color: "#8b5cf6", Icon: IconSearch },
  take_screenshot: { color: "#8b5cf6", Icon: IconSearch },
};

export default function ToolCallDisplay({ tool, args, result, success }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const config = TOOL_CONFIG[tool] || { color: "#6b7280", Icon: IconTerminal };
  const { color, Icon: ToolIcon } = config;

  return (
    <div className="tool-call-display" style={{ borderLeftColor: color }}>
      <button
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} tool call: ${tool}`}
      >
        <span className="tool-call-icon" style={{ color }}>
          <ToolIcon size={14} />
        </span>
        <span className="tool-call-name" style={{ color }}>{tool}</span>
        {args && (
          <span className="tool-call-args">
            {Object.entries(args).map(([k, v]) => (
              <span key={k} className="tool-call-arg">
                {k}: {typeof v === "string" ? (v.length > 40 ? v.slice(0, 40) + "..." : v) : JSON.stringify(v)}
              </span>
            ))}
          </span>
        )}
        <span className={`tool-call-status ${success ? "success" : success === false ? "error" : ""}`}>
          {success === true ? <IconCheck size={12} /> : success === false ? <IconX size={12} /> : <IconChevronRight size={12} />}
        </span>
      </button>
      {expanded && result && (
        <pre className={`tool-call-result ${success ? "success" : "error"}`}>
          {result}
        </pre>
      )}
    </div>
  );
}
