// fast-provider.ts — shared fast-completion provider for small side calls.
//
// The chat/fast route and other tiny completions (suggestion chips) both need
// "the fastest configured provider that actually answers without costing
// anything". This keeps that pick in ONE place: OpenRouter free router
// first (always available, free key), then NVIDIA NIM. Groq was removed
// (2026-11-09) — its fast lane is gone; OpenRouter free is the replacement.
//
// LIVE-VALIDATED failure (2026-11-06): the suggestions lane ONLY looked at the
// env fast keys, and env keys go stale (NVIDIA / OPENROUTER in the dev .env
// answered 401 "Invalid API Key" while the user's in-app BYOK keys kept the
// chat working). fastCompletion used to return null on the FIRST provider's
// failure, so the feature silently degraded to static chips forever. The
// ladder below: every configured env fast provider is tried in order, then
// the CALLER's own provider configs (the user's working BYOK lanes), and a
// dead key can no longer kill the feature.

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
  const orKey = process.env.OPENROUTER_API_KEY || "";
  if (orKey) {
    out.push({
      name: "OpenRouter-Fast",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: orKey,
      model: "openrouter/free",
      extraHeaders: { "HTTP-Referer": "https://orplex.tech", "X-Title": "Orplex" },
    });
  }
  const nvKey = process.env.NVIDIA_API_KEY || "";
  if (nvKey) {
    out.push({
      name: "NVIDIA-Fast",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: nvKey,
      model: "minimaxai/minimax-m3.1-flash",
    });
  }
  return out;
}

/** Back-compat: just the first candidate (or null). */
export function getFastProvider(): FastProviderConfig | null {
  return getFastProviders()[0] || null;
}

// Speed hints for the LADDER's fallback order. When the env fast keys are
// dead and the caller's own lanes trail in, the chips must still snap:
// a flash-class model (Gemini Flash, GPT-oss-20b, nemotron-flash…) answers a
// 160-token call in under a second, while a heavyweight reasoning model can
// take 10s+ — long enough that the user starts typing before the chips show.
const FAST_MODEL_HINT =
  /(flash|flash.?lite|instant|\bmini\b|nano|\blite\b|small|\b8b\b|\b3b\b|\b7b\b|oss-20b|haiku|turbo|nemotron)/i;
const FAST_ENDPOINT_HINT = /(openrouter|cerebras|fireworks|sambanova|nvidia|together)/i;

function speedScore(p: FastProviderConfig): number {
  const hay = `${p.name || ""} ${p.model || ""} ${p.url || ""}`;
  let score = 0;
  if (FAST_MODEL_HINT.test(hay)) score += 2;
  if (FAST_ENDPOINT_HINT.test(hay)) score += 1;
  return score;
}

/** Stable-reorder: fast-model candidates first (equal scores keep order). */
export function rankBySpeed(candidates: FastProviderConfig[]): FastProviderConfig[] {
  return candidates
    .map((c, i) => ({ c, i, s: speedScore(c) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.c);
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
 * Laddered fast completion. PRIORITY RULE: the CALLER'S OWN lanes (the user's
 * in-app BYOK keys) lead whenever they exist — the app's built-in env fast
 * keys are the FALLBACK for users who never configured their own. First real
 * answer wins. All-dead → null + one warn, so a silently-dead feature is
 * diagnosable from the server log.
 */
export async function fastCompletion(
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts?: { maxTokens?: number; timeoutMs?: number; temperature?: number },
  extraConfigs?: FastProviderConfig[]
): Promise<string | null> {
  const userLanes = rankBySpeed((extraConfigs || []).filter((p) => p.apiKey));
  const envFast = getFastProviders().filter((p) => p.apiKey);
  // User's own keys first (flash-ranked); env built-ins only when the user
  // has no lanes at all, or as a fallback after every user lane failed.
  const candidates = userLanes.length > 0 ? [...userLanes, ...envFast] : envFast;
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
