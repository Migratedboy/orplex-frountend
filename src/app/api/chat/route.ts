import { NextRequest } from "next/server";
import {
  requireAuth,
  enforceBurstLimit,
  enforceDailyQuota,
  validateRequestBody,
  sanitizeAndValidateInput,
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
import { M3_TOOL_DEFINITIONS, GROQ_TOOL_DEFINITIONS, usesCompactTools } from "@/lib/tool-definitions";
import { buildSystemPrompt } from "@/lib/master-prompt";
import { buildMcpRoster, mcpPromptSection, toOpenAiFunctions, type BuilderTool } from "@/lib/mcp/tool-builder";
import { listSnapshotToolsByServer } from "@/lib/mcp/tool-snapshot";
import { refreshMissingSnapshots as refreshMissingMcpSnapshots } from "@/lib/mcp/roster-refresh";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";
import { routeToModel } from "@/lib/model-router";
import { resolveMaxOutputTokens, rejectsTemperature } from "@/lib/model-output-caps";
import { getVerifiedModels } from "@/lib/model-catalog";
import { preprocessMessages } from "@/lib/vision-preprocessor";
import { canSendImageParts } from "@/lib/vision-models";
import { recordProviderEvent } from "@/lib/provider-uptime";

/** Strip an OpenRouter-style namespace: "openai/gpt-4o" -> "gpt-4o". */
function bareModelId(id: string): string {
  const s = (id || "").trim();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Model id -> context window, from the (cached) verified catalog.
 *
 * Best-effort by design: the catalog answers from memory/disk cache instantly
 * and a cold cache simply yields an empty map, which makes
 * resolveMaxOutputTokens fall back to its safe default. This must never throw
 * — it runs on the hot chat path.
 */
async function loadContextWindows(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { models } = await getVerifiedModels({ background: true });
    for (const m of models) {
      const ctx = (m as { contextWindow?: number }).contextWindow;
      if (typeof ctx === "number" && ctx > 0) {
        map.set(m.id, ctx);
        const bare = bareModelId(m.id);
        if (bare && !map.has(bare)) map.set(bare, ctx);
      }
    }
  } catch {
    /* catalog unavailable — safe default applies */
  }
  return map;
}

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
    // Sanitize user messages + log prompt-injection attempts (never blocks).
    const sanitized = sanitizeAndValidateInput(validated.data);
    if (!sanitized.ok) return sanitized.response;
    const { data: parsed } = sanitized;

    // --- Step 4: Daily quota ---
    const quota = await enforceDailyQuota(userId);
    if (!quota.ok) return quota.response;

    const mode = parsed.mode || "ask";

    // Phase 5 (C5) + Phase 9 self-heal: one snapshot-based MCP roster for both
    // surfaces — the system-prompt section and the tools array. Trigger discovery
    // for any connected server whose snapshot hasn't been written yet, so a
    // just-connected server's tools are visible on the very next turn (not "next
    // fetch"). Errors swallowed — an unreachable server is not a chat failure.
    await refreshMissingMcpSnapshots(userId).catch(() => {});
    const sdkTools = await listSnapshotToolsByServer(userId).catch(() => []);
    // Legacy-lane remotes (localStorage client) are sent by the worker in the
    // request body so the server-side prompt can include them. The legacy lane
    // dispatches through the in-process client (findRemote + withConnection) but
    // needs the prompt to tell the model the tools exist. Merge both stores so
    // the model sees every connected server regardless of lane.
    const legacyTools: BuilderTool[] = (parsed.mcpRemotes ?? []).flatMap((r) =>
      (r.tools ?? []).map((t) => ({
        server: r.id,
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      }))
    );
    const mcpRoster = buildMcpRoster([...sdkTools, ...legacyTools], {
      serverMeta: Object.fromEntries(
        [...sdkTools, ...legacyTools]
          .map((t) => [t.server, { label: getMcpCatalogEntry(t.server)?.name ?? t.server }])
      ),
    });
    const mcpSection = mcpPromptSection(mcpRoster);

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

// Vision preprocessing is DEFERRED until after routing (below) — whether the
// target model accepts image parts is only known once a provider is chosen,
// and describing images as text before that would strip them from a vision
// model entirely.

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
        // MOVE, don't copy: `find` returns a reference into the same array, so a
        // plain unshift left the identical config at BOTH index 0 and its
        // original index — a transient failure then paid for the same premium
        // model twice.
        providerConfigs.splice(providerConfigs.indexOf(premiumProvider), 1);
        providerConfigs.unshift(premiumProvider);
      }
  }

  // --- Step 6b: Vision preprocessing (needs the routed provider) ---
  // A vision-capable provider (OpenRouter → Gemini/Claude/GPT-4o, NVIDIA VLM)
  // receives the image parts untouched, so it gets real image tokens. Anything
  // else falls back to describing each image via the NVIDIA vision model.
  // The provider flag alone is NOT enough. OpenRouter sets supportsVision=true
// because it can proxy vision models, so picking a TEXT-ONLY model
// (openai/gpt-oss-120b) with an OpenRouter key forwarded raw image_url parts
// to a model that cannot decode them, while the UI announced "Image
// analyzed." Both the transport AND the model must agree.
const routedSupportsVision = canSendImageParts(
  providerConfigs[0]?.supportsVision,
  providerConfigs[0]?.model,
);
  const {
    messages: processedMessages,
    hadImages,
    analyzedImages,
    failedImages,
  } = await preprocessMessages(
    multimodalMessages as any,
    userPrompt,
    routedSupportsVision,
  );

  let stream: ReadableStream | null = null;
    let lastError = "";
    let attemptsMade = 0;

    // Reasoning effort from the prompt bar (low/medium/high). Medium is the
    // model default — only sent for models that support reasoning_effort.
    const effort = parsed.effort;

    // Context windows (best-effort, ONCE per request) so the output budget can
    // be clamped to something the model can actually hold. Any failure here is
    // non-fatal: resolveMaxOutputTokens just falls back to its safe default.
    const contextWindows = await loadContextWindows();
    const contextWindowForModel = (id: string): number | undefined =>
      contextWindows.get((id || "").trim()) ?? contextWindows.get(bareModelId(id));

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
      // The 2048-token ceiling exists to fit the PLATFORM's shared Groq TPM
      // budget. A user paying Groq with their OWN key is not consuming that
      // budget, so starving them to 2048 was silently crippling a paid model.
      // Compact prompt + compact tools stay for every Groq lane (a smaller
      // payload only helps), but the output cap is per-payer.
      const onPlatformGroqBudget = isGroq && provider.lane !== "personal";
      // Output budget must fit the model ACTUALLY picked, not the effort tier.
      // Asking a 16k-output paid model for the premium tier's 65536 returns an
      // HTTP 400 outright — which is what made paid models look broken. Cap to
      // the model's real ceiling here, and let fetchWithProviderRetry learn the
      // exact number from the provider if we still guessed high.
      const tierMaxTokens = routingDecision.model.maxTokens;
      const maxCompletionTokens = resolveMaxOutputTokens(
        provider.model,
        onPlatformGroqBudget ? Math.min(2048, tierMaxTokens) : effort === "low" ? Math.min(4096, tierMaxTokens) : tierMaxTokens,
        contextWindowForModel(provider.model)
      );
    // Per-attempt image gating. Routing picked ONE vision-capable provider, but
    // a failure can fall through the ladder to a text-only one (Groq), which
    // rejects a multimodal body outright. The adapter's flattening safety net
    // does not apply here because this loop builds the payload itself, so strip
    // the image parts for any non-vision attempt.
    const attemptMessages = canSendImageParts(provider.supportsVision, provider.model)
      ? processedMessages
      : processedMessages.map((m: any) =>
          Array.isArray(m.content)
            ? {
                ...m,
                content: m.content
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text ?? "")
                  .join("\n"),
              }
            : m
        );

    const requestBody = {
      model: provider.model,
      messages: [
        {
          role: "system",
            // The Master Prompt: one composed source of truth per mode —
            // full doctrine on turn 1, compact on repair/continue turns
            // (profile arrives from the worker via the request body).
            content: await buildSystemPrompt({
              mode,
              effort,
              profile: isGroq ? "compact" : parsed.profile === "compact" ? "compact" : "full",
              capabilities: { browser: true },
              task: userPrompt,
              projectId: userId,
              mcpSection,
            }),
          },
          ...attemptMessages,
        ],
        ...(mode === "ask"
          ? {}
          : {
              tools: [
                ...(usesCompactTools(provider.name) ? GROQ_TOOL_DEFINITIONS : M3_TOOL_DEFINITIONS),
                // Compact-tools providers (Groq's TPM cap) skip MCP schemas —
                // the roster still rides in the prompt section for discovery.
                ...toOpenAiFunctions(
                  usesCompactTools(provider.name)
                    ? [...mcpRoster.metaDefs]
                    : [...mcpRoster.defs, ...mcpRoster.metaDefs]
                ),
              ],
              tool_choice: "auto",
            }),
        max_completion_tokens: maxCompletionTokens,
        // Reasoning-family models (OpenAI o-series/gpt-5) reject a non-default
        // temperature and Claude 4.7+ rejects anything below 1 — both are hard
        // 400s. The tier's temperature (0.3/0.7/0.5) is tuned for the default
        // Groq free model and must not be forced onto a paid pick.
        ...(rejectsTemperature(provider.model) ? {} : { temperature: routingDecision.model.temperature }),
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
// A 400 is PERMANENT — a bad parameter, bad model id or rejected tool schema
      // will never "warm up". Telling the user to retry made a deterministic
      // failure read as a transient outage, which is exactly how the
      // temperature/max_tokens bugs above got mis-diagnosed for so long.
      const permanentRejection = /\bHTTP 4(00|01|03|04|22)\b/.test(lastError);
      const message = requestedModel
        ? permanentRejection
          ? `The selected model (${requestedModel}) rejected the request — it is not a problem that will fix itself. Try a different model.`
          : `The selected model (${requestedModel}) is not responding right now - it may still be warming up on its provider. Send again in a minute or pick another model.`
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
  // Distinguish "the model looked at your image" from "a vision model
  // described your image for it". When the routed model is text-only the
  // image is still processed, via the NVIDIA VLM, but the model never saw
  // it — saying "Image analyzed." there overstated what happened.
  if (hadImages && analyzedImages > 0) {
    const seenNatively = routedSupportsVision;
    stream = prependStatusMessage(
      stream,
      (failedImages > 0
        ? `Analyzed ${analyzedImages} of ${analyzedImages + failedImages} image(s). ${failedImages} could not be processed.\n\n`
        : seenNatively
          ? "Image analyzed. Building response...\n\n"
          : "Image described. Building response...\n\n"),
    );
  } else if (hadImages && failedImages > 0) {
    stream = prependStatusMessage(
      stream,
      `Could not analyze ${failedImages} image(s) — image analysis is unavailable on this server.\n\n`,
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
