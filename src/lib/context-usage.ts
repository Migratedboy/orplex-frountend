/**
 * context-usage.ts — the numbers behind the context-window ring.
 *
 * One place owns:
 *   - the shape the ring renders (segments, limit, total, avgMessage),
 *   - the last provider-reported prompt size per conversation (ground truth
 *     beats our estimation when the provider tells us),
 *   - the conservative fallbacks when a model's window is unknown.
 *
 * The ESTIMATES come from `prompt-budget.ts` / `token-budget.ts` — the very
 * functions /api/chat uses to size a payload before sending it — so the ring
 * can never disagree with what the request builder actually counts.
 */

/** The four buckets the reference design draws. */
export type ContextSegmentKey = "system" | "tools" | "files" | "messages";

export interface ContextSegment {
  key: ContextSegmentKey;
  label: string;
  tokens: number;
}

export interface ContextUsage {
  /** Context window of the selected model, in tokens. */
  limit: number;
  /** True when no catalog entry existed and the conservative default was used. */
  limitEstimated: boolean;
  /** Model actually resolved for this conversation (router models fill this in). */
  resolvedModel: string | null;
  /** Where the total came from: the provider's own accounting, or our estimate. */
  source: "provider" | "estimate";
  segments: ContextSegment[];
  total: number;
  /** Average tokens per message in this conversation (for "messages left"). */
  avgMessage: number;
}

/** Conservative window for a model we have no catalog entry for. */
export const FALLBACK_CONTEXT_LIMIT = 32_000;

/** Floor used when averaging a conversation's messages. */
export const MIN_AVG_MESSAGE = 150;

/** Messages-left can't be meaningful below this; keeps the popover honest. */
export const DEFAULT_AVG_MESSAGE = 1_500;

export const SEGMENT_LABELS: Record<ContextSegmentKey, string> = {
  system: "System prompt",
  tools: "Tools",
  files: "Files",
  messages: "Messages",
};

/**
 * Scale estimated segments so their sum equals the provider-reported prompt
 * size. Providers report ONE number for the whole prompt; the split is ours.
 * Scaling keeps the total honest (the provider's) and the proportions ours.
 */
export function scaleSegments(segments: ContextSegment[], target: number): ContextSegment[] {
  const sum = segments.reduce((s, x) => s + x.tokens, 0);
  if (target <= 0 || sum <= 0) return segments;
  const k = target / sum;
  let running = 0;
  return segments.map((s, i) => {
    if (i === segments.length - 1) return { ...s, tokens: Math.max(0, Math.round(target - running)) };
    const tokens = Math.round(s.tokens * k);
    running += tokens;
    return { ...s, tokens };
  });
}

/**
 * Average tokens per message, from real message text.
 *
 * A chat with one huge pasted file should not claim "thousands of messages
 * left" just because it has few rows, so this is the mean over actual content
 * and is clamped to a sane floor.
 */
export function averageMessageTokens(messages: ReadonlyArray<{ content?: unknown }>, estimate: (t: string) => number): number {
  if (messages.length === 0) return DEFAULT_AVG_MESSAGE;
  let total = 0;
  for (const m of messages) {
    const content = m?.content;
    total += typeof content === "string" ? estimate(content) : estimate(JSON.stringify(content ?? ""));
  }
  const avg = Math.round(total / messages.length);
  return Math.max(MIN_AVG_MESSAGE, avg);
}

/* ------------------------------------------------------------------ *
 * Provider-reported prompt sizes
 *
 * /api/chat taps the provider stream and records `prompt_tokens` (and the
 * model that actually served the call) per conversation. Kept in memory: it
 * is a display number for a live chat, not data worth persisting — losing it
 * on restart only means the ring falls back to its own estimate.
 * ------------------------------------------------------------------ */

export interface PromptUsage {
  tokens: number;
  model: string | null;
  at: number;
}

const MAX_TRACKED = 200;
const usageByConversation = new Map<string, PromptUsage>();

export function recordPromptUsage(conversationId: string, usage: { tokens: number; model?: string | null }): void {
  const id = (conversationId || "").trim();
  const tokens = Math.round(Number(usage.tokens));
  if (!id || !Number.isFinite(tokens) || tokens <= 0) return;
  if (usageByConversation.size >= MAX_TRACKED && !usageByConversation.has(id)) {
    const oldest = [...usageByConversation.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) usageByConversation.delete(oldest[0]);
  }
  usageByConversation.set(id, {
    tokens,
    model: usage.model?.trim() || null,
    at: Date.now(),
  });
}

export function readPromptUsage(conversationId: string | null | undefined): PromptUsage | null {
  const id = (conversationId || "").trim();
  if (!id) return null;
  return usageByConversation.get(id) ?? null;
}

/** Test seam: forget every recorded reading. */
export function clearPromptUsage(): void {
  usageByConversation.clear();
}
