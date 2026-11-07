// prompt-budget.ts — size a /api/chat payload BEFORE the provider sees it.
//
// LIVE FAIL (2026-11-07): the platform Groq key is a free tier with an 8,000
// tokens-per-MINUTE ceiling, while one full request measured 4,094 tokens of
// master prompt + 10,378 tokens of 76-tool roster ≈ 14.5k — nearly twice the
// whole minute's budget. A request that large can never succeed:
//
//   HTTP 413 {"error":{"message":"Request too large for model
//   `openai/gpt-oss-120b` … tokens per minute (TPM): Limit 8000, Requested
//   13636, please reduce your message size and try again."}}
//
// Retrying is useless (the SAME payload goes back out, and the refused
// attempt is charged against the window), which is why more retries changed
// nothing and the failure copy read "it is not a problem that will fix
// itself".
//
// The app already had a payload that WORKS — the compact master prompt (249
// tokens) + the lean roster (3,979 tokens) — but only used it after a 413.
// Measured on the live key: full payload → 413, compact + lean → HTTP 200.
// So pick the profile from the budget up front.
//
// Pure functions only (no React, no I/O) so the arithmetic stays testable.

import { estimateTokens } from "./token-budget";

/** Free-tier per-minute token ceiling for the platform Groq key. */
export const PLATFORM_TPM_LIMIT = 8_000;

/**
 * How much of that ceiling a single prompt may occupy.
 *
 * Leftover room covers the provider's own accounting, the streamed reply, and
 * any turn already in flight in the same minute. At 8,000 TPM the full payload
 * (14.5k) is impossible and the lean one (4.2k) fits with margin.
 */
export const PLATFORM_PROMPT_BUDGET = Math.floor(PLATFORM_TPM_LIMIT * 0.8);

/** Tokens a tool-schema roster costs (the JSON is what goes on the wire). */
export function toolSchemaTokens(tools: unknown): number {
  try {
    return estimateTokens(JSON.stringify(tools ?? []));
  } catch {
    return 0;
  }
}

/** Tokens the conversation history costs. */
export function messagesTokens(messages: Array<{ content?: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    const content = m?.content;
    total += typeof content === "string"
      ? estimateTokens(content)
      : estimateTokens(JSON.stringify(content ?? ""));
  }
  return total;
}

/** Total prompt size: system + history + tool schema. */
export function promptTokens(args: {
  system: string;
  messages: Array<{ content?: unknown }>;
  tools: unknown;
}): number {
  return estimateTokens(args.system) + messagesTokens(args.messages) + toolSchemaTokens(args.tools);
}

/**
 * Drop the OLDEST history messages until the conversation fits `maxTokens`.
 *
 * The LAST message is never dropped — it is the user's actual request; losing
 * it would answer the wrong thing. A negative/zero budget therefore keeps just
 * that message instead of returning nothing.
 */
export function trimMessagesToTokens<T extends { content?: unknown }>(
  messages: T[],
  maxTokens: number,
): T[] {
  if (messages.length <= 1) return [...messages];
  const out = [...messages];
  const budget = Math.max(0, Number.isFinite(maxTokens) ? maxTokens : 0);
  while (out.length > 1 && messagesTokens(out) > budget) out.shift();
  return out;
}
