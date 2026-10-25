// fast-provider.ts — shared fast-completion provider for small side calls.
//
// The chat/fast route and other tiny completions (suggestion chips) both need
// "the fastest configured provider that actually answers without costing
// anything". This keeps that pick in ONE place: Groq first (gpt-oss-20b is
// the fastest live-verified model, sub-second, works on a free key), then
// NVIDIA NIM. The old OpenRouter 8b default 402s on a zero-credit key.

export interface FastProviderConfig {
  name: string;
  url: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
}

export function getFastProvider(): FastProviderConfig | null {
  const groqKey = process.env.GROQ_API_KEY || "";
  if (groqKey) {
    return {
      name: "Groq-Fast",
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: groqKey,
      model: process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b",
    };
  }
  const nvKey = process.env.NVIDIA_API_KEY || "";
  if (nvKey) {
    return {
      name: "NVIDIA-Fast",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: nvKey,
      model: "nvidia/nemotron-3-super-120b-a12b",
    };
  }
  return null;
}

/**
 * One tiny non-streaming completion. Never throws — callers get `null` on any
 * failure so side features degrade silently (suggestion chips fall back to
 * static ones; nothing user-visible depends on the provider answering).
 */
export async function fastCompletion(
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number },
): Promise<string | null> {
  const provider = getFastProvider();
  if (!provider) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15_000);
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          ...provider.extraHeaders,
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
