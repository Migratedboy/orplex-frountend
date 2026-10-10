"use client";

import { useState } from "react";
import ThinkingCard from "./ThinkingCard";
import type { ChainItem, ToolKind, ToolRow, ToolRowState } from "@/lib/tool-chain";

/**
 * Tool-call chain: every tool of a run is one borderless row hanging off a
 * single connector line (the line and the icons are the only chrome). The
 * original ThinkingCard rides the same line so reasoning + calls read as one
 * continuous run. Rows are collapsed by default; clicking expands the full
 * args/output inline (150ms height transition, chevron rotates 90°).
 */

const KIND_GLYPH: Record<ToolKind, string> = {
  run: "smart_display",
  read: "description",
  write: "edit",
  browser: "public",
  search: "search",
  other: "extension",
};

const STATE_LABEL: Record<ToolRowState, string> = {
  running: "Running...",
  success: "Success",
  error: "Error",
  stopped: "Stopped",
};

function Glyph({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <span
      className={`ms${className ? ` ${className}` : ""}`}
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

function StatusDot({ state }: { state: ToolRowState }) {
  if (state === "success") {
    return (
      <span className="tool-chain__dot tool-chain__dot--ok" aria-hidden="true">
        <Glyph name="check" size={11} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="tool-chain__dot tool-chain__dot--err" aria-hidden="true">
        <Glyph name="close" size={11} />
      </span>
    );
  }
  if (state === "running") {
    return <span className="tool-chain__dot tool-chain__dot--spin" aria-hidden="true" />;
  }
  return <span className="tool-chain__dot tool-chain__dot--stopped" aria-hidden="true" />;
}

/** Full text behind the chevron: the complete args plus the tool's output. */
function expandBody(row: ToolRow): string {
  const args = (row.args || "").trim();
  const detail = (row.detail || "").trim();
  if (!detail) return args;
  if (!args) return detail;
  return detail.includes(args) ? detail : `${args}\n\n${detail}`;
}

function ToolRowView({ row, runLive }: { row: ToolRow; runLive: boolean }) {
  const [open, setOpen] = useState(false);
  // A leftover "running" line in a finished message is the run being cut
  // short — show it as stopped instead of spinning forever.
  const state: ToolRowState = row.state === "running" && !runLive ? "stopped" : row.state;
  const body = expandBody(row);
  const expandable = body.length > 0;
  const label =
    state === "running" && row.waiting ? "Waiting for approval" : STATE_LABEL[state];

  return (
    <div className={`tool-chain__row${open && expandable ? " is-open" : ""}`} data-state={state}>
      <div className="tool-chain__gutter" aria-hidden="true">
        <Glyph name={KIND_GLYPH[row.kind]} />
      </div>
      <button
        type="button"
        className="tool-chain__main"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((v) => !v)}
      >
        <StatusDot state={state} />
        <span className="tool-chain__name">{row.name}</span>
        {row.args ? <span className="tool-chain__args">{row.args}</span> : null}
        <span className="tool-chain__state">{label}</span>
        {expandable ? <Glyph name="chevron_right" className="tool-chain__chevron" /> : null}
      </button>
      <div className="tool-chain__panel" aria-hidden={!expandable || !open}>
        <div>
          <pre className="tool-chain__output">{body}</pre>
        </div>
      </div>
    </div>
  );
}

export default function ToolChain({
  items,
  runLive = true,
}: {
  items: ChainItem[];
  /** The turn is still running — a pending row really is still executing. */
  runLive?: boolean;
}) {
  const multi = items.length > 1;
  return (
    <div className={`tool-chain${multi ? " tool-chain--multi" : ""}`}>
      {items.map((item, i) =>
        item.type === "thinking" ? (
          <div className="tool-chain__row tool-chain__row--thinking" key={`t${i}`}>
            <div className="tool-chain__gutter" aria-hidden="true" />
            <div className="tool-chain__body">
              <ThinkingCard content={item.segment.content} isThinking={item.live} />
            </div>
          </div>
        ) : (
          <ToolRowView key={`r${i}`} row={item.row} runLive={runLive} />
        )
      )}
    </div>
  );
}
