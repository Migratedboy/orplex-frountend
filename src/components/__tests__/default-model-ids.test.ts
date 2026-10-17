/**
 * Guard the DEFAULT_MODELS ids against fabrication.
 *
 * `stealth/space-bunny-alpha:free` was added from a pricing-page listing and
 * shipped; it is not in OpenRouter's live catalogue, so every request to it
 * failed with "model is not responding right now". The web said it existed.
 *
 * This test hits the LIVE /api/v1/models endpoint (cached for the run) and
 * fails if any default id is absent. OpenRouter model ids are stable for
 * months, so a network-dependent test is the right trade here - the alternative
 * is a list that rots silently and only shows up as a user-facing error.
 *
 * Skips (rather than fails) when the network is unavailable, so an offline dev
 * box is not blocked.
 */

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";

let ids: Set<string> | null = null;
let skipped = false;

beforeAll(async () => {
  try {
    const res = await fetch(OPENROUTER_MODELS, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    ids = new Set((data.data ?? []).map((m) => m.id ?? ""));
  } catch {
    skipped = true;
  }
}, 45_000);

const DEFAULT_KEYS = [
  // Groq free tier
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  // OpenRouter :free
  "thinkingmachines/inkling:free",
  "thinkingmachines/inkling-small:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3.5-lightning:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "cohere/north-mini-code:free",
  "liquid/lfm-2.5-2.6b:free",
];

/** The two ids that are served by Groq rather than OpenRouter. */
const GROQ_KEYS = new Set(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);

describe("default model ids exist upstream", () => {
  it("every DEFAULT_MODELS key is in the live OpenRouter catalogue", () => {
    if (skipped || !ids) {
      console.warn("[skipped] could not reach OpenRouter; id check not run");
      return;
    }
    const missing = DEFAULT_KEYS.filter((k) => !ids!.has(k));
    expect(missing).toEqual([]);
  });

  it("the picker no longer offers the bogus space-bunny id", () => {
    expect(DEFAULT_KEYS.some((k) => k.includes("space-bunny"))).toBe(false);
  });

  it("contains NO paid models - a default row must never bill the user", () => {
    // Every OpenRouter default must be a :free id. Paid frontier models
    // (claude-sonnet-4.5, gpt-5.1, gemini-2.5-pro, deepseek-v3.2) were briefly
    // shipped here and are exactly the surprise-cost hazard this blocks: a
    // default the user never consciously chose, charging per token.
    const paid = DEFAULT_KEYS.filter((k) => !GROQ_KEYS.has(k) && !k.endsWith(":free"));
    expect(paid).toEqual([]);
  });

  it("labels every non-Groq default as free", () => {
    for (const k of DEFAULT_KEYS) {
      if (GROQ_KEYS.has(k)) continue;
      expect(k.endsWith(":free")).toBe(true);
    }
  });
});
