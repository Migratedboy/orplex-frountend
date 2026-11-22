import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sessionUserId } from "@/lib/server-session";
import { buildSystemPrompt } from "@/lib/master-prompt";
import { resolveContextLimit } from "@/lib/context-limit";
import { averageMessageTokens, readPromptUsage, scaleSegments, type ContextSegment } from "@/lib/context-usage";
import { estimateTokens } from "@/lib/token-budget";
import { messagesTokens, toolSchemaTokens } from "@/lib/prompt-budget";
import { buildMcpRoster, mcpPromptSection, toOpenAiFunctions, type BuilderTool } from "@/lib/mcp/tool-builder";
import { listSnapshotToolsByServer } from "@/lib/mcp/tool-snapshot";
import { refreshMissingSnapshots as refreshMissingMcpSnapshots } from "@/lib/mcp/roster-refresh";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";
import { getAgentRuntimeConfig } from "@orplex/sdk/lib/runtime-config";
import { LEAN_TOOL_DEFINITIONS, M3_TOOL_DEFINITIONS } from "@/lib/tool-definitions";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/context-usage — the numbers the context ring draws.
 *
 * Everything here is computed by the SAME builders /api/chat uses, so the
 * ring cannot drift from the request that is actually sent:
 *   system   → buildSystemPrompt() with the live mode/effort/profile + MCP section
 *   tools    → the same native + MCP roster, measured with toolSchemaTokens()
 *   files    → attachments / @mentions the composer is holding (sizes from the client)
 *   messages → the transcript, measured with messagesTokens()
 *
 * When the provider reported `prompt_tokens` for this conversation's previous
 * turn, that total wins and the four segments are scaled to it (`source` says
 * so). Otherwise the total is our estimate.
 */

const attachmentSchema = z.object({
  name: z.string().max(300).optional(),
  chars: z.number().min(0).max(2_000_000_000),
});

const bodySchema = z.object({
  conversationId: z.string().max(200).nullable().optional(),
  model: z.string().max(200).optional(),
  mode: z.enum(["ask", "plan", "code"]).optional().default("code"),
  effort: z.string().max(40).optional(),
  profile: z.enum(["full", "compact"]).optional().default("full"),
  messages: z
    .array(z.object({ role: z.string().max(40), content: z.string().max(500_000) }))
    .max(400)
    .optional()
    .default([]),
  draft: z.string().max(100_000).optional().default(""),
  attachments: z.array(attachmentSchema).max(100).optional().default([]),
  mentions: z.array(attachmentSchema).max(200).optional().default([]),
  mcpRemotes: z
    .array(
      z.object({
        id: z.string().max(200),
        label: z.string().max(200).optional(),
        url: z.string().max(2000).optional(),
        auth: z.enum(["oauth", "bearer", "none"]).optional(),
        tools: z
          .array(
            z.object({
              name: z.string().max(200),
              description: z.string().max(4000).optional(),
              inputSchema: z.unknown().optional(),
            })
          )
          .optional(),
      })
    )
    .max(40)
    .optional()
    .default([]),
});

export async function POST(request: NextRequest) {
  const userId = await sessionUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      { status: 400 }
    );
  }
  const body = parsed.data;
  const mode = body.mode;
  const profile = body.profile;

  // MCP roster — identical to the chat route's surface selection.
  await refreshMissingMcpSnapshots(userId).catch(() => {});
  const sdkTools = await listSnapshotToolsByServer(userId).catch(() => []);
  const legacyTools: BuilderTool[] = (body.mcpRemotes ?? []).flatMap((r) =>
    (r.tools ?? []).map((t) => ({
      server: r.id,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }))
  );
  const runtime = getAgentRuntimeConfig();
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  const query = body.draft.trim() || (typeof lastUser?.content === "string" ? lastUser.content : "");
  const mcpRoster = buildMcpRoster([...sdkTools, ...legacyTools], {
    serverMeta: Object.fromEntries(
      [...sdkTools, ...legacyTools].map((t) => [t.server, { label: getMcpCatalogEntry(t.server)?.name ?? t.server }])
    ),
    route: {
      enabled: runtime.enableDynamicToolRouting,
      max: runtime.maxActiveTools,
      pinned: runtime.pinnedTools,
      query,
    },
  });

  // Only the three real effort tiers reach the prompt builder ("High" from the
  // picker normalises to "high"); anything else means "model default".
  const effort = ((): "low" | "medium" | "high" | undefined => {
    const e = (body.effort ?? "").trim().toLowerCase();
    return e === "low" || e === "medium" || e === "high" ? e : undefined;
  })();

  const systemPrompt = await buildSystemPrompt({
    mode,
    effort,
    profile,
    capabilities: { browser: true },
    task: query || undefined,
    projectId: userId,
    userId,
    mcpSection: mcpPromptSection(mcpRoster),
  });

  // Ask mode ships the read-only subset; everything else ships the full native
  // roster plus the MCP surface (server defs when meta-tools are off).
  const ASK_TOOL_NAMES = ["read_file", "list_files", "search_code", "code_search", "web_search", "extract_archive", "memory_list", "memory_read", "playbook_search"];
  const askTools = M3_TOOL_DEFINITIONS.filter((t: { function?: { name?: string } }) => ASK_TOOL_NAMES.includes(t?.function?.name ?? ""));
  const nativeTools = mode === "ask" ? askTools : profile === "compact" ? LEAN_TOOL_DEFINITIONS : M3_TOOL_DEFINITIONS;
  const allTools =
    mode === "ask"
      ? nativeTools
      : [...nativeTools, ...toOpenAiFunctions([...mcpRoster.defs, ...mcpRoster.metaDefs])];

  const systemTokens = estimateTokens(systemPrompt);
  const toolTokens = toolSchemaTokens(allTools);

  // Files: attachments + @mentions, sized by the client (chars), converted with
  // the same chars→tokens arithmetic estimateTokens() uses (ceil(chars / 4)).
  const fileChars = [...body.attachments, ...body.mentions].reduce((s, f) => s + (f.chars || 0), 0);
  const fileTokens = fileChars > 0 ? Math.ceil(fileChars / 4) : 0;

  const transcript = body.draft.trim()
    ? [...body.messages, { role: "user", content: body.draft }]
    : body.messages;
  const messageTokens = messagesTokens(transcript);

  let segments: ContextSegment[] = [
    { key: "system", label: "System prompt", tokens: systemTokens },
    { key: "tools", label: "Tools", tokens: toolTokens },
    { key: "files", label: "Files", tokens: fileTokens },
    { key: "messages", label: "Messages", tokens: messageTokens },
  ];

  const reported = readPromptUsage(body.conversationId);
  const estimateTotal = segments.reduce((s, x) => s + x.tokens, 0);
  const useProvider = !!reported && reported.tokens > 0;
  if (useProvider) segments = scaleSegments(segments, reported!.tokens);

  const resolved = await resolveContextLimit(body.model, reported?.model ?? null);
  const total = segments.reduce((s, x) => s + x.tokens, 0);

  return NextResponse.json({
    success: true,
    usage: {
      limit: resolved.limit,
      limitEstimated: resolved.estimated,
      resolvedModel: resolved.resolvedModel,
      source: useProvider ? "provider" : "estimate",
      segments,
      total,
      estimateTotal,
      avgMessage: averageMessageTokens(transcript, estimateTokens),
      model: body.model ?? null,
    },
  });
}
