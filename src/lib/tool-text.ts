// tool-text.ts — The single home for the small string/parse helpers that
// used to be copy-pasted across stream-reader.ts, useChatSession.ts,
// tool-handlers.ts and reflection-loop.ts (each copy drifting slightly).
// Everything here is pure — safe in Node, browser, and tests alike.

// === Word-level dedup (gpt-oss-120b "the the rule rule" pathology) ===

export function deduplicateWords(text: string): string {
  // Collapse "word word" → "word" (case-insensitive, word-boundary aware)
  // Two-pass handles triple+ duplicates: "a a a" → "a a" → "a"
  let prev: string;
  do {
    prev = text;
    text = text.replace(/(\b\w+\b)\s+\1\b/gi, "$1");
  } while (text !== prev);
  return text;
}

// === XML tool-call parsing (legacy fallback for models without native tools) ===

export interface XmlToolCall {
  name: string;
  [key: string]: unknown;
}

export function parseToolCalls(text: string): XmlToolCall[] {
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const calls: XmlToolCall[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      calls.push(JSON.parse(match[1].trim()));
    } catch {
      // skip malformed tool calls
    }
  }
  return calls;
}

// === Bare-JSON tool-call recovery ==========================================
// Weak OpenAI-compatible models sometimes drop the requested <tool_call> XML
// wrapper and emit a bare tool-call JSON object (or a JSON array of them),
// often fenced in ```json. If those shapes only parse as prose, the agent loop
// mistakes them for the final summary and ends the run one turn in
// (live-observed: `{"name":"read_file","path":"README.md"}`). Recovery is
// gated hard: the object must have a string "name" field, other keys must be
// plausible tool arguments, and prose around it must be thin (≤2 short
// non-brace lines) so real answers that merely contain JSON stay untouched.

const TOOL_CALL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/i;

/** A tool-call-shaped object: string "name" matching tool-name shape, only
 *  flat scalar argument values (tool args are flat), bounded key count. */
function isToolCallShaped(obj: unknown): obj is Record<string, unknown> & { name: string } {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.name !== "string" || !TOOL_CALL_NAME_RE.test(rec.name)) return false;
  const keys = Object.keys(rec);
  if (keys.length < 1 || keys.length > 12) return false;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "name") continue;
    if (v === null || typeof v === "object") return false; // args are flat scalars
    if (typeof v === "string" && v.length > 20_000) return false;
  }
  return true;
}

/** Extract tool-call-shaped JSON from a model turn that skipped the XML
 *  wrapper. Returns [] when the text is recognisably prose (thin-prose gate:
 *  the JSON must dominate the message). Never returns XML results twice —
 *  callers feed this only the residue after XML parsing. */
export function parseBareJsonToolCalls(text: string): XmlToolCall[] {
  if (!text || !text.includes('"')) return [];
  const trimmed = text.trim();
  // XML-wrapped spans belong to the XML parser (even if its JSON was
  // malformed) and fences are extracted separately — mask both so raw-span
  // extraction and the prose gate only see genuine bare-JSON residue.
  const masked = trimmed
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, " ")
    .replace(/```[\s\S]*?```/g, " ");
  const candidates: string[] = [];
  // 1. json-fenced block(s) — from the unmasked text
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1].trim();
    if (body.includes('"')) candidates.push(body);
  }
  // 2. raw {...} and [...] spans from the masked text. The brace span of an
  //    array is mangled ("{...},{...}"), so prefer the bracket span when the
  //    text starts with one; duplicates are dropped after parsing.
  const braceStart = masked.indexOf("{");
  const bracketStart = masked.indexOf("[");
  if (bracketStart >= 0 && (braceStart < 0 || bracketStart < braceStart)) {
    const bracketEnd = masked.lastIndexOf("]");
    if (bracketEnd > bracketStart) candidates.push(masked.slice(bracketStart, bracketEnd + 1));
  }
  if (braceStart >= 0) {
    const braceEnd = masked.lastIndexOf("}");
    if (braceEnd > braceStart) candidates.push(masked.slice(braceStart, braceEnd + 1));
  }
  const parsed: XmlToolCall[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(c);
    } catch {
      continue;
    }
    const list = Array.isArray(obj) ? obj : [obj];
    if (list.length === 0 || list.length > 8) continue;
    if (!list.every(isToolCallShaped)) continue;
    // Thin-prose gate: outside the JSON there may be at most 2 short lines of
    // chatter (e.g. "Reading the file:"), never a real answer paragraph.
    const outside = masked
      .replace(/\{[\s\S]*\}/, " ")
      .replace(/\[[\s\S]*\]/, " ")
      .trim();
    const outsideLines = outside.split("\n").filter((l) => l.trim().length > 0);
    if (outsideLines.length > 2 || outsideLines.some((l) => l.length > 120)) continue;
    for (const call of list) {
      const key = JSON.stringify(call);
      if (!seen.has(key)) {
        seen.add(key);
        parsed.push(call as XmlToolCall);
      }
    }
  }
  return parsed;
}

// === Status-line replacement (agent display transcript) ===

/** Replace the last status line ("analysing [x]") with a result line. */
export function replaceLastStatus(display: string, resultLine: string): string {
  const statusRegex = /^(analysing|reading|writing|listing|thinking)\s+\[[^\]]+\]\n?$/m;
  const lines = display.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (statusRegex.test(lines[i])) {
      lines[i] = resultLine;
      return lines.join("\n");
    }
  }
  return display + resultLine + "\n";
}

// === File-tree helpers ===

interface TreeNodeLike {
  kind: string;
  path: string;
  children?: TreeNodeLike[];
}

/** Get all file paths under a directory prefix (or the whole tree). */
export function listFilesUnderPath(path: string, nodes: TreeNodeLike[]): string {
  const results: string[] = [];
  const walk = (ns: TreeNodeLike[]) => {
    for (const n of ns) {
      if (n.kind === "file" && (path === "" || path === "." || n.path.startsWith(path))) {
        results.push(n.path);
      }
      if (n.kind === "directory" && n.children) walk(n.children);
    }
  };
  walk(nodes);
  return results.length > 0 ? results.join("\n") : "No files found at that path.";
}

/** Substring search over cached file contents. Returns `path:line: text` rows. */
export function searchCodeInContents(
  query: string,
  fileContents: Record<string, string>,
  maxResults = 20
): string {
  const results: string[] = [];
  for (const [filePath, content] of Object.entries(fileContents)) {
    if (results.length >= maxResults) break;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query.toLowerCase())) {
        results.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results.length > 0 ? results.join("\n") : `No matches found for "${query}"`;
}
