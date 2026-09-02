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
} from "@/lib/chat-middleware";
import { sseTransform } from "@/lib/ai-providers";
import { M3_TOOL_DEFINITIONS, M3_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT } from "@/lib/tool-definitions";
import { routeToModel } from "@/lib/model-router";
import { preprocessMessages } from "@/lib/vision-preprocessor";

export async function POST(request: NextRequest) {
  try {
    // --- Step 1: Authentication ---
    const auth = await requireAuth();
    if (!auth.ok) return auth.response;
    const { userId } = auth;

    // --- Step 2: Burst rate limit ---
    const burst = await enforceBurstLimit(userId);
    if (!burst.ok) return burst.response;

    // --- Step 3: Daily quota ---
    const quota = await enforceDailyQuota(userId);
    if (!quota.ok) return quota.response;

    // --- Step 4: Validate request body ---
    const body = await request.json();
    const validated = validateRequestBody(body);
    if (!validated.ok) return validated.response;
    const { data: parsed } = validated;

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
    const providerConfigs = await getProviderConfigs(userId);

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

    for (const provider of providerConfigs) {
      const requestBody = {
        model: provider.model,
        messages: [
          {
            role: "system",
            content: mode === "ask" ? ASK_SYSTEM_PROMPT : M3_SYSTEM_PROMPT,
          },
          ...processedMessages,
        ],
        ...(mode === "ask"
          ? {}
          : { tools: M3_TOOL_DEFINITIONS, tool_choice: "auto" }),
        max_completion_tokens: routingDecision.model.maxTokens,
        temperature: routingDecision.model.temperature,
        stream: true,
      };

      const result = await fetchWithProviderRetry(provider, requestBody);
      if (result.ok) {
        stream = result.stream;
        break;
      }
      lastError = result.error;
    }

    if (!stream) {
      return Response.json(
        {
          success: false,
          error: {
            message:
              "All AI providers are currently unavailable. Please try again.",
          },
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
