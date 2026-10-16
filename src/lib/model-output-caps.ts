// model-output-caps.ts — How many output tokens a model will actually accept.
//
// WHY THIS EXISTS (the paid-model bug):
// /api/chat used to take `max_completion_tokens` straight from the *effort
// tier* (TIER3/premium = 65536) and ignore what the user actually picked. A
// premium-tier pick of a paid model with a 16k output ceiling (gpt-4o class)
// therefore asked the provider for 65536, got an HTTP 400 back, and the only
// self-heal in the request path matched Groq's exact error sentence — so
// OpenAI/Anthropic/Mistral/OpenRouter worded their 400s differently, nothing
// recovered, and the paid model looked completely broken.
//
// Two layers fix that, and both are needed:
//   1. this file — ask for something the model can actually produce;
//   2. chat-middleware's generic cap-learning retry — when a provider still
//      says no, believe it and retry at its stated ceiling.
//
// The bias is deliberately conservative: asking for too few tokens merely
// truncates a long answer, while asking for too many HARD FAILS the request.
// So when a model's true ceiling is unknown we undershoot and let the retry
// ladder climb, never the other way round.

/** Safe default when nothing better is known. Common modern ceiling. */
const SAFE_DEFAULT_OUTPUT = 16_384;

const FLOOR_OUTPUT = 512;

/**
 * Families whose real ceiling is far above the default. Ordered most specific
 * first; matched as substrings of the model id (ids are namespaced, e.g.
 * `openai/o3-mini`, so substring matching is the right shape here).
 */
const KNOWN_OUTPUT_CAPS: Array<[RegExp, number]> = [
  // Reasoning families: very large output budgets, and they refuse small
  // values below a floor of their own — so never cap these low.
  [/^(?:.*\/)?(?:o1|o3|o4)(?:-|$)/i, 100_000],
  [/gpt-5/i, 128_000],
  [/deepseek-?r1/i, 32_768],
  [/qwq|thinking|reasoner/i, 32_768],
  [/grok/i, 32_768],
  // Anthropic: 64k on Sonnet 4 / Opus 4, 32k elsewhere. 32k is safe for both.
  [/claude/i, 32_768],
  [/llama/i, 32_768],
  [/command-r/i, 32_768],
  // Small-output families where the default would 400.
  [/gemini/i, 8_192],
  [/mistral|mixtral|codestral/i, 8_192],
  [/qwen(?!q)/i, 8_192],
  [/gpt-4o-mini|gpt-4-turbo|gpt-4\.1-mini/i, 16_384],
  [/gpt-4o|gpt-4\.1/i, 16_384],
];

/**
 * Resolve a safe `max_completion_tokens` for a concrete model id.
 *
 * @param modelId        the id actually being sent to the provider
 * @param requested      what the caller would like (usually the effort tier's cap)
 * @param contextWindow  total context, when known — an output budget larger than
 *                       the whole window is nonsense and always rejected
 */
export function resolveMaxOutputTokens(
  modelId: string,
  requested: number,
  contextWindow?: number
): number {
  const id = (modelId || "").trim();

  let cap = SAFE_DEFAULT_OUTPUT;
  for (const [pattern, value] of KNOWN_OUTPUT_CAPS) {
    if (pattern.test(id)) {
      cap = value;
      break;
    }
  }

  // Never budget more output than the model can hold in total.
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    cap = Math.min(cap, Math.floor(contextWindow * 0.5));
  }

  const wanted = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : cap;
  // The floor applies to the ASK, never above `cap`: with a tiny context window
  // the clamp can land below the floor, and Math.max(floor, …) used to hand
  // back a budget larger than the model can hold, contradicting the clamp.
  return Math.min(cap, Math.max(FLOOR_OUTPUT, wanted));
}

/**
 * Reasoning-family models that reject a non-default `temperature`.
 *
 * OpenAI's o-series / gpt-5 return "Unsupported parameter: 'temperature'"; and
 * Anthropic's OpenAI-compat docs state that on Claude 4.7+ any temperature
 * below 1 is a 400, so the parameter must be omitted entirely. Sending a
 * temperature to these is a guaranteed failure, which is why the chat and
 * executor lanes both drop it rather than clamping it.
 */
export function rejectsTemperature(modelId: string): boolean {
  const id = (modelId || "").trim();
  if (!id) return false;
  return /^(?:.*\/)?(?:o1|o3|o4|gpt-5)(?:-|$)/i.test(id) || /claude-(?:opus|sonnet|haiku)-?[45]\.[7-9]/i.test(id) || /claude-(?:opus|sonnet|haiku)-?[5-9]/i.test(id);
}

/**
 * Read a provider's stated output ceiling out of an error body.
 *
 * Provider-agnostic on purpose: Groq, OpenAI, Anthropic, Mistral, Together,
 * Cerebras and OpenRouter each phrase this differently, and matching only one
 * phrasing is exactly what broke paid models before.
 *
 * Returns null unless the parsed number is SMALLER than what we asked for —
 * that guard makes a mis-parse harmless (we'd merely retry at a smaller size)
 * instead of sending an absurd cap back at the provider.
 */
export function extractStatedOutputCap(errorText: string, requested: number): number | null {
  if (!errorText) return null;

  // Ordered precise → loose. Each entry carries the capture group that holds
  // the ceiling, because some phrasings lead with the rejected value.
  const patterns: Array<[RegExp, number]> = [
    [
      /(?:max_tokens|max_completion_tokens|max_output_tokens)['"`]?\s*(?:must be|should be|may be|is|of)?\s*(?:less than or equal to|at most|no greater than|too large|>?=?|below|under|exceeds?)\s*['"`]?(\d[\d,]*)/i,
      1,
    ],
    [/has\s+a\s+maximum\s+of\s+['"`]?(\d[\d,]*)/i, 1],
    [/maximum(?:\s+allowed)?(?:\s+number)?\s+of\s+['"`]?(\d[\d,]*)/i, 1],
    // Anthropic: "max_tokens: 65536 > 64000, which is the maximum allowed"
    [/(\d[\d,]*)\s*>\s*(\d[\d,]*)\s*,?\s*which is the maximum/i, 2],
    // Loose last resort: the first number following the word "maximum",
    // provided it is close enough to belong to that clause. Only consulted
    // when nothing more precise matched.
    [/maximum[^.\n]{0,60}?(\d[\d,]*)/i, 1],
  ];

  const consider = (n: number | undefined, out: number | null): number | null => {
    if (n === undefined || !Number.isFinite(n) || n <= 0) return out;
    // Only ever believe a ceiling LOWER than our current ask — a mis-read
    // number must not inflate the budget.
    if (n >= requested) return out;
    return out === null || n > out ? n : out;
  };

  let best: number | null = null;
  for (const [re, group] of patterns.slice(0, -1)) {
    const m = errorText.match(re);
    if (m) best = consider(Number(String(m[group]).replace(/,/g, "")), best);
  }
  if (best === null) {
    const [loose] = patterns.slice(-1);
    const m = errorText.match(loose[0]);
    if (m) best = consider(Number(String(m[loose[1]]).replace(/,/g, "")), best);
  }

  if (best === null) return null;
  return Math.max(FLOOR_OUTPUT, best);
}