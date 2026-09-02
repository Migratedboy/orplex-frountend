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
          error: { message: "Too many requests. Wait a moment." },
        },
        { status: 429 },
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
): Promise<ProviderConfig[]> {
  const providers: ProviderConfig[] = [];

  // Priority 1: User's own API keys
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
          if (uk.provider === "openrouter") {
            providers.push({
              name: "openrouter-personal",
              url: "https://openrouter.ai/api/v1/chat/completions",
              apiKey: decrypted,
              model: uk.model || "minimax/minimax-m3:free",
            });
          } else if (uk.provider === "nvidia") {
            providers.push({
              name: "nvidia-personal",
              url: "https://integrate.api.nvidia.com/v1/chat/completions",
              apiKey: decrypted,
              model: uk.model || "openai/gpt-oss-120b",
            });
          }
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
      if (poolKey.provider === "openrouter") {
        providers.push({
          name: "openrouter-pool",
          url: "https://openrouter.ai/api/v1/chat/completions",
          apiKey: poolKey.apiKey,
          model: poolKey.model || "minimax/minimax-m3:free",
        });
      } else if (poolKey.provider === "nvidia") {
        providers.push({
          name: "nvidia-pool",
          url: "https://integrate.api.nvidia.com/v1/chat/completions",
          apiKey: poolKey.apiKey,
          model: poolKey.model || "openai/gpt-oss-120b",
        });
      }
    }
  } catch {
    /* provider unavailable */
  }

  // Priority 3: Environment variables
  const orKey = process.env.OPENROUTER_API_KEY || "";
  const orModel = process.env.OPENROUTER_MODEL || "minimax/minimax-m3:free";
  if (orKey && !providers.some((p) => p.name.includes("openrouter"))) {
    providers.push({
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: orKey,
      model: orModel,
    });
  }

  const nvKey = process.env.NVIDIA_API_KEY || "";
  const nvModel = process.env.NVIDIA_MODEL || "openai/gpt-oss-120b";
  if (nvKey && !providers.some((p) => p.name.includes("NVIDIA"))) {
    providers.push({
      name: "NVIDIA",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: nvKey,
      model: nvModel,
    });
  }

  return providers;
}

// ---------------------------------------------------------------------------
// Provider Fetch with Retry
// ---------------------------------------------------------------------------

export async function fetchWithProviderRetry(
  provider: ProviderConfig,
  requestBody: Record<string, unknown>,
): Promise<{ ok: true; stream: ReadableStream } | { ok: false; error: string }> {
  const maxAttempts = 3;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          ...provider.extraHeaders,
        },
        body: JSON.stringify(requestBody),
      });

      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfter = parseInt(
          res.headers.get("retry-after") || "60",
          10,
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        lastError = `${provider.name} HTTP ${res.status}: ${errText.slice(0, 200)}`;
        break;
      }

      if (!res.body) {
        lastError = `${provider.name}: empty response body`;
        break;
      }

      return { ok: true, stream: res.body };
    } catch (err) {
      lastError = `${provider.name}: ${(err as Error).message}`;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { ok: false, error: lastError };
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
