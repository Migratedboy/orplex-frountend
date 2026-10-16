// provider-registry.ts — Single source of truth for every AI provider the
// app can serve chat from. Settings, the prompt-bar picker, model listing
// (`/v1/models` discovery) and the executor's failover chain all read from
// here, so adding a provider is a one-entry change.
//
// Every provider is OpenAI-compatible for CHAT (that's how the existing
// pipeline stays unchanged) — including Anthropic, whose documented
// OpenAI-compat endpoint (`/v1/chat/completions` with a Bearer key) proxies
// the Messages API. Model LISTING differs per provider and is covered by
// `authStyle` + `listPath` + `extraHeaders`:
//   - "bearer":    `Authorization: Bearer <key>` (OpenAI style)
//   - "x-api-key": `x-api-key: <key>` + `extraHeaders` (Anthropic style)

export type ProviderAuthStyle = "bearer" | "x-api-key";

export interface ProviderDef {
  id: string;
  label: string;
  /** One-liner shown in the Settings provider grid. */
  tagline: string;
  /** OpenAI-compatible chat-completions base (no trailing slash). */
  baseUrl: string;
  authStyle: ProviderAuthStyle;
  /**
   * Provider accepts OpenAI-style multimodal `image_url` parts on its chat
   * endpoint. When true the chat lane forwards attachments as real image
   * tokens; when false/absent the NVIDIA vision model describes them instead.
   */
  supportsVision?: boolean;
  /** Env var holding a PLATFORM key for this provider (failover/sweeps). */
  keyEnvVar: string;
  /** Extra headers for listing (and chat where the provider demands it). */
  extraHeaders?: Record<string, string>;
  /** Advisory key prefix — a mismatch is a warning, never a rejection. */
  keyPrefix?: string;
  /** Where the user signs up for a key. */
  keyHintUrl: string;
  /** Model used when a key is stored without a specific model. */
  fallbackModel: string;
  /** Has a usable free tier (drives the Free/Pay badge). */
  free?: boolean;
  /**
   * Path for model listing, relative to baseUrl's origin+version root.
   * Defaults to "/models". Anthropic lists at /v1/models natively.
   */
  listPath?: string;
  /** Per-provider probe pacing for sweeps (ms between probe starts). */
  probeSpacingMs?: number;
  /**
   * Hard ceiling on how many ids model-listing keeps. Defaults to a generous
   * DoS backstop (2000) — set it only for a provider whose catalogue is
   * genuinely enormous. Never set this low enough to hide models from the user.
   */
  modelsCap?: number;
  /**
   * How many listing pages to follow when the provider paginates. Default 1
   * (most providers return the whole catalogue in one response).
   */
  maxListPages?: number;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "groq",
    label: "Groq",
    tagline: "Blazing LPU inference, generous free tier",
    baseUrl: "https://api.groq.com/openai/v1",
    authStyle: "bearer",
    keyEnvVar: "GROQ_API_KEY",
    keyPrefix: "gsk_",
    keyHintUrl: "https://console.groq.com/keys",
    fallbackModel: "openai/gpt-oss-120b",
    free: true,
    probeSpacingMs: 1_500,
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    tagline: "Free tier, no credit card needed",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authStyle: "bearer",
    // NIM serves VLM checkpoints on the OpenAI-compatible multimodal shape.
    supportsVision: true,
    keyEnvVar: "NVIDIA_API_KEY",
    keyPrefix: "nvapi-",
    keyHintUrl: "https://build.nvidia.com",
    fallbackModel: "nvidia/nemotron-3-super-120b-a12b",
    free: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    tagline: "Every model behind one key, pay-per-use",
    baseUrl: "https://openrouter.ai/api/v1",
    authStyle: "bearer",
    // OpenRouter proxies Gemini / Claude / GPT-4o vision and accepts image parts.
    supportsVision: true,
    keyEnvVar: "OPENROUTER_API_KEY",
    keyPrefix: "sk-or-",
    keyHintUrl: "https://openrouter.ai/settings/keys",
    fallbackModel: "qwen/qwen3.8-27b:free",
    extraHeaders: { "HTTP-Referer": "https://orplex.tech", "X-Title": "Orplex" },
    // OpenRouter was the ONLY provider without spacing, so its models were
    // swept in a 6-wide burst against a free tier with a very low RPM ceiling
    // — a self-inflicted rate-limit storm. Space it like Groq.
    probeSpacingMs: 1_500,
    // OpenRouter aggregates 400+ models (paid AND :free). Never cap it low —
    // that is what used to hide free models from the picker.
    modelsCap: 2000,
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    tagline: "Claude Sonnet & Opus — premium coding quality",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "x-api-key",
    keyEnvVar: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    keyHintUrl: "https://console.anthropic.com/settings/keys",
    fallbackModel: "claude-sonnet-4-20250514",
    // Native Messages-style auth: listing (and any non-compat path) needs
    // x-api-key + the version header. Chat rides the OpenAI-compat endpoint.
    extraHeaders: { "anthropic-version": "2023-06-01" },
    listPath: "/models",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    tagline: "Free tier available, huge context windows",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authStyle: "bearer",
    keyEnvVar: "GEMINI_API_KEY",
    keyPrefix: "AIza",
    keyHintUrl: "https://aistudio.google.com/app/apikey",
    fallbackModel: "gemini-2.0-flash",
    free: true,
  },
  {
    id: "mistral",
    label: "Mistral AI",
    tagline: "European models, free experiment tier",
    baseUrl: "https://api.mistral.ai/v1",
    authStyle: "bearer",
    keyEnvVar: "MISTRAL_API_KEY",
    keyHintUrl: "https://console.mistral.ai/api-keys",
    fallbackModel: "mistral-large-latest",
    free: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    tagline: "Frontier reasoning at commodity prices",
    baseUrl: "https://api.deepseek.com/v1",
    authStyle: "bearer",
    keyEnvVar: "DEEPSEEK_API_KEY",
    keyPrefix: "sk-",
    keyHintUrl: "https://platform.deepseek.com/api_keys",
    fallbackModel: "deepseek-chat",
  },
  {
    id: "together",
    label: "Together AI",
    tagline: "Open models, fast serving, free credits",
    baseUrl: "https://api.together.xyz/v1",
    authStyle: "bearer",
    keyEnvVar: "TOGETHER_API_KEY",
    keyHintUrl: "https://api.together.xyz/settings/api-keys",
    fallbackModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    free: true,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    tagline: "Grok models, real-time knowledge",
    baseUrl: "https://api.x.ai/v1",
    authStyle: "bearer",
    keyEnvVar: "XAI_API_KEY",
    keyPrefix: "xai-",
    keyHintUrl: "https://console.x.ai",
    fallbackModel: "grok-3",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    tagline: "Wafer-scale speed, free tier",
    baseUrl: "https://api.cerebras.ai/v1",
    authStyle: "bearer",
    keyEnvVar: "CEREBRAS_API_KEY",
    keyPrefix: "csk-",
    keyHintUrl: "https://cloud.cerebras.ai",
    fallbackModel: "llama-3.3-70b",
    free: true,
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    tagline: "Production-grade open-model serving",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authStyle: "bearer",
    keyEnvVar: "FIREWORKS_API_KEY",
    keyHintUrl: "https://fireworks.ai/account/api-keys",
    fallbackModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  },
  {
    id: "openai",
    label: "OpenAI",
    tagline: "GPT models, pay-per-use",
    baseUrl: "https://api.openai.com/v1",
    authStyle: "bearer",
    keyEnvVar: "OPENAI_API_KEY",
    keyPrefix: "sk-",
    keyHintUrl: "https://platform.openai.com/api-keys",
    fallbackModel: "gpt-4o-mini",
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProviderDef(id: string): ProviderDef | undefined {
  return byId.get(id);
}

export function listProviderIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

export function providerLabel(id: string): string {
  return byId.get(id)?.label ?? id;
}

/** All defs, in curated display order. */
export function listProviderDefs(): ProviderDef[] {
  return [...PROVIDERS];
}

/**
 * Map of failover-chain name → key env var, derived from the registry.
 * `custom` keeps its historical entry: AI_PROVIDER=custom/AI_API_KEY is a
 * pre-registry escape hatch (arbitrary OpenAI-compatible base) that the
 * registry cannot express.
 */
export function failoverKeyEnvMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of PROVIDERS) map[p.id] = p.keyEnvVar;
  map.custom = "AI_API_KEY";
  return map;
}
