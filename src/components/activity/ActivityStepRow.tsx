"use client";

import { memo } from "react";
import { type ActivityStep } from "@/lib/activity";
import { ToolCallRow } from "../ToolCallDisplay";

function ActivityStepRow({
  step,
  now,
  fallbackStartedAt,
  entryDelay,
}: {
  step: ActivityStep;
  now: number;
  fallbackStartedAt: number;
  entryDelay: number;
}) {
  const isThinking = step.kind === "think";
  const startedAt = step.startedAt || fallbackStartedAt;
  const elapsed = step.endedAt
    ? Math.max(0, step.endedAt - startedAt) / 1000
    : step.status === "live"
      ? Math.max(0, now - startedAt) / 1000
      : undefined;
  const state = step.status === "live"
    ? "running"
    : step.status === "approval"
      ? "waiting"
      : step.status === "error"
        ? "failed"
        : "done";
  const thinkingText = step.detail || "";
  const metadataIsStatus = /^(?:exit(?: code)?\s*-?\d+|serving|waiting for you|timed out|low risk|undoable|microvm|preview tab)$/i.test(step.meta || "");
  const rowMeta = isThinking
    ? state === "running"
      ? ""
      : `${Math.ceil(thinkingText.length / 4)} tokens`
    : state === "running"
      ? ""
      : state === "failed" || metadataIsStatus
        ? ""
        : step.meta || "";
  const statusText = state === "waiting"
    ? "waiting for you"
    : state === "failed"
      ? step.meta || "failed"
      : metadataIsStatus
        ? step.meta || ""
        : "";
  const tool = step.tool || ({
    think: "thinking",
    list: "list_files",
    search: "search_code",
    read: "read_file",
    edit: "edit_file",
    run: "run_command",
    browser: "browser_read",
    agent: "spawn_subagent",
    mcp: "mcp_call",
    other: step.title,
  } as const)[step.kind];

  return (
    <ToolCallRow
      tool={tool}
      title={step.title}
      target={isThinking
        ? state === "running" ? "" : elapsed !== undefined ? `for ${elapsed.toFixed(1)}s` : ""
        : step.chip || ""}
      meta={rowMeta}
      statusText={statusText}
      status={state}
      rawBody={isThinking ? undefined : step.body}
      result={isThinking ? thinkingText : step.detail}
      thinkingText={isThinking ? thinkingText : undefined}
      thinkingTokens={isThinking && state !== "running" ? Math.ceil(thinkingText.length / 4) : undefined}
      startedAt={startedAt}
      endedAt={step.endedAt}
      now={now}
      entryDelay={entryDelay}
    />
  );
}

export default memo(ActivityStepRow);
