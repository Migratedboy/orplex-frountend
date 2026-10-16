// Per-model vision capability.
//
// `supportsVision` on the provider registry is a PROVIDER-level flag:
// OpenRouter sets it true because it *can* proxy Gemini/Claude/GPT-4o. But the
// model id the user actually picked may be text-only, and the old code trusted
// the provider flag alone. Picking `openai/gpt-oss-120b` with an OpenRouter key
// therefore forwarded raw image_url parts to a model that cannot decode them,
// while the UI announced "Image analyzed."
//
// So vision support is now the AND of two things: the transport can carry
// image parts, AND the model is one we know can read them.
//
// Unknown models are treated as text-only ON PURPOSE. If a new vision model
// is not in the list yet, the user gets an accurate text description of the
// image (via the NVIDIA VLM fallback) instead of bytes the model silently
// ignores. That degrades gracefully; the opposite assumption produces the bug
// this module exists to prevent.

/**
 * Model-id fragments that indicate a genuinely multimodal model. Matched
 * case-insensitively as substrings against the full model id, so
 * "openai/gpt-oss-120b" and "google/gemini-2.0-flash" both work.
 *
 * Fragments are deliberately specific: a loose match like /gpt/ would classify
 * every GPT model as vision-capable, which is the failure we are fixing.
 */
const VISION_MODEL_FRAGMENTS: readonly string[] = [
  // Google
  "gemini-1.5", "gemini-2", "gemini-3", "gemini-pro-vision", "gemma-3",
  // OpenAI
  "gpt-4o", "gpt-4.1", "gpt-4.5", "gpt-5", "chatgpt-4o",
  // Anthropic
  "claude-3", "claude-4", "claude-sonnet", "claude-opus", "claude-haiku",
  // Meta
  "llama-3.2-11b-vision", "llama-3.2-90b-vision", "llama-4", "llama-4-scout",
  "llama-3.2-vision", "pixtral",
  // Qwen
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl", "qvq",
  // Mistral
  "mistral-small-3", "pixtral",  // Others
  "internvl", "phi-3.5-vision", "phi-4-multimodal", "smolvlm", "moondream",
  "grok-2-vision", "grok-vision", "kimi-vl", "glm-4v", "glm-4.1v", "minicpm-v",
  "deepseek-vl", "cogvlm", "aria", "step-2-vision",
];

/**
 * Text-only families that must never be treated as vision-capable even if a
 * loose fragment match would suggest otherwise. Defence in depth for the
 * "gpt-oss" case: `o4` would not match it, but a future fragment could.
 */
const KNOWN_TEXT_ONLY: readonly string[] = [
  "gpt-oss", "gpt-3.5", "gpt-4-", "gpt-3", "o1-", "o1-preview", "text-davinci",
  "llama-3.1-8b", "llama-3.1-70b", "llama-3.3-70b", "mistral-7b", "mixtral",
  // NOTE: do not add bare "qwen2.5-" / "qwen3-" here. They shadow the real
  // vision ids "qwen2.5-vl" / "qwen3-vl", and since KNOWN_TEXT_ONLY wins
  // outright, that silently downgraded a vision model to text-only. A
  // non-vision qwen simply matches no VISION_MODEL_FRAGMENTS and is already
  // treated as text-only.
  "deepseek-r1", "deepseek-v3",
];

/** True when this specific model id is one we know can read image parts. */
export function modelSupportsVision(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();

  // Explicit text-only families win outright.
  if (KNOWN_TEXT_ONLY.some((f) => id.includes(f))) return false;

  return VISION_MODEL_FRAGMENTS.some((f) => id.includes(f));
}

/**
 * The full decision: can we hand image parts to THIS provider running THIS
 * model? Both the transport and the model must agree.
 */
export function canSendImageParts(
  providerSupportsVision: boolean | undefined,
  modelId: string | undefined | null,
): boolean {
  return providerSupportsVision === true && modelSupportsVision(modelId);
}
