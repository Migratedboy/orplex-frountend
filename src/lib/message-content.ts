/**
 * message-content.ts — pure parser for assistant display content.
 *
 * Splits raw model/worker output into renderable segments (tool calls, tool
 * results, status pills, thinking blocks, notices). No React imports: kept
 * out of MessageContent.tsx so the node-env Jest suite can test it directly
 * (the component tree pulls ESM-only deps like remark-gfm).
 *
 * Status lines the UI parses (all must start at line start):
 *   analysing/reading/writing/listing/thinking [path] — active status pill
 *   [OK] … / [SUCCESS] …                              — success result pill
 *   [FAIL] … / [ERROR] …                              — error result pill
 *   [THINKING] … [THINKING/], [INTERRUPTED], [FAILED], [FAILED_META]:…
 */

export type ContentSegmentType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "status"
  | "success"
  | "error"
  | "thinking"
  | "interrupted"
  | "failed";

export interface ContentSegment {
  type: ContentSegmentType;
  content: string;
  name?: string;
  path?: string;
  action?: string;
  detail?: string;
}

export function parseContent(raw: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  // Thinking pattern: a closed [THINKING]...[/THINKING] block (multi-line)
  // or a still-streaming unclosed block that runs to the end of the content.
  const pattern = /([<]tool_call[\s\S]*?[<]\/tool_call[>]|<tool_result[^>]*>[\s\S]*?<\/tool_result>|^(?:analysing|reading|writing|listing|thinking)[\s]+\[[^\]]+\]|^\[OK\]\s+.+|^\[FAIL\]\s+.+|^\[SUCCESS\]\s+.+|^\[ERROR\]\s+.+|^\[THINKING\]\n[\s\S]*?\[\/THINKING\]|^\[THINKING\][\s\S]*$|^\[INTERRUPTED\]$|^\[FAILED\]$|^\[FAILED_META\]:[A-Za-z0-9+/=]+$)/gm;

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
    } else if (/^\[SUCCESS\]/.test(line)) {
      segments.push({ type: "success", content: line, detail: line.replace(/^\[SUCCESS\]\s*/, "").trim() });
    } else if (/^\[FAIL\]/.test(line)) {
      segments.push({ type: "error", content: line, detail: line.replace(/^\[FAIL\]\s*/, "").trim() });
    } else if (/^\[ERROR\]/.test(line)) {
      segments.push({ type: "error", content: line, detail: line.replace(/^\[ERROR\]\s*/, "").trim() });
    } else if (line === "[INTERRUPTED]") {
      segments.push({ type: "interrupted", content: line });
    } else if (line === "[FAILED]") {
      segments.push({ type: "failed", content: line });
    } else if (line.startsWith("[FAILED_META]:")) {
      // Data line for the Retry flow — never rendered directly.
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < raw.length) {
    const text = raw.slice(lastIndex).trim();
    if (text) segments.push({ type: "text", content: text });
  }

  return segments;
}
