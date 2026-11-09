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
  parseJsonRequest,
} from "@/lib/chat-middleware";
import { sseTransform } from "@/lib/ai-providers";
import { isMockAiEnabled, createMockProviderStream, buildMockActivityReplyText } from "@/lib/mock-ai";
import { M3_TOOL_DEFINITIONS, LEAN_TOOL_DEFINITIONS } from "@/lib/tool-definitions";
import { buildSystemPrompt } from "@/lib/master-prompt";
import { buildMcpRoster, mcpPromptSection, toOpenAiFunctions, type BuilderTool } from "@/lib/mcp/tool-builder";
import { listSnapshotToolsByServer } from "@/lib/mcp/tool-snapshot";
import { refreshMissingSnapshots as refreshMissingMcpSnapshots } from "@/lib/mcp/roster-refresh";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";
import { routeToModel } from "@/lib/model-router";
import { resolveMaxOutputTokens, rejectsTemperature } from "@/lib/model-output-caps";
import {
  PLATFORM_PROMPT_BUDGET,
  promptTokens,
  trimMessagesToTokens,
  toolSchemaTokens,
} from "@/lib/prompt-budget";
import { estimateTokens } from "@/lib/token-budget";

import { preprocessMessages } from "@/lib/vision-preprocessor";
import { canSendImageParts } from "@/lib/vision-models";
import { recordProviderEvent } from "@/lib/provider-uptime";
import {
  contextWindowForModel,
  loadContextWindows,
} from "@/lib/model-context-windows";
import {
  isPayloadTooLargeError,
  providerFailureMessage,
} from "@/lib/provider-failure-policy";

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
      const mockText = request.headers.get("x-mock-ai-activity") === "1"
        ? buildMockActivityReplyText()
        : undefined;
      return new Response(sseTransform(createMockProviderStream(mockText)), {
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
    // parseJsonRequest turns a malformed body into an explicit 400 — an
    // unguarded request.json() throw would land in the generic 500 catch.
    const parsedBody = await parseJsonRequest(request);
    if (!parsedBody.ok) return parsedBody.response;
    const validated = validateRequestBody(parsedBody.data);
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
    // fixed-model providers (NVIDIA NIM) keep theirs and only match or
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
    const contextWindowFor = (id: string): number | undefined =>
      contextWindowForModel(contextWindows, id);

    // GLOBAL wall-clock budget for the whole provider retry ladder. Each
    // provider's attempt rung may spend up to fetchWithProviderRetry's own
    // deadline (default 180s @ 20 attempts with exponential backoff), but a
    // fallback sweep runs several providers + a lean retry each — the SUM has
    // to fit inside the route's ~300s function budget WITH room for the
    // streamed answer, or the function dies mid-flight and the response
    // breaks. Earlier providers get the most patience; late ones get quick
    // probes (deadlineMs floors at 5s), so the last fallback can still answer
    // on a fast key instead of being skipped entirely.
    const LADDER_BUDGET_MS = 150_000;
    const ladderBudgetEnd = Date.now() + LADDER_BUDGET_MS;
    const retryBudget = () => ({
      deadlineMs: Math.max(5_000, ladderBudgetEnd - Date.now()),
    });

    for (const provider of providerConfigs) {
      if (effort && effort !== "medium") {
        console.log(`[chat] effort=${effort} → ${provider.model}`);
      }
      // Round-trip clock for this attempt (telemetry) — loop-local so
      // concurrent requests never share it.
      const attemptT0 = Date.now();
      // Platform-budget guard (Groq removed 2026-11-09). Previously a
      // platform free tier's tight TPM cap forced a compact prompt + reduced
      // completion budget; no current lane has that cap, so the output budget
      // is per-model only.
      const onPlatformGroqBudget = false;
      // Output budget must fit the model ACTUALLY picked, not the effort tier.
      // Asking a 16k-output paid model for the premium tier's 65536 returns an
      // HTTP 400 outright — which is what made paid models look broken. Cap to
      // the model's real ceiling here, and let fetchWithProviderRetry learn the
      // exact number from the provider if we still guessed high.
      const tierMaxTokens = routingDecision.model.maxTokens;
      const maxCompletionTokens = resolveMaxOutputTokens(
        provider.model,
        onPlatformGroqBudget ? Math.min(2048, tierMaxTokens) : effort === "low" ? Math.min(4096, tierMaxTokens) : tierMaxTokens,
        contextWindowFor(provider.model)
      );
    // Per-attempt image gating. Routing picked ONE vision-capable provider, but
    // a failure can fall through the ladder to a text-only one (e.g. NVIDIA), which
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

    // ── ONE prompt, ONE roster, EVERY provider ──────────────────────────
    // This block used to branch on the provider name: NVIDIA got a
    // 605-char "compact" prompt AND a trimmed 29-tool roster that did not
    // include run_in_sandbox or verify_app. Same model, same app, different
    // agent — so on those lanes the agent literally could not reach the
    // sandbox or browser verification, and had no doctrine telling it to.
    // Payload size is decided up front from the provider's token budget (see
    // the PRE-FLIGHT SIZE GUARD below) and still re-tried lean if a provider
    // refuses the payload anyway. A hard per-minute cap makes a request that
    // exceeds the whole minute impossible, so the size has to be chosen before
    // sending, not learned from a 413.
    const systemPrompt = await buildSystemPrompt({
      mode,
      effort,
      profile: parsed.profile === "compact" ? "compact" : "full",
      capabilities: { browser: true },
      task: userPrompt,
      projectId: userId,
      userId,
      mcpSection,
    });

    // Ask mode is read-only, not tool-less: a summary of the user's project
    // cannot be written without reading the project. Reads and web search are
    // the whole surface; every mutating tool stays out (native-tools enforces
    // the same boundary server-side). Memory READS ride along so the AI can
    // actually use what it remembers in plain chat (write tools stay in
    // code/plan mode with the full doctrine).
    const ASK_TOOL_NAMES = ["read_file", "list_files", "search_code", "code_search", "web_search", "extract_archive", "memory_list", "memory_read", "playbook_search"];
    const askTools = M3_TOOL_DEFINITIONS.filter((t: any) => ASK_TOOL_NAMES.includes(t?.function?.name));

    const buildRequestBody = (
      prompt: string,
      tools: unknown[],
      messages: Array<{ role: string; content: unknown }> = attemptMessages,
    ): Record<string, unknown> => ({
      model: provider.model,
      messages: [
        { role: "system", content: prompt },
        ...messages,
      ],
      tools,
      tool_choice: "auto",
      max_completion_tokens: maxCompletionTokens,
      // Reasoning-family models (OpenAI o-series/gpt-5) reject a non-default
      // temperature and Claude 4.7+ rejects anything below 1 — both are hard
      // 400s. The tier's temperature (0.3/0.7/0.5) is tuned for the default
      // free model and must not be forced onto a paid pick.
      ...(rejectsTemperature(provider.model) ? {} : { temperature: routingDecision.model.temperature }),
      ...(effort && effort !== "medium" && /gpt-oss/i.test(provider.model)
        ? { reasoning_effort: effort }
        : {}),
      stream: true,
    });

    const fullTools = mode === "ask"
      ? askTools
      : [
          ...M3_TOOL_DEFINITIONS,
          ...toOpenAiFunctions([...mcpRoster.defs, ...mcpRoster.metaDefs]),
        ];

    // Compact prompt + lean roster, built at most once per request.
    let leanPayload: { prompt: string; tools: unknown[] } | null = null;
    const buildLeanPayload = async () => {
      if (!leanPayload) {
        const prompt = await buildSystemPrompt({
          mode,
          effort,
          profile: "compact",
          capabilities: { browser: true },
          projectId: userId,
          userId,
          mcpSection,
        });
        const tools = mode === "ask"
          ? askTools
          : [
              ...LEAN_TOOL_DEFINITIONS,
              ...toOpenAiFunctions([...mcpRoster.metaDefs]),
            ];
        leanPayload = { prompt, tools };
      }
      return leanPayload;
    };

    // PRE-FLIGHT SIZE GUARD (LIVE FAIL 2026-11-07): the platform Groq key is a
    // free tier with 8,000 tokens/MINUTE, while one full request measures
    // ~4,094 (master prompt) + ~10,378 (76-tool roster) ≈ 14.5k. Such a request
    // can never fit, and every refused attempt is charged against the same
    // minute — so retrying keeps failing. Measured on the live key: the full
    // payload answers 413 "Request too large ... TPM: Limit 8000, Requested
    // 13636", while the compact prompt + lean roster (4,228 tokens) answers
    // 200. Choose that profile before spending a request.
    let payloadPrompt = systemPrompt;
    let payloadTools: typeof fullTools = fullTools;
    let payloadMessages = attemptMessages;
    if (onPlatformGroqBudget) {
      const size = promptTokens({ system: systemPrompt, messages: attemptMessages, tools: fullTools });
      if (size > PLATFORM_PROMPT_BUDGET) {
        const lean = await buildLeanPayload();
        payloadPrompt = lean.prompt;
        payloadTools = lean.tools as typeof fullTools;
        payloadMessages = trimMessagesToTokens(
          attemptMessages,
          PLATFORM_PROMPT_BUDGET - estimateTokens(lean.prompt) - toolSchemaTokens(lean.tools),
        );
        console.log(
          `[chat] payload ${size} tokens > ${PLATFORM_PROMPT_BUDGET} platform budget — sending compact prompt + lean roster`,
        );
      }
    }

    const requestBody = buildRequestBody(payloadPrompt, payloadTools, payloadMessages);

      let result = await fetchWithProviderRetry(provider, requestBody, retryBudget());
      attemptsMade++;

      // Size recovery, triggered by an actual refusal instead of by provider
      // name: a hard tokens-per-minute cap answers a full-size request with
      // HTTP 413 ("request too large", "tokens per minute (TPM)"). Only then
      // do we retry THIS provider once with the compact prompt + lean roster,
      // so the identical request shape is the default everywhere.
      if (!result.ok && isPayloadTooLargeError(result.error)) {
        console.log(`[chat] ${provider.name} rejected payload size — retrying lean`);
        const lean = await buildLeanPayload();
        result = await fetchWithProviderRetry(
          provider,
          buildRequestBody(lean.prompt, lean.tools, trimMessagesToTokens(
            attemptMessages,
            PLATFORM_PROMPT_BUDGET - estimateTokens(lean.prompt) - toolSchemaTokens(lean.tools),
          )),
          retryBudget(),
        );
        attemptsMade++;
      }

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
      // 413 belongs here: after the lean retry above, a payload the provider
      // still refuses as too large is permanent for this model — "send again
      // in a minute" would be a lie.
      const message = providerFailureMessage(requestedModel ?? undefined, lastError);
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
