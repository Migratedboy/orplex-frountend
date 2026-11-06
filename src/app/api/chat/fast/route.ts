import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { sseTransform } from "@/lib/ai-providers";
import { getFastProviders, type FastProviderConfig } from "@/lib/fast-provider";
import { getProviderConfigs } from "@/lib/chat-middleware";

const FAST_SYSTEM_PROMPT = `You are a fast, concise assistant. Answer the user's question directly and briefly. No tools, no code blocks unless asked. Keep responses under 200 words.`;

/**
 * Fast-lane candidates: env fast keys first, then the CALLER's own configured
 * providers (BYOK). LIVE failure 2026-11-06: every env key in the dev .env
 * answered 401 while the user's in-app keys kept the chat alive — a single
 * dead env key used to kill the fast lane entirely. Ladder order fixes that.
 */
async function fastCandidates(userId: string): Promise<FastProviderConfig[]> {
  const envFast = getFastProviders().filter((p) => p.apiKey);
  let extras: FastProviderConfig[] = [];
  try {
    const configs = await getProviderConfigs(userId);
    extras = configs
      .filter((c) => c.apiKey)
      .slice(0, 3)
      .map((c) => ({
        name: c.name,
        url: c.url,
        apiKey: c.apiKey,
        model: c.model,
        extraHeaders: c.extraHeaders,
        authStyle: c.authStyle,
      }));
  } catch {
    /* user lane unavailable — env-only ladder */
  }
  return [...envFast, ...extras];
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "Authentication required" } }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body?.messages || !Array.isArray(body.messages)) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "Invalid request" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const candidates = await fastCandidates(session.user.id);
    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: { message: "No AI provider configured" } }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    // Ladder: the first provider whose STREAM starts ok wins. A dead key
    // (401) fails fast before any bytes flow, so the next candidate runs.
    let warnings: string[] = [];
    for (const provider of candidates) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.authStyle === "x-api-key") headers["x-api-key"] = provider.apiKey;
      else headers.Authorization = `Bearer ${provider.apiKey}`;
      Object.assign(headers, provider.extraHeaders || {});
      const res = await fetch(provider.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "system", content: FAST_SYSTEM_PROMPT }, ...body.messages],
          max_completion_tokens: 512,
          temperature: 0.5,
          stream: true,
        }),
      }).catch((err: unknown) => {
        warnings.push(`${provider.name}: ${(err as Error)?.message || "network error"}`);
        return null;
      });
      if (!res) continue;
      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        // Surface the provider's own message (quota exhausted, model EOL…) —
        // the bare status code left "Fast answer failed: HTTP 502" with no
        // hint at the actual cause.
        console.warn(`[chat/fast] ${provider.name} HTTP ${res.status}: ${errText.slice(0, 200)}`);
        warnings.push(`${provider.name}: HTTP ${res.status}`);
        continue;
      }
      if (!res.body) {
        warnings.push(`${provider.name}: no response body`);
        continue;
      }
      return new Response(sseTransform(res.body), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }
    const tried = candidates.map((c) => c.name).join(", ");
    const detail = warnings.length ? ` (${warnings.join("; ").slice(0, 300)})` : "";
    return new Response(
      JSON.stringify({ success: false, error: { message: `Fast model unavailable — tried: ${tried}${detail}` } }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ success: false, error: { message: msg } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
