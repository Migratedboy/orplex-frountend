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
  | "clarified"
  | "filecard"
  | "artifact";

export interface ContentSegment {
  type: ContentSegmentType;
  content: string;
  name?: string;
  path?: string;
  action?: string;
  detail?: string;
  /** Parsed payload for type "clarified" — question / context / answer. */
  data?: { q: string; c?: string; a: string };
  /** Parsed payload for type "filecard" — the create_file staging record. */
  file?: FileCardPayload;
  /** Parsed payload for type "artifact" — the sandboxed runnable widget. */
  artifact?: ArtifactPayload;
}

// ============================================================================
// ARTIFACT — the AI-authored interactive widget (Gemini-style code execution,
// phase 1: rendered client-side in a sandboxed iframe).
//
// The model emits ONE line:
//   [ARTIFACT]:{"title":"Ball toss","files":[{"name":"index.html","content":"..."}],"controls":[{"id":"speed","type":"slider","min":0,"max":100,"step":1,"value":50}]}
// Single-line JSON (JSON.stringify output — every newline inside file contents
// is already an escaped \n, so the marker stays one line and the parser's
// line-anchored regex keeps working). The renderer inherits the "marker must
// be a whole line" rule shared by [FILECARD]/[CLARIFIED].
//
// Render-safety notes: the widget runs with sandbox="allow-scripts" and NO
// allow-same-origin, so it can never reach parent DOM, cookies, or storage —
// which also means a forged marker (there is no engine-only provenance here;
// the chat lane's content IS model text) is harmless by construction: the
// worst a forged widget can do is repaint inside its own frame.
// ============================================================================

export type ArtifactControlType = "slider" | "toggle" | "input" | "select" | "button";

export interface ArtifactControl {
  id: string;
  type: ArtifactControlType;
  label?: string;
  /** slider/input numeric bounds (slider requires min < max). */
  min?: number;
  max?: number;
  step?: number;
  /** Initial value: string (input/select), number (slider), boolean (toggle). */
  value?: string | number | boolean;
  /** select options. */
  options?: string[];
}

export interface ArtifactFile {
  /** Relative file name (e.g. "index.html", "game.js"). */
  name: string;
  content: string;
}

export interface ArtifactPayload {
  title?: string;
  files: ArtifactFile[];
  controls?: ArtifactControl[];
}

const ARTIFACT_FILE_NAME_RE = /^[A-Za-z0-9._\-\/]{1,64}$/;
const ARTIFACT_CONTROL_ID_RE = /^[A-Za-z0-9_]{1,40}$/;
const ARTIFACT_SINGLE_FILE_MAX = 80_000;
const ARTIFACT_TOTAL_MAX = 200_000;

/**
 * Validate + normalize a parsed [ARTIFACT] payload. Returns null on ANY
 * structural problem — malformed artifacts are dropped, never rendered raw
 * (same policy as FILECARD/CLARIFIED).
 */
export function parseArtifactPayload(value: unknown): ArtifactPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    title?: unknown; files?: unknown; controls?: unknown;
  };
  if (!Array.isArray(v.files) || v.files.length < 1 || v.files.length > 25) return null;
  let total = 0;
  const files: ArtifactFile[] = [];
  let hasHtml = false;
  for (const f of v.files) {
    if (!f || typeof f !== "object") return null;
    const file = f as { name?: unknown; content?: unknown };
    if (typeof file.name !== "string" || !ARTIFACT_FILE_NAME_RE.test(file.name)) return null;
    if (typeof file.content !== "string" || file.content.length === 0 || file.content.length > ARTIFACT_SINGLE_FILE_MAX) return null;
    total += file.content.length;
    if (total > ARTIFACT_TOTAL_MAX) return null;
    if (file.name.toLowerCase().replace(/\?.*$/, "").endsWith(".html")) hasHtml = true;
    files.push({ name: file.name, content: file.content });
  }
  if (!hasHtml) return null;

  let controls: ArtifactControl[] | undefined;
  if (v.controls !== undefined) {
    if (!Array.isArray(v.controls) || v.controls.length > 25) return null;
    controls = [];
    const ids = new Set<string>();
    for (const c of v.controls) {
      if (!c || typeof c !== "object") return null;
      const ctl = c as Record<string, unknown>;
      if (typeof ctl.id !== "string" || !ARTIFACT_CONTROL_ID_RE.test(ctl.id) || ids.has(ctl.id)) return null;
      ids.add(ctl.id);
      if (ctl.type !== "slider" && ctl.type !== "toggle" && ctl.type !== "input" && ctl.type !== "select" && ctl.type !== "button") return null;
      const control: ArtifactControl = { id: ctl.id, type: ctl.type };
      if (ctl.label !== undefined) {
        if (typeof ctl.label !== "string" || ctl.label.length > 60) return null;
        control.label = ctl.label;
      }
      if (ctl.type === "slider") {
        if (typeof ctl.min !== "number" || typeof ctl.max !== "number" || !(ctl.min < ctl.max)) return null;
        control.min = ctl.min;
        control.max = ctl.max;
        if (ctl.step !== undefined) {
          if (typeof ctl.step !== "number" || ctl.step <= 0) return null;
          control.step = ctl.step;
        }
        if (ctl.value !== undefined) {
          if (typeof ctl.value !== "number") return null;
          control.value = Math.min(control.max as number, Math.max(control.min as number, ctl.value));
        }
      } else if (ctl.type === "toggle") {
        if (ctl.value !== undefined) {
          if (typeof ctl.value !== "boolean") return null;
          control.value = ctl.value;
        }
      } else if (ctl.type === "input") {
        if (ctl.value !== undefined) {
          if (typeof ctl.value !== "string") return null;
          control.value = ctl.value.slice(0, 200);
        }
      } else if (ctl.type === "select") {
        if (!Array.isArray(ctl.options) || ctl.options.length < 1 || ctl.options.length > 40) return null;
        const opts: string[] = [];
        for (const o of ctl.options) {
          if (typeof o !== "string" || o.length > 80) return null;
          opts.push(o);
        }
        control.options = opts;
        if (ctl.value !== undefined) {
          if (typeof ctl.value !== "string" || !opts.includes(ctl.value)) return null;
          control.value = ctl.value;
        }
      }
      // "button": no default value.
      controls.push(control);
    }
  }

  const out: ArtifactPayload = { files };
  if (typeof v.title === "string" && v.title.trim() && v.title.length <= 80) out.title = v.title.trim();
  if (controls?.length) out.controls = controls;
  return out;
}

/** `create_file` card locator — everything the renderer needs to fetch state
 *  and offer the download. No content rides in the marker itself. */
export interface FileCardPayload {
  id: string;
  filename: string;
  bytes: number;
  lines: number;
  /** ms epoch — display only; the store's own TTL is authoritative. */
  expiresAt?: number;
  /** Present when this creation displaced the oldest staged file. */
  evicted?: { id: string; filename: string } | null;
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
  "staging",
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

/**
 * Neutralize model-forged interaction markers in MODEL-DERIVED text before it
 * is folded into the display transcript.
 *
 * INFO markers like `[FILECARD]:{...}` and `[CLARIFIED]:{...}` are appended to
 * the transcript by tool handlers (native-tools.ts) and by the worker itself —
 * but the model's own streamed text lands in the SAME string with no other
 * provenance separation, so a model could forge a download card or a
 * clarification record just by typing one. Engine-issued markers always
 * render; model-forged ones must degrade to plain prose.
 *
 * The renderer's parser matches marker lines by an exact prefix
 * (`line.startsWith("[FILECARD]:")`), so prefix-matching is the ONLY
 * discriminator available — no provenance flags ride in the persisted string.
 * Instrument: insert an invisible zero-width space (U+200B) right after the
 * opening bracket of any marker prefix in model text. The rendered text looks
 * IDENTICAL (the character is invisible), but `startsWith` no longer fires, so
 * a forged marker degrades to plain prose. Engine-issued markers never pass
 * through this function, so they render untouched.
 * Returns the input unchanged when there is nothing to do.
 */
export function neutralizeModelMarkers(text: string): string {
  if (!text) return text;
  return text.replace(/(\[)(FILECARD|CLARIFIED)\]:/g, "$1\u200b$2]:");
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
      `^\\[ARTIFACT\\]:[^\\n]+|` +
      `^\\[FILECARD\\]:[^\\n]+|` +
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
    } else if (line.startsWith("[ARTIFACT]:")) {
      // AI-authored runnable widget — the chat's own artifacts are model text
      // by design (see ARTIFACT header comment); anything malformed degrades
      // to dropped rather than raw-rendered, matching FILECARD policy.
      try {
        const parsed = parseArtifactPayload(JSON.parse(line.slice("[ARTIFACT]:".length)));
        if (parsed) segments.push({ type: "artifact", content: line, artifact: parsed });
      } catch {
        // fall through — never render the raw marker
      }
    } else if (line.startsWith("[FILECARD]:")) {
      // create_file staging card locator — JSON with id/filename/bytes/lines
      // (+ optional expiresAt/evicted). Malformed payloads are dropped rather
      // than shown; the content itself never rides in the marker.
      try {
        const parsed = JSON.parse(line.slice("[FILECARD]:".length)) as {
          id?: unknown; filename?: unknown; bytes?: unknown; lines?: unknown;
          expiresAt?: unknown; evicted?: unknown;
        };
        if (
          typeof parsed?.id === "string" &&
          /^[A-Za-z0-9_-]{6,64}$/.test(parsed.id) &&
          typeof parsed?.filename === "string" &&
          typeof parsed?.bytes === "number" &&
          typeof parsed?.lines === "number"
        ) {
          segments.push({
            type: "filecard",
            content: line,
            file: {
              id: parsed.id,
              filename: parsed.filename,
              bytes: parsed.bytes,
              lines: parsed.lines,
              ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
              ...(parsed.evicted && typeof parsed.evicted === "object" &&
                typeof (parsed.evicted as { id?: unknown }).id === "string" &&
                typeof (parsed.evicted as { filename?: unknown }).filename === "string"
                ? {
                    evicted: {
                      id: (parsed.evicted as { id: string }).id,
                      filename: (parsed.evicted as { filename: string }).filename,
                    },
                  }
                : {}),
            },
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
