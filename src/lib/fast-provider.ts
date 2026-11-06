// fast-provider.ts — shared fast-completion provider for small side calls.
//
// The chat/fast route and other tiny completions (suggestion chips) both need
// "the fastest configured provider that actually answers without costing
// anything". This keeps that pick in ONE place: Groq first (gpt-oss-20b is
// the fastest live-verified model, sub-second, works on a free key), then
// NVIDIA NIM. The old OpenRouter 8b default 402s on a zero-credit key.
//
// LIVE-VALIDATED failure (2026-11-06): the suggestions lane ONLY looked at the
// env fast keys, and env keys go stale (all three of GROQ / NVIDIA /
// OPENROUTER in the dev .env answered 401 "Invalid API Key" while the user's
// in-app BYOK keys kept the chat working). fastCompletion used to return null
// on the FIRST provider's failure, so the feature silently degraded to static
// chips forever. The ladder below: every configured env fast provider is
// tried in order, then the CALLER's own provider configs (the user's working
// BYOK lanes), and a dead key can no longer kill the feature.

export interface FastProviderConfig {
  name: string;
  url: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  /** "x-api-key" providers (Anthropic-style) put the key in that header. */
  authStyle?: string;
}

/** All configured env fast providers, in try order. Empty = none configured. */
export function getFastProviders(): FastProviderConfig[] {
  const out: FastProviderConfig[] = [];
  const groqKey = process.env.GROQ_API_KEY || "";
  if (groqKey) {
    out.push({
      name: "Groq-Fast",
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: groqKey,
      model: process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b",
    });
  }
  const nvKey = process.env.NVIDIA_API_KEY || "";
  if (nvKey) {
    out.push({
      name: "NVIDIA-Fast",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: nvKey,
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
  }
  return out;
}

/** Back-compat: just the first candidate (or null). */
export function getFastProvider(): FastProviderConfig | null {
  return getFastProviders()[0] || null;
}

function authHeaders(p: FastProviderConfig): Record<string, string> {
  if (p.authStyle === "x-api-key") {
    return { "x-api-key": p.apiKey };
  }
  return { Authorization: `Bearer ${p.apiKey}` };
}

/**
 * One tiny non-streaming completion against ONE provider. Never throws —
 * callers get `null` on any failure (401, timeout, bad body) and move on.
 */
async function oneFastCall(
  provider: FastProviderConfig,
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number },
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15_000);
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(provider),
          ...(provider.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "system", content: system }, ...messages],
          max_completion_tokens: opts?.maxTokens ?? 256,
          temperature: opts?.temperature ?? 0.6,
          stream: false,
        }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = j?.choices?.[0]?.message?.content;
      return typeof content === "string" && content.trim() ? content : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Laddered fast completion: try each configured provider in order; the first
 * real answer wins. `extraConfigs` (the caller's own working lanes, e.g. the
 * user's BYOK providers) trail the env fast keys. All-dead → null + one warn,
 * so a silently-dead feature is diagnosable from the server log.
 */
export async function fastCompletion(
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number },
  extraConfigs?: FastProviderConfig[]
): Promise<string | null> {
  const candidates = [
    ...getFastProviders().filter((p) => p.apiKey),
    ...(extraConfigs || []).filter((p) => p.apiKey),
  ];
  for (const p of candidates) {
    const out = await oneFastCall(p, system, messages, opts);
    if (out !== null) return out;
  }
  if (candidates.length > 0) {
    console.warn("[fast-provider] no configured provider answered", {
      tried: candidates.map((p) => p.name),
    });
  }
  return null;
}
