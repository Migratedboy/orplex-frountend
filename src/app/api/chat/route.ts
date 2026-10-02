import { NextRequest } from "next/server";
import {
  requireAuth,
  enforceBurstLimit,
  enforceDailyQuota,
  validateRequestBody,
  getProviderConfigs,
  fetchWithProviderRetry,
  prependStatusMessage,
  buildMultipartMessages,
  modelVariants,
  watchMidStreamFailure,
  sseNoticeChunk,
} from "@/lib/chat-middleware";
import { sseTransform } from "@/lib/ai-providers";
import { isMockAiEnabled, createMockProviderStream } from "@/lib/mock-ai";
import { M3_TOOL_DEFINITIONS, GROQ_TOOL_DEFINITIONS } from "@/lib/tool-definitions";
import { buildSystemPrompt } from "@/lib/master-prompt";
import { routeToModel } from "@/lib/model-router";
import { preprocessMessages } from "@/lib/vision-preprocessor";
import { recordProviderEvent } from "@/lib/provider-uptime";

export async function POST(request: NextRequest) {
  try {
    // --- Step 1: Authentication ---
    const auth = await requireAuth();
    if (!auth.ok) return auth.response;
    const { userId } = auth;

    // --- Dev/test keyless mock provider (MOCK_AI=1, non-production only) ---
    // Short-circuits before burst/quota counting (mock traffic is not real
    // usage) and before provider selection, answering every request with a
    // slow deterministic fake stream. See src/lib/mock-ai.ts.
    if (isMockAiEnabled(request.headers)) {
      return new Response(sseTransform(createMockProviderStream()), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // --- Step 2: Burst rate limit ---
    const burst = await enforceBurstLimit(userId);
    if (!burst.ok) return burst.response;

    // --- Step 3: Validate request body BEFORE the daily quota ---
    // A malformed body (400) must never consume the user's daily request:
    // the quota increment happens inside enforceDailyQuota, so validating
    // first means only requests that actually reach a provider count.
    const body = await request.json();
    const validated = validateRequestBody(body);
    if (!validated.ok) return validated.response;
    const { data: parsed } = validated;

    // --- Step 4: Daily quota ---
    const quota = await enforceDailyQuota(userId);
    if (!quota.ok) return quota.response;

    const mode = parsed.mode || "ask";

    // --- Step 5: Build messages (with vision preprocessing) ---
    const topLevelImages = parsed.images || [];
    const rawMessages = parsed.messages.map((m) => ({
      role: m.role,
      content: m.content,
      images: m.images,
    }));

    const multimodalMessages = buildMultipartMessages(
      rawMessages as any,
      topLevelImages,
    );

    const userPrompt = parsed.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");

    const { messages: processedMessages, hadImages } = await preprocessMessages(
      multimodalMessages as any,
      userPrompt,
    );

    // --- Step 6: Route to optimal model ---
    const routingDecision = routeToModel(
      userPrompt,
      parsed.messages.map((m) => ({ role: m.role, content: m.content })),
      mode === "ask" ? 1 : undefined,
    );

    // --- Step 7: Select providers and fetch stream ---
    // The prompt-bar choice rides along: OpenRouter providers are re-pointed
    // at the requested model inside getProviderConfigs (any id works there);
    // fixed-model providers (Groq, NVIDIA NIM) keep theirs and only match or
    // not below. Absent choice → unchanged auto-routing.
    const requestedModel = parsed.model?.trim();
    const providerConfigs = await getProviderConfigs(userId, requestedModel || undefined);

    if (requestedModel) {
      // Accept the requested id in any sibling form (bare ↔ `:free`) — the
      // ladder includes fallback aliases so a paid slug out of credits can
      // still reach the model's free variant on the same provider.
      const acceptable = new Set(modelVariants(requestedModel));
      const matching = providerConfigs.filter((p) => acceptable.has(p.model));
      if (matching.length === 0) {
        console.warn(
          `[chat] requested model "${requestedModel}" has no available provider ` +
          `(configured: ${providerConfigs.map((p) => `${p.name}:${p.model}`).join(", ") || "none"})`
        );
        return Response.json(
          {
            success: false,
            error: {
              message: `The selected model (${requestedModel}) is not available right now. Pick another model or try again later.`,
            },
          },
          { status: 503 },
        );
      }
      providerConfigs.length = 0;
      providerConfigs.push(...matching);
    }

    // For complex tasks, prioritize premium providers
    if (routingDecision.tier === 3 && providerConfigs.length > 0) {
      const premiumProvider = providerConfigs.find(
        (p) => p.model.includes("claude") || p.model.includes("sonnet"),
      );
      if (premiumProvider) {
        providerConfigs.unshift(premiumProvider);
      }
    }

    let stream: ReadableStream | null = null;
    let lastError = "";
    let attemptsMade = 0;

    // Reasoning effort from the prompt bar (low/medium/high). Medium is the
    // model default — only sent for models that support reasoning_effort.
    const effort = parsed.effort;

    for (const provider of providerConfigs) {
      if (effort && effort !== "medium") {
        console.log(`[chat] effort=${effort} → ${provider.model}`);
      }
      // Round-trip clock for this attempt (telemetry) — loop-local so
      // concurrent requests never share it.
      const attemptT0 = Date.now();
      // Groq's free tier enforces a tight tokens-per-minute cap per model
      // (~8k TPM); the full master prompt + tool definitions alone exceed it
      // and every request dies with HTTP 413. The compact profile + reduced
      // completion budget fits comfortably under the cap.
      const isGroq = provider.name.toLowerCase().includes("groq");
      const requestBody = {
        model: provider.model,
        messages: [
          {
            role: "system",
            // The Master Prompt: one composed source of truth per mode —
            // full doctrine on turn 1, compact on repair/continue turns
            // (profile arrives from the worker via the request body).
            content: buildSystemPrompt({
              mode,
              effort,
              profile: isGroq ? "compact" : parsed.profile === "compact" ? "compact" : "full",
              capabilities: { browser: true },
            }),
          },
          ...processedMessages,
        ],
        ...(mode === "ask"
          ? {}
          : { tools: isGroq ? GROQ_TOOL_DEFINITIONS : M3_TOOL_DEFINITIONS, tool_choice: "auto" }),
        max_completion_tokens: isGroq
          ? Math.min(2048, routingDecision.model.maxTokens)
          : effort === "low"
            ? Math.min(4096, routingDecision.model.maxTokens)
            : routingDecision.model.maxTokens,
        temperature: routingDecision.model.temperature,
        ...(effort && effort !== "medium" && /gpt-oss/i.test(provider.model)
          ? { reasoning_effort: effort }
          : {}),
        stream: true,
      };

      const result = await fetchWithProviderRetry(provider, requestBody);
      attemptsMade++;
      if (result.ok) {
        // Uptime telemetry: the provider answered (HTTP ok + healthy peek).
        recordProviderEvent({
          userId,
          lane: "chat",
          provider: provider.name,
          model: provider.model,
          ok: true,
          latencyMs: Date.now() - attemptT0,
        });
        // Watch for MID-STREAM failure (in-stream error objects / degenerate
        // floods beyond the peek window). On failure the watcher replaces the
        // stream with an honest notice so the bubble is never left empty.
        stream = watchMidStreamFailure(provider.name, result.stream);
        break;
      }
      // Uptime telemetry: every attempted-and-failed provider feeds the
      // reliability view (the classifier buckets rate limits, auth, …).
      recordProviderEvent({
        userId,
        lane: "chat",
        provider: provider.name,
        model: provider.model,
        ok: false,
        errorMessage: result.error,
        latencyMs: Date.now() - attemptT0,
      });
      lastError = result.error;
      console.warn(`[chat] provider "${provider.name}" failed: ${result.error}`);
    }

    if (!stream) {
      // No provider served the request. When at least one real provider was
      // ATTEMPTED, return an SSE stream carrying an honest notice instead of
      // a 503: the client's stream reader treats non-2xx as a thrown error
      // ("Fast answer failed: HTTP 503"), which historically left the chat
      // bubble empty with the spinner running. A notice stream renders as
      // text in the bubble and ends cleanly.
      const message = requestedModel
        ? `The selected model (${requestedModel}) is not responding right now — it may still be warming up on its provider. Send again in a minute or pick another model.`
        : "All AI providers are currently unavailable. Please try again.";
      if (attemptsMade > 0) {
        console.warn(`[chat] all providers failed for "${requestedModel || "auto"}" — returning notice stream: ${lastError}`);
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(sseNoticeChunk(`*${message}*\n`));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
        );
      }
      // Nothing was attempted (config error) — a real error is correct.
      return Response.json(
        {
          success: false,
          error: { message },
        },
        { status: 503 },
      );
    }

    // --- Step 8: Prepend vision status if images were processed ---
    if (hadImages) {
      stream = prependStatusMessage(
        stream,
        "Image analyzed. Building response...\n\n",
      );
    }

    // --- Step 9: Return SSE stream ---
    return new Response(sseTransform(stream), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    return Response.json(
      {
        success: false,
        error: { message: msg || "An unexpected error occurred." },
      },
      { status: 500 },
    );
  }
}
