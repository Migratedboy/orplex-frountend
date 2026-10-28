// message-retry.ts — Pure helpers for the one-click Retry flow on failed
// assistant messages.
//
// A failed task's bubble is stamped at write time with a `[FAILED]` line
// (same pattern as `[INTERRUPTED]`, which MessageContent already parses) and
// a serialized meta line holding what the ORIGINAL send used (mode, effort,
// model, attached files). Resending the exact original prompt — not a
// paraphrase — is what makes retry trustworthy.
//
// Two shapes exist because the write sites differ:
//  - useChatSession's subscriber (and run-sync reloads) write full meta.
//  - background-worker's mid-stream failure path knows nothing about the
//    UI layer, so it stamps the marker only; the meta is recovered at
//    retry time from the preceding user message's stamped meta (see
//    findFailedExchange below).
// Pure string/data functions only — no React, no DOM — so the rules stay
// unit-testable (same discipline as spend-format.ts).

import type { Message } from "@/hooks/useMessages";

/** Marker line appended to a failed assistant bubble. */
export const FAILED_MARKER = "[FAILED]";

/** Hidden meta line carrying the original send's parameters. */
export const FAILED_META_PREFIX = "[FAILED_META]:";

/** What a retry resends. mode/effort/model mirror sendMessage's parameters. */
export interface FailedMeta {
  mode?: string;
  effort?: string;
  model?: string;
  /** Attached text files (content + name + size) from the original send. */
  files?: { name: string; content: string; size: number }[];
  /** Attached images (name + dataUrl + size) from the original send. */
  images?: { name: string; dataUrl: string; size: number }[];
}

/**
 * Stamp a failed assistant bubble: `[FAILED]` for the renderer plus the
 * meta payload (base64 to survive markdown and multiline file content).
 * Content is normalized FIRST (thinking markers) by the caller — the stamp
 * must be the last thing written into the bubble.
 */
export function stampFailedMessage(
  content: string,
  meta?: FailedMeta | null
): string {
  const lines = [FAILED_MARKER];
  if (meta && hasMetaContent(meta)) {
    try {
      const encoded = typeof btoa === "function"
        ? btoa(unescape(encodeURIComponent(JSON.stringify(meta))))
        : Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
      lines.push(`${FAILED_META_PREFIX}${encoded}`);
    } catch {
      // Meta is an optimization (exact resend); the marker alone still works.
    }
  }
  const base = content.replace(/\s*$/, "");
  return `${base ? base + "\n" : ""}${lines.join("\n")}`;
}

function hasMetaContent(m: FailedMeta): boolean {
  return !!(m.mode || m.effort || m.model || (m.files && m.files.length > 0) || (m.images && m.images.length > 0));
}

/**
 * True when content carries the failed marker (meta optional). Line-based:
 * the marker must be its own line (first line or after a newline), so an
 * inline mention of "[FAILED]" in body text never arms the Retry button.
 */
export function isFailedMessage(content: string | undefined | null): boolean {
  if (typeof content !== "string") return false;
  return content.split("\n").includes(FAILED_MARKER);
}

/**
 * Extract the retry meta from a stamped assistant bubble (null when absent
 * or undecodable — callers fall back to the conversation's current settings).
 */
export function readFailedMeta(content: string): FailedMeta | null {
  const line = content.split("\n").find((l) => l.startsWith(FAILED_META_PREFIX));
  if (!line) return null;
  try {
    const b64 = line.slice(FAILED_META_PREFIX.length);
    const json = typeof atob === "function"
      ? decodeURIComponent(escape(atob(b64)))
      : Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as FailedMeta;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Find the exchange a Retry belongs to: the assistant bubble at `assistantIdx`
 * and the user prompt that precedes it (searching backward — a stale write
 * must never grab a newer exchange's prompt). Meta comes from the assistant
 * bubble's own stamp; worker-path stamps carry none and the caller falls
 * back to the picker's current state.
 */
export function findFailedExchange(
  messages: Message[],
  assistantIdx: number
): { user: Message; assistant: Message; meta: FailedMeta | null } | null {
  if (assistantIdx < 0 || assistantIdx >= messages.length) return null;
  const assistant = messages[assistantIdx];
  if (!assistant || assistant.role !== "assistant" || !isFailedMessage(assistant.content)) return null;
  let user: Message | null = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      user = messages[i];
      break;
    }
  }
  if (!user) return null;
  return { user, assistant, meta: readFailedMeta(assistant.content) };
}

/**
 * Extract the user-visible typed text from a (possibly workspace-wrapped)
 * user message. buildM3Context wraps sends as:
 *   `[WORKSPACE: <dir>]\n…\nUser request: <typed text>`
 * so everything from the last `User request: ` marker onward is the prompt.
 *
 * The marker is USER-CONTROLLED: a prompt that itself contains
 * "User request: " made lastIndexOf pick the inner occurrence and the Retry
 * button re-sent only the tail of the original request. The marker is only
 * honoured when it appears in the WRAPPER part of the message — i.e. before
 * the typed text starts — so an inner occurrence can never win.
 */
export function userTypedText(content: string): string {
  const marker = "User request: ";
  const idx = content.lastIndexOf(marker);
  if (idx !== -1) {
    const typed = content.slice(idx + marker.length).trim();
    if (typed) {
      // A wrapper marker is followed by the typed request; when the typed
      // request itself contains the marker again, the LAST one is inside the
      // user's text — keep the FIRST occurrence after the workspace header.
      const wrapperIdx = content.indexOf(marker);
      const head = content.slice(0, wrapperIdx);
      const isWrapped = /^\s*\[WORKSPACE:/.test(head);
      if (!isWrapped || wrapperIdx === idx) return typed;
      const firstTyped = content.slice(wrapperIdx + marker.length).trim();
      if (firstTyped) return firstTyped;
      return typed;
    }
  }
  return content;
}
