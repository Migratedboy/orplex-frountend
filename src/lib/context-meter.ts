// context-meter.ts — Live context-window gauge for the agent loops.
//
// The compactor decides WHEN to act, but both lanes were acting blind: they
// called the compactor on a fixed schedule or after the fact. A real meter
// lets the turn loop check, BEFORE each model call, how close the transcript
// is to the TPM budget and escalate compaction pressure in steps instead of
// discovering the wall with a 429/400.
//
// Usage (every turn, before callModel):
//   const reading = readContextMeter(messages, budgetTokens);
//   if (reading.level !== "ok") { ...compact / trim / degrade... }
//
// Pure and synchronous — no model calls, no state. Token estimation uses the
// same chars/4 heuristic as compaction.ts so the two modules never disagree
// by construction.

import type { CompactMessage } from "./compaction";
import { estimateCompactTokens } from "./compaction";

/** Escalating pressure levels, ordered. */
export type ContextPressure = "ok" | "warn" | "critical" | "over";

export interface ContextReading {
  /** Estimated tokens currently occupied by the transcript. */
  tokens: number;
  /** Budget in tokens the transcript must live within. */
  budgetTokens: number;
  /** tokens / budgetTokens, clamped to [0, ~]. >1 means already over. */
  fraction: number;
  /** Escalation level derived from the fraction. */
  level: ContextPressure;
  /** Tokens that need to be freed before the next model call would be safe. */
  overByTokens: number;
}

/**
 * Pressure thresholds as fractions of budget. warn at 70% leaves room for the
 * summary call itself; critical at 85% demands compaction THIS turn; over
 * means the next provider call may be rejected outright.
 */
export const CONTEXT_WARN_FRACTION = 0.7;
export const CONTEXT_CRITICAL_FRACTION = 0.85;

/**
 * Measure a transcript against a token budget. Accepts anything shaped like
 * API messages — SdkChatMessage, CompactMessage, { role, content } — because
 * it only ever reads role/content.
 */
export function readContextMeter(
  messages: ReadonlyArray<{ role: unknown; content: unknown }>,
  budgetTokens: number
): ContextReading {
  const safeBudget = budgetTokens > 0 ? budgetTokens : 0;
  let tokens = 0;
  for (const m of messages) {
    // Content can be a string (our lanes) or a parts array (provider-shaped);
    // stringify defensively rather than assuming either.
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content == null
          ? ""
          : Array.isArray(m.content)
            ? (m.content as unknown[])
                .map((p) =>
                  p && typeof p === "object" && "text" in (p as Record<string, unknown>)
                    ? String((p as { text?: unknown }).text ?? "")
                    : "",
                )
                .join("")
            : String(m.content);
    tokens += estimateCompactTokens(text);
  }
  const fraction = safeBudget > 0 ? tokens / safeBudget : tokens > 0 ? Infinity : 0;
  const level: ContextPressure =
    fraction > 1 ? "over" : fraction >= CONTEXT_CRITICAL_FRACTION ? "critical" : fraction >= CONTEXT_WARN_FRACTION ? "warn" : "ok";
  return {
    tokens,
    budgetTokens: safeBudget,
    fraction: Number.isFinite(fraction) ? fraction : Number.MAX_SAFE_INTEGER,
    level,
    overByTokens: Math.max(0, tokens - safeBudget),
  };
}

/**
 * Turn a reading into a one-line directive for the model. Empty string when
 * pressure is ok — no tokens spent when there is nothing to say.
 */
export function pressureDirective(reading: ContextReading): string {
  if (reading.level === "ok") return "";
  const pct = Math.min(999, Math.round(reading.fraction * 100));
  if (reading.level === "warn")
    return `[context] Transcript at ${pct}% of the context budget — be economical; finish the current step before starting broad new reading.`;
  if (reading.level === "critical")
    return `[context] Transcript at ${pct}% of the context budget — CRITICAL. Wrap up what you have and produce a result from what you know; do not open more reads.`;
  return `[context] Transcript is OVER the context budget (${pct}%) — answer from existing knowledge now; further tool use will be refused.`;
}

/** Type re-export convenience for callers building CompactMessage lists. */
export type { CompactMessage };
