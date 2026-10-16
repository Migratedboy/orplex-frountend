// format-tokens.ts — Compact token counts for UI labels.
//
// The compaction divider needs to say "~210k → ~22k" without pretending to
// precision it does not have. Token counts here are ESTIMATES (the app sizes
// prompts with a chars/4 heuristic), so a trailing digit would be a lie:
// 210003 tokens and 210000 both render "~210k".
//
// Thresholds chosen so the label never grows past ~5 characters:
//   < 1_000      plain number      842      -> "842"
//   < 1_000_000  thousands         210_000  -> "~210k"
//   >= 1_000_000 millions, 1 dp    1_200_000-> "~1.2M"

/**
 * Abbreviate a token count for display.
 *
 * @param n      token count (any finite number; negatives and NaN degrade to "~0")
 * @param approx prefix with "~" — pass false when the number is exact
 */
export function formatTokens(n: number, approx = true): string {
  if (!Number.isFinite(n) || n <= 0) return approx ? "~0" : "0";
  const prefix = approx ? "~" : "";
  const abs = Math.abs(n);
  if (abs < 1_000) return `${prefix}${Math.round(n)}`;
  if (abs < 1_000_000) {
    // Trim a trailing ".0" so 200_000 reads "~200k" and not "~200.0k".
    const k = Math.round(abs / 1_000);
    return `${prefix}${k.toLocaleString("en-US")}k`;
  }
  const m = abs / 1_000_000;
  const oneDp = Math.round(m * 10) / 10;
  return `${prefix}${oneDp.toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
}

/** The "~210k → ~22k" delta shown on the divider. */
export function formatTokenDelta(before: number, after: number): string {
  return `${formatTokens(before)} → ${formatTokens(after)}`;
}