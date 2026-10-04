// stream-reader.ts — SSE stream reader for LLM responses
// Handles both legacy XML tool calls and M3 native tool_calls + thinking content

import { deduplicateWords as dedupeWords, dedupeStreamedChunk, parseToolCalls as parseXmlToolCalls, replaceLastStatus } from "./tool-text";
import { apiFetch } from "@/lib/api-base";

export { deduplicateWords, dedupeStreamedChunk, replaceLastStatus };

/** Word-level dedup — implementation lives in tool-text.ts (shared). */
function deduplicateWords(text: string): string {
  return dedupeWords(text);
}

/** Legacy XML tool-call parser, typed as our ToolCall shape for the worker. */
export function parseToolCalls(text: string): ToolCall[] {
  return parseXmlToolCalls(text) as ToolCall[];
}

/**
 * Normalize reasoning blocks in FINAL persisted output so the ThinkingCard
 * (collapsible reasoning UI) survives — the user asked to keep thinking
 * visible — while guaranteeing raw reasoning can never bleed into the main
 * answer text. Three failure modes are repaired instead of deleted:
 *
 *  1. Markers glued into a line ("...[THINKING]text") — the UI parser only
 *     matches at line starts (^ with /m), so glue makes the block render as
 *     plain answer text. → put each marker on its own line.
 *  2. Unclosed block (Stop pressed mid-think, or no closer emitted) — gets an
 *     explicit [/THINKING] closer so the card is bounded and any answer text
 *     after it stays separate.
 *  3. Reasoning that leaked WITHOUT any wrapper (no [THINKING] at all) —
 *     recognized by a leading deliberation paragraph (hedging cues) and
 *     wrapped INTO a thinking block rather than deleted, so the reasoning is
 *     preserved in the card and the answer stays clean.
 *
 * If the output is thinking-only (no answer at all), a visible note is added
 * after the card so the message is never just raw reasoning.
 */
export function normalizeThinkingBlocks(text: string): string {
  const THINK_OPEN = "[THINKING]";
  const THINK_CLOSE = "[/THINKING]";

  let out = text;

  // 1. De-glue markers: the UI parser matches [THINKING]/[/THINKING] only at
  //    line starts. Give every marker its own line boundaries.
  out = out.replace(/\s*\[THINKING\]\s*/g, `\n${THINK_OPEN}\n`);
  out = out.replace(/\s*\[\/THINKING\]\s*/g, `\n${THINK_CLOSE}\n\n`);

  // 2. Detect leaked-but-unwrapped deliberation: a leading paragraph with
  //    deliberation cues, before any real answer formatting.
  const hasMarker = out.includes(THINK_OPEN);
  const leadMatch = !hasMarker
    ? out.match(/^\s*((?:we need|we'll|we should|let's|i need|first,? we|okay,? so|i'll start|the user (?:said|wants)|looking at this|given (?:the|this))\b[\s\S]*?)(?=\n\s*\n|\n#|\n\*\*|\n-|\n\d+\.|$)/i)
    : null;
  if (leadMatch?.index !== undefined) {
    const lead = leadMatch[1].trim();
    const rest = out.slice(leadMatch.index + leadMatch[0].length).trim();
    out = rest
      ? `${THINK_OPEN}\n${lead}\n${THINK_CLOSE}\n\n${rest}`
      : `${THINK_OPEN}\n${lead}\n${THINK_CLOSE}`;
  }

  // 3. Close any still-unclosed block (Stop mid-think / missing closer).
  const opens = (out.match(/\[THINKING\]/g) || []).length;
  const closes = (out.match(/\[\/THINKING\]/g) || []).length;
  if (opens > closes) {
    out = out.trimEnd() + `\n${THINK_CLOSE}`;
  } else if (closes > opens) {
    // Stray closer with no opener (shouldn't happen after de-glue, but be safe)
    out = out.replace(/\n\[\/THINKING\]\n?/g, "\n");
  }

  out = out.replace(/\n{3,}/g, "\n\n").trim();
  // 4. Thinking-only output: the whole message would be just the card with no
  //    answer. Append an honest note instead of leaving raw reasoning alone.
  const answer = out
    .replace(/\[THINKING\][\s\S]*?(\[\/THINKING\]|$)/g, "")
    .trim();
  if (!answer && out) {
    out += "\n\n*(The model stopped before producing an answer — try again.)*";
  }

  return out;
}

// === Task anchor: fitMessagesToBudget drops OLDEST messages first, so on a
// long tool loop the original task fell out of context entirely — the model
// literally asked "What would you like me to help you with?" mid-task
// (live-validated). Appending the task to the LAST message makes it the one
// message trimming can never drop.
export function appendTaskAnchor(messages: { role: string; content: string }[], task: string): { role: string; content: string }[] {
  if (!task || messages.length === 0) return messages;
  const out = messages.map(m => ({ ...m }));
  const anchor = `\n\n---\n[ORIGINAL TASK — the reason this conversation exists; never ask for clarification about it]\n${task}`;
  const last = out[out.length - 1];
  if (last.content.includes("[ORIGINAL TASK")) return out; // already anchored
  last.content = last.content + anchor;
  return out;
}

// === Interleaved-replay repair (gpt-oss pathology, LIVE-VALIDATED) ====
// gpt-oss-120b occasionally emits a REPLAYED token mix into the thinking
// channel: the same semantic content interleaved at near-identical offsets —
// "The user has The user has provided tool provided tool results showing:\n//  results showing:" (live transcript). deduplicateWords only collapses
// exact adjacent word pairs; this damage is PHRASE-level interleave. The
// provider's healthy path is untouched — this only fires when the tell-tale
// copy+overlap pattern actually exists, so it is safe on every fold site.

function normForReplay(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

export function repairInterleavedReplay(text: string): string {
  if (!text || text.length < 40) return text; // shortest repairable span is ~2×6 chars; keep margin
  const a = normForReplay(text);
  if (a.length < 24) return text;

  // Map normalized char index → raw index (first raw char that produced it).
  const index = new Map<number, number>();
  let n = 0;
  for (let i = 0; i < text.length && n < a.length; i++) {
    const c = normForReplay(text[i]);
    if (c) {
      if (!index.has(n)) index.set(n, i);
      n += c.length;
    }
  }

  const MIN_UNIT = 2; // 2–3-char units are gated below (glued-only, or punct-bearing)
  const MAX_UNIT = 200;
  const wordy = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  let repaired = text;
  let rawShift = 0; // length delta from prior repairs (raw indices drift)
  let didRepair = false;
  let an = 0;
  while (an + 2 * MIN_UNIT <= a.length) {
    // Find the smallest adjacent-copy unit: a[an..an+u) === a[an+u..an+2u).
    // (The corruption repeats whole phrases — "The user has The user has" —
    // so the unit, not a fixed window, is what must be detected.)
    let unit = -1;
    for (let u = MIN_UNIT; u <= MAX_UNIT && an + 2 * u <= a.length; u++) {
      if (a.slice(an, an + u) === a.slice(an + u, an + 2 * u)) { unit = u; break; }
    }
    if (unit < 0) { an++; continue; }
    const spanN = 2 * unit;

    // Map back to raw indices (±2-char grace — norm() strips punctuation).
    let rawStart = -1;
    for (let d = 0; d < 2 && an - d >= 0; d++) {
      const c = index.get(an - d);
      if (c !== undefined) { rawStart = c; break; }
    }
    let rawEnd = -1;
    for (let d = 0; d < 2; d++) {
      const c = index.get(an + spanN - 1 - d);
      if (c !== undefined) { rawEnd = c + 1; break; }
    }
    if (rawStart < 0 || rawEnd < 0 || rawEnd <= rawStart) { an++; continue; }
    // Raw index where the SECOND copy begins (normalized offset an+unit) —
    // splitting by raw char count misaligns when the two copies' spacing
    // differs ("The user has The user has" is 25 raw chars: half-split loses
    // "The " from the right half; the normalized boundary never does).
    let rawSecond = -1;
    for (let d = 0; d < 2; d++) {
      const c = index.get(an + unit - d);
      if (c !== undefined) { rawSecond = c; break; }
    }
    if (rawSecond < 0) { an++; continue; }
    const secondStart = rawSecond - rawShift;
    const s = rawStart - rawShift;
    const e = rawEnd - rawShift;
    if (s < 0 || s >= repaired.length || e > repaired.length) { an++; continue; }
    if (secondStart <= s || secondStart >= e) { an++; continue; }
    // Gap analysis: what separates copy 1 from copy 2 in the RAW text?
    //   ""          → copies glued ("pythonpython") — corruption. Repair.
    //   spaces/newl → echo seam ("with:\n     with:", LIVE-VALIDATED run 6;
    //                 also "has The user has") — corruption. Repair.
    //   "." / ". "  → one punct + optional whitespace between word boundaries
    //                 ("server.server" run 3, "grid. A features grid" run 6)
    //                 — corruption. Repair.
    //   ")**" etc.  → multi-punct or punct at a copy boundary — legitimate
    //                 markdown: "(browser verification)\n**Browser
    //                 verification passed". Never touch.
    // Short space-separated units (2–3 chars) must carry punctuation inside
    // the copy ("- -m -m" repairs; "go go", "ha ha" never touch).
    const copy1EndN = index.get(an + unit - 1);
    let gapStr = "";
    if (copy1EndN !== undefined) {
      const copy1End = copy1EndN - rawShift;
      gapStr = repaired.slice(copy1End + 1, secondStart);
      if (an > 0) {
        const wsOnly = /^\s+$/.test(gapStr);
        const shortSpaceLegit =
          gapStr === " " && unit <= 3 && !/[^\p{L}\p{N}\s]/u.test(repaired.slice(s, secondStart));
        const punctGap =
          /^[^\p{L}\p{N}\s]\s*$/u.test(gapStr) &&
          wordy(repaired[copy1End]) && wordy(repaired[secondStart]);
        const separable = gapStr.length === 0 || (wsOnly && !shortSpaceLegit) || punctGap;
        if (!separable) { an++; continue; }
      }
    }
    // Token-boundary guard for SHORT units: a <6-char unit must be a whole
    // raw token, never a fragment inside a word ("appapp" in "_app_app" is
    // corruption; "mm" inside "hammer" is a real word).
    if (unit < 6 && (wordy(repaired[s - 1]) || wordy(repaired[e]))) { an++; continue; }

    // Copy 1's raw span ends at its last WORD char — any gap chars (dot,
    // space) were separators and are dropped with the duplicate.
    const copy1EndRaw = copy1EndN !== undefined ? copy1EndN - rawShift : secondStart - 1;
    const left = repaired.slice(s, Math.min(copy1EndRaw + 1, secondStart));
    const right = repaired.slice(secondStart, e);
    // Safety: only rewrite when both copies normalize identically — never
    // mangle content we don't recognize ("the theory" must survive).
    if (!left.trim() || normForReplay(left) !== normForReplay(right)) { an++; continue; }

    // Glue/gap preservation: rejoin the way the original text was joined.
    //   glue/punct between wordy chars ("server.server", "_app_app") is
    //     token-internal — rejoin TIGHT ("server", "_app");
    //   whitespace seam keeps one space ("with:\n     with:" → "with:");
    //   punct + whitespace is sentence punctuation — preserve it ("grid. A
    //     features grid" keeps its period), consuming copy 2's duplicate tail
    //     punct when both copies carried it ("with:" … "with:" → one colon).
    let replacement = left.replace(/\s+$/, "");
    let eEnd = e;
    const gapPunct = gapStr.trim();
    if (gapStr.length > 0) {
      if (/^\s+$/.test(gapStr)) {
        replacement += " ";
      } else if (gapPunct && !/\s/.test(gapStr) && wordy(repaired[copy1EndRaw]) && wordy(repaired[secondStart])) {
        // token-internal — drop the gap, rejoin tight
      } else if (gapPunct) {
        replacement += gapPunct;
        if (repaired[e] === gapPunct) eEnd = e + 1; // copy 2's tail carried the same punct — consume it
        else if (wordy(repaired[e])) replacement += " ";
      }
    }
    repaired = repaired.slice(0, s) + replacement + repaired.slice(eEnd);
    rawShift += eEnd - s - replacement.length;
    didRepair = true;
    an += spanN; // skip past the repaired span (odd-length chains leave one copy — acceptable)
  }
  if (didRepair) {
    // Residue classes the span logic can't reach, safe ONLY once a real
    // replay repair fired (clean text is never rewritten):
    repaired = repaired.replace(/[^\S\n]{2,}/g, " "); // seams left double spaces ("has  provided")
    // Non-adjacent tail doubling: "5500" → "55000000". Legit prose/code has
    // no 3+ identical letters/digits in a row, so collapse runs to 2 ("mm"
    // stays, "oooo" → "oo").
    repaired = repaired.replace(/([\p{L}\p{N}])\1{2,}/gu, "$1$1");
  }
  if (repaired !== text) {
    repaired = deduplicateWords(repaired);
    // Fixpoint: overlapping corruptions can leave a second double behind the
    // first repair's new seam. One bounded extra pass settles chains.
    if (repairInterleavedReplay(repaired) !== repaired) {
      repaired = repairInterleavedReplay(repaired);
    }
  }
  return repaired;
}

// === Echoed-thinking strip (LIVE-VALIDATED defect) ===
// Some providers deliver reasoning on BOTH channels: the thinking delta AND a
// verbatim copy at the head of `content`. Appending both duplicated every
// deliberation paragraph into the saved transcript. The echo (when present)
// is a prefix of content whose normalized text is contained in the thinking,
// and prefix containment is monotonic — so binary-search the longest echoed
// prefix and cut exactly there, leaving the real answer untouched.

function normalizeForEcho(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Minimum normalized length before an overlap counts as an echo, not chance.
 *  LIVE-VALIDATED: real echoes include one-liners like "We need to verify the
 *  page. Use verify_app." (~40 normalized chars), so the bar must stay low —
 *  the anchor-at-thinking-start requirement is what prevents false positives
 *  (answers restating the task never match how the thinking OPENED). */
const ECHO_MIN_CHARS = 24;

export function stripEchoedThinking(content: string, thinking: string): string {
  if (!content || !thinking) return content;
  const nTh = normalizeForEcho(thinking);
  const nC = normalizeForEcho(content);
  if (nC.length < ECHO_MIN_CHARS || nTh.length < ECHO_MIN_CHARS) return content;
  // Providers echo the reasoning from its beginning — require the content's
  // opening to match the THINKING's opening, not just any substring (an
  // answer that restates the task would otherwise be eaten).
  if (!nTh.startsWith(nC.slice(0, ECHO_MIN_CHARS))) return content;

  let lo = ECHO_MIN_CHARS;
  let hi = nC.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2); // mid > lo whenever lo < hi
    if (nTh.startsWith(nC.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }

  // Map the normalized echo length back to an index in the raw content.
  let ni = 0;
  let ci = 0;
  while (ni < lo && ci < content.length) {
    ni += normalizeForEcho(content[ci]).length;
    ci++;
  }
  // Punctuation normalizes to nothing, so ci can stop right before the
  // echo's own trailing "."/"!"/etc. Drop a leading punctuation-only run
  // (never whitespace or word chars — the answer's formatting survives).
  return content.slice(ci).replace(/^[^\w\n]+/, "");
}

// === FILES-NOT-FENCES display guard ===
// When the task already wrote real files, full-file code fences in the final
// answer are redundant bulk — the model re-pasting what write_file already
// produced (Prime Directive #1 violation, LIVE-VALIDATED). Replace large
// fences with a one-line pointer; small snippets (≤6 lines) and all reasoning
// inside [THINKING] blocks pass through untouched.

export function stripRedundantFences(
  text: string,
  opts: { filesWritten: boolean }
): string {
  if (!opts.filesWritten || !text) return text;
  // Keep reasoning blocks verbatim — only the visible answer is enforced.
  const parts = text.split(/(\[THINKING\][\s\S]*?\[\/THINKING\])/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // captured thinking block — preserve
      return part.replace(
        /```(\w+)?[^\n]*\n([\s\S]*?)```/g,
        (full: string, _lang: string, body: string) => {
          const lineCount = String(body).replace(/\n$/, "").split("\n").length;
          if (lineCount <= 6) return full; // small snippets can stay
          return "*→ full content already written to the workspace — see the file, not the chat*";
        }
      );
    })
    .join("");
}

// === Tool call types ===

export interface ToolCall {
  name: string;
  path?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  // read_file pagination — 1-based line offset + line-count limit
  offset?: number;
  limit?: number;
  // code_search — context lines around each match (0-10, default 3)
  context?: number;
  query?: string;
  command?: string;
  url?: string;
  action?: string;
  items?: string[];
  completed_index?: number;
  question?: string;
  options?: string[];
  allow_free_text?: boolean;
  // ask_clarification — accept a typed reply alongside the option pills
  allow_freetext?: boolean;
  edits?: { path: string; old_text: string; new_text: string }[];
  timeout?: number;
  // verify_app
  dev_command?: string;
  port?: number;
  interactions?: { action: string; selector?: string; value?: string }[];
  // agent browser tools
  selector?: string;
  ref?: string; // element ref from browser_find (e1, e2, …)
  text?: string;
  key?: string;
  amount?: number;
  code?: string;
  // browser_find / browser_wait_for / browser_select / browser_tabs / browser_screenshot
  role?: string;
  value?: string;
  time?: number;
  timeoutMs?: number;
  index?: number; // browser_tabs switch/close target
  fullPage?: boolean;
  viewpoint?: string;
  // scratchpad_update
  section?: string;
}

// (deduplicateWords, parseToolCalls and replaceLastStatus moved to
// tool-text.ts — the single home for those helpers — and are re-exported
// above so existing imports keep working.)

// === Accumulated native tool call state (M3 streams tool calls across multiple deltas) ===

interface NativeToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

// === Stream reader ===

export interface StreamResult {
  content: string | null;
  thinking: string;
  toolCalls: ToolCall[];
}

export interface StreamCallbacks {
  onChunk: (content: string) => void;
  onThinking?: (thinking: string) => void;
}

export async function readStream(
  messages: { role: string; content: string }[],
  conversationId: string | null,
  callbacks: StreamCallbacks,
  mode: string = "ask",
  images: string[] = [],
  signal?: AbortSignal | null,
  effort?: string,
  profile?: "full" | "compact",
  model?: string
): Promise<StreamResult> {
  const { onChunk, onThinking } = callbacks;

  const isAborted = () => signal?.aborted === true;

  // No silent retry loop: a 429 here is a hard quota/burst limit from /api/chat
  // (transient provider 429s are already retried server-side). Failing fast
  // surfaces the real message instead of hanging the agent for minutes.
  const res = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      conversationId: conversationId || undefined,
      mode,
      images: images.length > 0 ? images : undefined,
      effort: effort || undefined,
      profile: profile || undefined,
      model: model || undefined,
    }),
    signal: signal ?? undefined,
  });

  if (!res.ok) {
    const err = await res?.json().catch(() => ({})) || {};
    throw new Error(err.error?.message || `HTTP ${res?.status || "unknown"}`);
  }

  if (!res.body) throw new Error("Response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let streamedContent = "";
  let cleanStreamed = ""; // incrementally deduped view handed to onChunk
  let thinkingContent = "";
  // Partial-event buffer: network chunks do NOT align with SSE events. A
  // chunk can end mid-JSON ("data: {\"content\":\"hel"), and processing
  // per-chunk lines silently dropped both halves — the delta vanished and
  // truncated native tool_call fragments never reassembled (the model's work
  // was discarded as an "empty response"). Incomplete tails wait here for
  // the next chunk, exactly like the server-side sseTransform reader.
  let pending = "";
  const accumulatorMap = new Map<number, NativeToolCallAccumulator>();
  const TIMEOUT_MS = 300_000; // 300s — Kimi K3 needs time to think

  // Single idle timer for the whole stream — cleared as soon as a chunk arrives
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const createIdleTimeout = () =>
    new Promise<{ done: true; value: undefined }>((resolve) => {
      idleTimer = setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS);
    });

  // When the caller cancels (Stop pressed), rip the reader so a pending
  // read rejects immediately instead of waiting for the next chunk.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // One event-line processor, shared by the chunk loop and the final flush.
  const processDataLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);

      // 1. Regular text content
      if (parsed.content) {
        streamedContent += parsed.content;
        // Bounded-window dedupe — NEVER re-scan the whole text per chunk
        // (O(n²) per stream froze the UI while the agent ran).
        cleanStreamed = dedupeStreamedChunk(cleanStreamed, parsed.content);
        onChunk(cleanStreamed);
      }

      // 2. Thinking/reasoning content
      const reasoningText = parsed.thinking || parsed.reasoning_content;
      if (reasoningText) {
        thinkingContent += reasoningText;
        onThinking?.(reasoningText);
      }

      // 3. M3 native tool calls — accumulate fragments by index
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          const idx = tc.index ?? 0;
          if (!accumulatorMap.has(idx)) {
            accumulatorMap.set(idx, { index: idx, arguments: "" });
          }
          const acc = accumulatorMap.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
    } catch {}
  };

  try {
    while (true) {
      if (isAborted()) {
        throw new DOMException("Aborted", "AbortError");
      }
      const result = await Promise.race([reader.read(), createIdleTimeout()]);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (result.done) break;
      const chunk = decoder.decode(result.value, { stream: true });
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() || ""; // incomplete tail — held for the next chunk
      for (const line of lines) {
        processDataLine(line);
      }
    }
    // Stream ended — process any final complete event that lacked its
    // trailing newline (a last chunk cut right after the JSON).
    if (pending) processDataLine(pending);
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    signal?.removeEventListener("abort", onAbort);
  }

  // Finalize accumulated native tool calls
  const nativeToolCalls: ToolCall[] = [];
  for (const [, acc] of accumulatorMap) {
    if (acc.name) {
      const call: ToolCall = { name: acc.name };
      if (acc.arguments) {
        try {
          const args = JSON.parse(acc.arguments);
          if (args.path) call.path = args.path;
          if (args.content) call.content = args.content;
          if (args.old_text) call.old_text = args.old_text;
          if (args.new_text) call.new_text = args.new_text;
          if (args.query) call.query = args.query;
          if (args.command) call.command = args.command;
          if (args.url) call.url = args.url;
          if (args.action) call.action = args.action;
          if (args.items) call.items = args.items;
          if (args.completed_index !== undefined) call.completed_index = args.completed_index;
          if (args.question) call.question = args.question;
          if (args.options) call.options = args.options;
          if (args.allow_free_text !== undefined) call.allow_free_text = args.allow_free_text;
          if (args.edits && Array.isArray(args.edits)) call.edits = args.edits;
        } catch {}
      }
      nativeToolCalls.push(call);
    }
  }

  // Also parse legacy XML tool calls from content (backward compat)
  const legacyToolCalls = parseToolCalls(streamedContent);
  const allToolCalls = [...nativeToolCalls, ...legacyToolCalls];

  // Kill provider-echoed reasoning before it enters any downstream path
  // (display, FORCE-TOOLS text check, apiMessages history) — the worker
  // appends the thinking channel and the content channel separately, so an
  // echoed copy inside content duplicated every deliberation paragraph.
  const cleanedContent = stripEchoedThinking(streamedContent, thinkingContent);

  return { content: cleanedContent || null, thinking: thinkingContent, toolCalls: allToolCalls };
}
