/**
 * Per-model vision gating.
 *
 * The provider flag said "OpenRouter can proxy vision models", so the code
 * trusted it alone. Picking a text-only model (openai/gpt-oss-120b) with an
 * OpenRouter key forwarded raw image_url parts to a model that cannot decode
 * them, and the UI still announced "Image analyzed."
 */

import { canSendImageParts, modelSupportsVision } from "@/lib/vision-models";

describe("modelSupportsVision", () => {
  it("recognises genuinely multimodal models", () => {
    for (const id of [
      "google/gemini-2.0-flash",
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4",
      "meta-llama/llama-3.2-11b-vision-instruct",
      "qwen/qwen2.5-vl-32b-instruct",
      "mistralai/pixtral-12b",
    ]) {
      expect(modelSupportsVision(id)).toBe(true);
    }
  });

  it("rejects text-only models", () => {
    for (const id of [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "groq/llama-3.3-70b-versatile",
      "meta-llama/llama-3.1-8b-instant",
      "mistralai/mixtral-8x7b",
      "deepseek/deepseek-r1",
    ]) {
      expect(modelSupportsVision(id)).toBe(false);
    }
  });

  it("treats unknown and empty ids as text-only", () => {
    expect(modelSupportsVision("some/unknown-model-9000")).toBe(false);
    expect(modelSupportsVision("")).toBe(false);
    expect(modelSupportsVision(undefined)).toBe(false);
    expect(modelSupportsVision(null)).toBe(false);
  });
});

describe("canSendImageParts", () => {
  it("requires BOTH the transport and the model to agree", () => {
    // The bug: provider said yes, model was text-only.
    expect(canSendImageParts(true, "openai/gpt-oss-120b")).toBe(false);
    // Transport can't carry images, whatever the model.
    expect(canSendImageParts(false, "google/gemini-2.0-flash")).toBe(false);
    // Both agree.
    expect(canSendImageParts(true, "google/gemini-2.0-flash")).toBe(true);
    expect(canSendImageParts(undefined, "google/gemini-2.0-flash")).toBe(false);
  });
});
