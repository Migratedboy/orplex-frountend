"use client";

import ToolChain from "./ToolChain";
import { rowFromToolCall, type ChainItem } from "@/lib/tool-chain";

interface ToolCallProps {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  success?: boolean;
}

/**
 * Tool call from the structured agent-event stream (the same single row the
 * transcript chain renders: icon on the line, status dot, name, mono args,
 * right-aligned state, chevron). Renders as a one-item chain.
 */
export default function ToolCallDisplay({ tool, args, result, success }: ToolCallProps) {
  const content = JSON.stringify({ name: tool, ...(args ?? {}) });
  const row = rowFromToolCall({ type: "tool_call", content, name: tool });
  if (result) row.detail = [row.detail, result].filter(Boolean).join("\n\n");
  if (success === true) row.state = "success";
  else if (success === false) row.state = "error";

  const items: ChainItem[] = [{ type: "tool", row }];
  return <ToolChain items={items} runLive={success === undefined} />;
}
