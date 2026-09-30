// cost-estimator.ts — Maps token usage to an estimated USD cost.
// Rates are per 1M tokens and approximate current list prices for the
// models routed by model-router.ts. Used for ambient cost display only —
// never for billing.

export const MODEL_COST_RATES: Record<string, { input: number; output: number }> = {
  // $ per 1M tokens
  "minimaxai/minimax-m3": { input: 0.3, output: 1.2 },
  "meta/llama-3.1-8b-instruct": { input: 0.06, output: 0.06 },
  "default": { input: 0.3, output: 1.2 },
};

const DEFAULT_RATE = MODEL_COST_RATES["default"];

/**
 * Estimate USD cost from token counts. Tokens in/out split lets us weight
 * input (cached/cheap) vs output (expensive) differently per model.
 */
export function estimateCost(
  tokensIn: number,
  tokensOut: number = 0,
  model?: string
): number {
  const rate = (model && MODEL_COST_RATES[model]) || DEFAULT_RATE;
  return (tokensIn / 1_000_000) * rate.input + (tokensOut / 1_000_000) * rate.output;
}

/**
 * Convenience for run-level display where only a combined token count is
 * known (AgentRun.tokenUsage). Assumes a 70/30 input/output split, which
 * matches observed tool-loop traffic.
 */
export function estimateCostFromTotal(totalTokens: number, model?: string): number {
  return estimateCost(totalTokens * 0.7, totalTokens * 0.3, model);
}

/** Format a USD cost for compact display: "$0.0042" or "$1.25" */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
