// provider-params.test.ts — Regression cover for the provider-request bugs found
// in the deep audit. Every case here was a real hard-failure in production.

import { resolveMaxOutputTokens, rejectsTemperature, extractStatedOutputCap } from "../model-output-caps";

describe("rejectsTemperature", () => {
  it("flags the families that 400 on any non-default temperature", () => {
    // OpenAI o-series/gpt-5: "Unsupported parameter: 'temperature'"
    expect(rejectsTemperature("o3-mini")).toBe(true);
    expect(rejectsTemperature("openai/o3-mini")).toBe(true);
    expect(rejectsTemperature("gpt-5")).toBe(true);
    expect(rejectsTemperature("openai/gpt-5-mini")).toBe(true);
    // Anthropic: any temperature below 1 is a 400 on Claude 4.7+
    expect(rejectsTemperature("anthropic/claude-opus-4.7")).toBe(true);
    expect(rejectsTemperature("claude-sonnet-5")).toBe(true);
  });

  it("leaves ordinary models alone", () => {
    expect(rejectsTemperature("openai/gpt-4o")).toBe(false);
    expect(rejectsTemperature("openai/gpt-oss-120b")).toBe(false);
    expect(rejectsTemperature("qwen/qwen3.8-27b:free")).toBe(false);
    expect(rejectsTemperature("")).toBe(false);
  });

  it("requires a family boundary, so a digit inside a name never matches", () => {
    // "o1" must match as a family PREFIX, not as a substring anywhere.
    expect(rejectsTemperature("meta-llama/llama-3.1-o1x")).toBe(false);
    expect(rejectsTemperature("openrouter/some-vendor/gpt-50")).toBe(false);
    // ...but a real variant in that family IS flagged (o3-preview rejects it).
    expect(rejectsTemperature("command/o3-preview-copy")).toBe(true);
  });
});

describe("executor / adapter token params (the 500000 and 8192 literals)", () => {
  it("never requests more output than a bounded model allows", () => {
    // `complete()` used to hardcode max_tokens: 500000 — above EVERY provider
    // ceiling, so compaction and the strategy router 400'd on every call.
    for (const model of ["llama-3.3-70b-versatile", "gpt-4o", "gemini-2.0-flash", "mistral-large-latest"]) {
      expect(resolveMaxOutputTokens(model, 500_000)).toBeLessThanOrEqual(32_768);
    }
  });

  it("no longer starves frontier models on the tool-calling lane", () => {
    // `completeWithTools()` used to hardcode 8192, which truncated tool-call
    // JSON mid-object and surfaced a bogus "path required" error.
    expect(resolveMaxOutputTokens("claude-sonnet-4-20250514", 16_384)).toBeGreaterThan(8192);
    expect(resolveMaxOutputTokens("gpt-5", 16_384)).toBeGreaterThan(8192);
  });
});

describe("extractStatedOutputCap still holds after the audit changes", () => {
  it("recovers ceilings from every provider's real wording", () => {
    const cases: Array<[string, number]> = [
      ["'max_completion_tokens' must be less than or equal to 8192", 8192],
      ["max_tokens is too large: 65536. This model has a maximum of 16384 tokens", 16_384],
      ["max_tokens: 65536 > 64000, which is the maximum allowed", 64_000],
    ];
    for (const [body, expected] of cases) {
      expect(extractStatedOutputCap(body, 65_536)).toBe(expected);
    }
  });
});