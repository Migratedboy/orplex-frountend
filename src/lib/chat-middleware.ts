/**
 * chat-middleware.ts — Composable middleware for the chat API route.
 *
 * Each middleware is a standalone function that either returns an error Response
 * or passes control to the next step. This replaces the monolithic route handler
 * with a clear, testable pipeline.
 */

import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { chatMessageSchema, sanitizeChatMessage, detectPromptInjection } from "@/lib/validators";
import {
  checkBurstLimit,
  checkUserQuota,
  incrementUserQuota,
} from "@/lib/rate-limiter";
import { prisma } from "@/lib/prisma";
import type { ChatMessageInput } from "@/lib/validators";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthResult {
  userId: string;
}

export interface ValidatedRequest {
  data: ChatMessageInput;
  userId: string;
}

export interface ProviderConfig {
  name: string;
  url: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Middleware: Authentication
// ---------------------------------------------------------------------------

export async function requireAuth(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return {
      ok: false,
      response: Response.json(
        {
          success: false,
          error: { message: "Authentication required" },
        },
        { status: 401 },
      ),
    };
  }
  return { ok: true, userId: session.user.id };
}

// ---------------------------------------------------------------------------
// Middleware: Burst Rate Limit (per-minute, in-memory)
// ---------------------------------------------------------------------------

export async function enforceBurstLimit(
  userId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const allowed = await checkBurstLimit(userId);
  if (!allowed) {
    return {
      ok: false,
      response: Response.json(
        {
          success: false,
          error: { message: "Too many requests. Try again in about a minute." },
        },
        {
          status: 429,
          headers: { "Retry-After": "60" },
        },
      ),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Middleware: Daily Quota (database-backed)
// ---------------------------------------------------------------------------

export async function enforceDailyQuota(
  userId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  // Users with personal API keys bypass the daily quota
  let hasPersonalKey = false;
  try {
    const userKeys = await prisma.userApiKey.findMany({
      where: { userId, isActive: true },
    });
    hasPersonalKey = userKeys.length > 0;
  } catch {
    // If the query fails, fall through to check quota normally
  }

  if (hasPersonalKey) {
    return { ok: true };
  }

  const quota = await prisma.userQuota.findUnique({
    where: { userId },
  });
  const quotaCheck = checkUserQuota(userId, quota || undefined);

  if (!quotaCheck.allowed) {
    return {
      ok: false,
      response: Response.json(
        {
          success: false,
          error: {
            message: `Daily limit reached (${quotaCheck.limit} requests). Add your own API key in Settings for unlimited access.`,
          },
        },
        { status: 429 },
      ),
    };
  }

  await incrementUserQuota(userId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Middleware: Request Validation
// ---------------------------------------------------------------------------

export function validateRequestBody(
  body: unknown,
):
  | { ok: true; data: ChatMessageInput; userId: string }
  | { ok: false; response: Response } {
  const parsed = chatMessageSchema.safeParse(body);
  if (!parsed.success) {
    const errMsg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    return {
      ok: false,
      response: Response.json(
        {
          success: false,
          error: { message: `Invalid request: ${errMsg}` },
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data, userId: "" };
}

// ---------------------------------------------------------------------------
// Middleware: Input Sanitization & Prompt Injection Detection
// ---------------------------------------------------------------------------

/**
 * Sanitize all user messages and flag prompt injection attempts.
 * Injection attempts are logged but not blocked — the LLM system prompt
 * should handle them. This middleware just ensures clean input reaches the LLM.
 */
export function sanitizeAndValidateInput(
  data: ChatMessageInput,
): { ok: true; data: ChatMessageInput } | { ok: false; response: Response } {
  const sanitizedMessages = data.messages.map((msg) => {
    if (msg.role === "user") {
      const cleanContent = sanitizeChatMessage(msg.content);

      // Log injection attempts for monitoring (don't block — let the system prompt handle it)
      if (detectPromptInjection(cleanContent)) {
        console.warn(
          "[chat-middleware] Potential prompt injection detected:",
          cleanContent.slice(0, 100),
        );
        // Could send to error-tracking here:
        // reportMessage("Prompt injection attempt", "warning", { content: cleanContent.slice(0, 200) });
      }

      return { ...msg, content: cleanContent };
    }
    return msg;
  });

  return {
    ok: true,
    data: { ...data, messages: sanitizedMessages },
  };
}

// ---------------------------------------------------------------------------
// Provider Selection
// ---------------------------------------------------------------------------

export async function getProviderConfigs(
  userId?: string,
  /** Model id picked in the prompt bar. OpenRouter keys can serve any model
   *  id (their `model` field is only a default), so openrouter providers are
   *  re-pointed at the requested model; fixed-model providers (Groq, NVIDIA
   *  NIM) keep their own and simply match or not downstream. */
  requestedModel?: string,
): Promise<ProviderConfig[]> {
  const providers: ProviderConfig[] = [];

  // Registry-driven config builder. Every registry provider is
  // OpenAI-compatible for chat (Anthropic via its documented compat endpoint),
  // so one shape serves all; per-provider extras (OpenRouter attribution
  // headers) ride along. MODEL env overrides keep working per provider id.
  const { getProviderDef } = await import("@/lib/provider-registry");
  const configFor = (
    providerId: string,
    apiKey: string,
    model: string | undefined,
    name: string
  ): ProviderConfig | null => {
    const def = getProviderDef(providerId);
    if (!def) return null;
    const envModel = process.env[`${providerId.toUpperCase()}_MODEL`];
    return {
      name,
      url: `${def.baseUrl}/chat/completions`,
      apiKey,
      model: model || envModel || def.fallbackModel,
      ...(def.extraHeaders || def.authStyle === "x-api-key"
        ? { extraHeaders: { ...(def.extraHeaders ?? {}) } }
        : {}),
    };
  };

  // Priority 1: User's own API keys (any registry provider)
  if (userId) {
    try {
      const { prisma } = await import("@/lib/prisma");
      const { decryptKey } = await import("@/lib/key-encryption");
      const userKeys = await prisma.userApiKey.findMany({
        where: { userId, isActive: true },
      });
      for (const uk of userKeys) {
        try {
          const decrypted = decryptKey(uk.apiKey);
          const cfg = configFor(uk.provider, decrypted, uk.model || undefined, `${uk.provider}-personal`);
          if (cfg) providers.push(cfg);
        } catch {
          /* provider unavailable */
        }
      }
    } catch {
      /* provider unavailable */
    }
  }

  // Priority 2: Platform key pool
  try {
    const { getAvailableKey } = await import("@/lib/key-pool");
    const poolKey = await getAvailableKey();
    if (poolKey) {
      const cfg = configFor(poolKey.provider, poolKey.apiKey, poolKey.model || undefined, `${poolKey.provider}-pool`);
      if (cfg) providers.push(cfg);
    }
  } catch {
    /* provider unavailable */
  }

  // Priority 3: Environment variables, in registry display order. A provider
  // whose key already appeared (personal/pool) is skipped — dedupe by
  // provider id prefix of the config name (`<id>-personal` / `<id>-pool`).
  const { listProviderDefs } = await import("@/lib/provider-registry");
  for (const def of listProviderDefs()) {
    const envKey = process.env[def.keyEnvVar] || "";
    if (!envKey) continue;
    if (providers.some((p) => p.name === `${def.id}-personal` || p.name === `${def.id}-pool`)) continue;
    const cfg = configFor(def.id, envKey, undefined, def.label);
    if (cfg) providers.push(cfg);
  }

  // Prompt-bar model selection: all three providers are OpenAI-compatible
  // endpoints where the key serves the provider's whole catalog — the `model`
  // field is per-request. Re-point EVERY provider at the requested id, then
  // add sibling-form fallbacks (`id` ↔ `id:free`) after the home attempts, so
  // a paid slug with no credits falls through to its free variant and an
  // OpenRouter-only listing of an NVIDIA-hosted id still reaches NVIDIA.
  // Providers that don't host an id just fail fast (~100ms) and the ladder
  // moves on — exactly what the per-attempt retry loop is for.
  if (requestedModel && providers.length > 0) {
    const variants = modelVariants(requestedModel);
    const [primary, ...fallbacks] = variants;
    for (const p of providers) p.model = primary;
    for (const alt of fallbacks) {
      for (const base of [...providers]) {
        const alias: ProviderConfig = { ...base, model: alt };
        if (!providers.some((p) => p.name === alias.name && p.model === alias.model)) {
          providers.push(alias);
        }
      }
    }
  }

  return providers;
}

/** Sibling ids to try for a requested model: `x:free` ↔ `x`. OpenRouter lists
 *  free tiers under a `:free` suffix while NVIDIA/Groq host the bare id, and
 *  vice versa — trying both forms on every provider is what makes a picker
 *  entry answer even when its home route is out of credits or quota. */
export function modelVariants(id: string): string[] {
  const trimmed = (id || "").trim();
  if (!trimmed) return [];
  const variants = [trimmed];
  if (trimmed.endsWith(":free")) {
    const bare = trimmed.slice(0, ":free".length * -1);
    if (bare && !variants.includes(bare)) variants.push(bare);
  } else {
    variants.push(`${trimmed}:free`);
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Provider Fetch with Retry
// ---------------------------------------------------------------------------

export async function fetchWithProviderRetry(
  provider: ProviderConfig,
  requestBody: Record<string, unknown>,
): Promise<{ ok: true; stream: ReadableStream } | { ok: false; error: string }> {
  const maxAttempts = 4;
  // Global ceiling for this provider's attempt-ladder: even with retries and
  // backoff, one provider must never eat more than ~75s — the next provider
  // (or the 503 to the client) has to stay reachable.
  const deadline = Date.now() + 75_000;
  let lastError = "";
  let body = requestBody;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) {
      lastError = lastError || `${provider.name}: attempt budget exhausted`;
      break;
    }
    try {
      // Cap each attempt: a provider that accepts the connection but never
      // responds must fail over to the next attempt/provider instead of
      // hanging the whole /api/chat route (and the client stream) forever.
      const res = await fetch(provider.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          ...provider.extraHeaders,
        },
        body: JSON.stringify(body),
        // Per-attempt cap shrinks as the ladder's global deadline approaches:
        // a hung provider must fail over fast enough that the next provider
        // (or the client) isn't left waiting minutes.
        signal: AbortSignal.timeout(Math.max(5_000, deadline - Date.now())),
      });

      // Auth rejection is terminal for THIS key: retrying cannot help. Report
      // immediately so the provider ladder moves to the next provider.
      if (res.status === 401 || res.status === 403) {
        lastError = `${provider.name}: key rejected (HTTP ${res.status})`;
        break;
      }

      // 429: rate limit (backoff). 5xx: upstream/up-provider failure — the
      // next attempt (or auto-router upstream) usually succeeds, so retry.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        // Free-tier providers send retry-after up to 60s; honoring it fully
        // can stall a chat for minutes. Cap the wait and fail over quickly.
        const retryAfter = Math.min(
          parseInt(res.headers.get("retry-after") || "3", 10),
          10,
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        // Self-heal: small-context models (e.g. Groq allam-2-7b @ 4096)
        // reject our default completion budget outright and name the cap in
        // the error. Retry immediately with the provider's own limit.
        const cap = errText.match(
          /max_completion_tokens`?\s+must be less than or equal to\s+`?(\d+)/i,
        );
        if (cap) {
          body = { ...body, max_completion_tokens: Number(cap[1]) };
          continue;
        }
        lastError = `${provider.name} HTTP ${res.status}: ${errText.slice(0, 200)}`;
        break;
      }

      if (!res.body) {
        lastError = `${provider.name}: empty response body`;
        break;
      }

      return okStreamPeeked(provider.name, res.body);
    } catch (err) {
      lastError = `${provider.name}: ${(err as Error).message}`;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Inspect the first bytes of an SSE body before committing to it.
 *
 * Some providers (NVIDIA NIM) answer HTTP 200 and put the real failure
 * INSIDE the stream — `data: {"error":{"message":"ResourceExhausted: worker
 * limit..."}}` followed by `[DONE]`. Serving that to the client means an
 * instantly-empty chat message. Peeking lets the ladder fail over to the
 * next provider instead; a healthy first chunk is re-attached so nothing
 * is lost.
 */
async function okStreamPeeked(
  providerName: string,
  upstream: ReadableStream<Uint8Array>,
): Promise<{ ok: true; stream: ReadableStream } | { ok: false; error: string }> {
  const reader = upstream.getReader();
  const first = await reader.read();
  if (first.done || !first.value) {
    return { ok: false, error: `${providerName}: empty response body` };
  }
  const head = new TextDecoder().decode(first.value);
  const errLine = head.split("\n").find((l) => l.startsWith("data:"));
  if (errLine) {
    try {
      const payload = JSON.parse(errLine.slice(5).trim()) as { error?: { message?: string } };
      if (payload && typeof payload === "object" && "error" in payload) {
        const msg = payload.error?.message ?? JSON.stringify(payload.error);
        return {
          ok: false,
          error: `${providerName} in-stream error: ${String(msg).slice(0, 180)}`,
        };
      }
    } catch {
      // Not JSON (chunk may be split mid-line, or a plain delta) — healthy.
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(first.value);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
  return { ok: true, stream };
}

// ---------------------------------------------------------------------------
// Stream Helpers
// ---------------------------------------------------------------------------

export function prependStatusMessage(
  stream: ReadableStream,
  message: string,
): ReadableStream {
  const encoder = new TextEncoder();
  const statusChunk = encoder.encode(
    `data: ${JSON.stringify({ content: message })}\n\n`,
  );
  const originalStream = stream;

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(statusChunk);
      const reader = originalStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // Stream ended
      } finally {
        controller.close();
      }
    },
  });
}

export function buildMultipartMessages(
  rawMessages: Array<{ role: string; content: string }>,
  topLevelImages: string[],
): Array<{
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}> {
  return rawMessages.map((m, idx) => {
    const msgImages =
      (m as any).images ||
      (idx === 0 && m.role === "user" ? topLevelImages : []);
    if (msgImages && msgImages.length > 0) {
      const contentParts: Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }> = [{ type: "text", text: m.content }];
      for (const img of msgImages) {
        const dataUrl = img.startsWith("data:")
          ? img
          : `data:image/png;base64,${img}`;
        contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
      }
      return { role: m.role, content: contentParts as any };
    }
    return { role: m.role, content: m.content };
  });
}
