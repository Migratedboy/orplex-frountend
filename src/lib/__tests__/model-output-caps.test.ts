// model-output-caps.test.ts — Regression cover for the paid-model bug.
//
// The failure this file exists to prevent: /api/chat took max_completion_tokens
// from the EFFORT TIER (premium = 65536) instead of from the model the user
// actually picked. Every paid model with a smaller real ceiling answered HTTP
// 400, and the only recovery matched Groq's exact sentence, so OpenAI,
// Anthropic, Mistral, Together, Cerebras and OpenRouter never recovered —
// picking a paid model simply failed.

import { resolveMaxOutputTokens, extractStatedOutputCap } from "../model-output-caps";

describe("resolveMaxOutputTokens", () => {
  it("never asks a 16k-output paid model for the premium tier's 65536", () => {
    // The exact regression: premium effort tier requests 65536.
    expect(resolveMaxOutputTokens("openai/gpt-4o", 65_536)).toBeLessThanOrEqual(16_384);
    expect(resolveMaxOutputTokens("gpt-4o-mini", 65_536)).toBeLessThanOrEqual(16_384);
  });

  it("keeps big reasoning budgets that genuinely support them", () => {
    expect(resolveMaxOutputTokens("openai/o3-mini", 65_536)).toBeGreaterThanOrEqual(65_536);
    expect(resolveMaxOutputTokens("anthropic/claude-sonnet-4", 65_536)).toBeGreaterThanOrEqual(32_768);
  });

  it("shrinks the budget for families with small output ceilings", () => {
    expect(resolveMaxOutputTokens("google/gemini-2.0-flash", 65_536)).toBeLessThanOrEqual(8_192);
    expect(resolveMaxOutputTokens("mistral/mistral-large-latest", 65_536)).toBeLessThanOrEqual(8_192);
  });

  it("never budgets more output than the model can hold in total", () => {
    // A 16k-window model cannot produce 8k output on top of our big prompt.
    expect(resolveMaxOutputTokens("some/unknown-model", 65_536, 16_000)).toBeLessThanOrEqual(8_000);
  });

  it("honours a deliberately small ask (low effort) instead of inflating it", () => {
    expect(resolveMaxOutputTokens("openai/gpt-4o", 2_048)).toBe(2_048);
  });

  it("stays above the floor and never returns garbage", () => {
    expect(resolveMaxOutputTokens("", 65_536)).toBeGreaterThan(0);
    expect(resolveMaxOutputTokens("openai/gpt-4o", 0)).toBeGreaterThan(0);
    expect(resolveMaxOutputTokens("openai/gpt-4o", Number.NaN)).toBeGreaterThan(0);
    expect(resolveMaxOutputTokens("openai/gpt-4o", 65_536, 0)).toBeGreaterThan(0);
  });
});

describe("extractStatedOutputCap", () => {
  // Each string below is a REAL error shape from a provider, copied from how
  // each one phrases an oversized completion budget.
  const REAL_ERRORS: Array<[string, string, number]> = [
    ["Groq", "invalid_request_error: 'max_completion_tokens' must be less than or equal to 8192", 8192],
    ["OpenAI", "max_tokens is too large: 65536. This model has a maximum of 16384 tokens", 16_384],
    ["Anthropic", "max_tokens: 65536 > 64000, which is the maximum allowed number of output tokens", 64_000],
    ["Mistral", "This model has a maximum of 8192 tokens", 8192],
    ["OpenRouter", "max_tokens must be less than or equal to 32768", 32_768],
    ["Together", "max_completion_tokens exceeds the maximum allowed for this model: 4096", 4096],
    ["Cerebras", "Requested max tokens (65536) exceeds model maximum of 8192", 8192],
  ];

  it.each(REAL_ERRORS)("recovers the stated ceiling from %s", (_provider, body, expected) => {
    expect(extractStatedOutputCap(body, 65_536)).toBe(expected);
  });

  it("ignores a cap that is not SMALLER than what we asked (mis-parse guard)", () => {
    // If the only number found is bigger than our ask, believing it would
    // inflate the budget — refuse instead.
    expect(extractStatedOutputCap("maximum of 200000 tokens", 8_192)).toBeNull();
  });

  it("returns null for unrelated errors so the ladder fails over normally", () => {
    expect(extractStatedOutputCap("model is overloaded, please retry", 65_536)).toBeNull();
    expect(extractStatedOutputCap("", 65_536)).toBeNull();
  });

  it("handles thousands separators without producing NaN", () => {
    expect(extractStatedOutputCap("maximum of 16,384 tokens", 65_536)).toBe(16_384);
  });

  it("survives a body full of numbers but no cap wording", () => {
    expect(extractStatedOutputCap("{\"id\":\"abc\",\"count\":123,\"limit\":456}", 65_536)).toBeNull();
  });
});