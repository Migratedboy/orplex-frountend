/**
 * message-content.ts — pure parser for assistant display content.
 *
 * Splits raw model/worker output into renderable segments (tool calls, tool
 * results, status pills, thinking blocks, notices). No React imports: kept
 * out of MessageContent.tsx so the node-env Jest suite can test it directly
 * (the component tree pulls ESM-only deps like remark-gfm).
 *
 * Status lines the UI parses (all must start at line start):
 *   <verb> [target] [tail] — a tool STARTED (running status row)
 *     verbs: analysing reading writing listing thinking running sandbox
 *            searching searching-web code_search editing appending
 *            overwriting batch-editing browsing clicking capturing
 *            previewing verifying-app undoing asking read
 *     tail is free text after the bracket, e.g. "— awaiting approval"
 *   [OK] … / [SUCCESS] …                              — tool finished (ok)
 *   [FAIL] … / [ERROR] …                              — tool finished (failed)
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
  | "failed"
  | "clarified";

export interface ContentSegment {
  type: ContentSegmentType;
  content: string;
  name?: string;
  path?: string;
  action?: string;
  detail?: string;
  /** Parsed payload for type "clarified" — question / context / answer. */
  data?: { q: string; c?: string; a: string };
}

/**
 * Verbs the worker/tools stamp before a bracketed target when a tool STARTS
 * ("running [ls -la]", "analysing [src/app/page.tsx]"). Longest-first where
 * one verb is a prefix of another so the alternation resolves correctly.
 */
export const STATUS_VERBS = [
  "searching web",
  "batch editing",
  "verifying app",
  "analysing",
  "reading",
  "writing",
  "listing",
  "thinking",
  "running",
  "sandbox",
  "searching",
  "code_search",
  "editing",
  "appending",
  "overwriting",
  "browsing",
  "clicking",
  "capturing",
  "previewing",
  "undoing",
  "asking",
  "read",
] as const;

const STATUS_LINE_RE = new RegExp(`^(?:${STATUS_VERBS.join("|")})\\s+\\[[^\\]]+\\][^\\n]*`);

export function isStatusLine(line: string): boolean {
  return STATUS_LINE_RE.test(line);
}

/**
 * Split a status line into its parts. The bracket body is matched GREEDILY up
 * to the LAST "]" on the line so commands like `grep "a]b"` survive intact;
 * everything after it ("— awaiting approval", "(cached — already read 3×)")
 * is returned as `detail`.
 */
export function matchStatusLine(line: string): { action: string; path: string; detail: string } | null {
  if (!isStatusLine(line)) return null;
  const m = line.match(/^([a-z_ ]+?)\s+\[([\s\S]+)\]([^\n]*)$/);
  if (!m) return null;
  return { action: m[1].trim().replace(/\s+/g, " "), path: m[2].trim(), detail: m[3].trim() };
}

export function parseContent(raw: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  // Thinking pattern: a closed [THINKING]...[/THINKING] block (multi-line)
  // or a still-streaming unclosed block that runs to the end of the content.
  const pattern = new RegExp(
    `([<]tool_call[\\s\\S]*?[<]\\/tool_call[>]|<tool_result[^>]*>[\\s\\S]*?<\\/tool_result>|` +
      `${STATUS_LINE_RE.source}|` +
      `^\\[OK\\]\\s+.+|^\\[FAIL\\]\\s+.+|^\\[SUCCESS\\]\\s+.+|^\\[ERROR\\]\\s+.+|` +
      `^\\[THINKING\\][\\s\\S]*?\\[\\/THINKING\\]|^\\[THINKING\\][\\s\\S]*$|` +
      `^\\[CLARIFIED\\]:[^\\n]+|` +
      `^\\[INTERRUPTED\\]$|^\\[FAILED\\]$|^\\[FAILED_META\\]:[A-Za-z0-9+/=]+$)`,
    "gm"
  );

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
    } else if (isStatusLine(line)) {
      const status = matchStatusLine(line);
      if (status) {
        segments.push({
          type: "status",
          content: line,
          action: status.action,
          path: status.path,
          detail: status.detail || undefined,
        });
      }
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
    } else if (line.startsWith("[CLARIFIED]:")) {
      // Answered clarification record — renders as the compact card. Raw JSON
      // only; anything malformed is dropped rather than shown to the user.
      try {
        const parsed = JSON.parse(line.slice("[CLARIFIED]:".length));
        if (typeof parsed?.q === "string" && typeof parsed?.a === "string") {
          segments.push({
            type: "clarified",
            content: line,
            data: { q: parsed.q, ...(typeof parsed.c === "string" ? { c: parsed.c } : {}), a: parsed.a },
          });
        }
      } catch {
        // fall through — never render the raw marker
      }
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
