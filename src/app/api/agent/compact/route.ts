import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sessionUserId } from "@/lib/server-session";
import { createProviderAdapter } from "@/lib/ai-providers";
import { compactTranscript, type SummarizeFn } from "@/lib/compaction";
import { resolveContextLimit } from "@/lib/context-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/compact — summarize older turns so the chat fits again.
 *
 * This is the SAME compactor the agent loops use (`compactTranscript`): the
 * last turns plus the newest block survive verbatim, everything older becomes
 * one `<context_so_far>` message, and the numbering/format matches what the
 * transcript renderer already knows how to draw. The route only supplies the
 * summary transport (the configured provider) and the budget (the model's
 * real window), and hands the rewritten transcript back to the caller to
 * persist — the client owns the conversation store, the server must not
 * rewrite history behind its back.
 */

const bodySchema = z.object({
  model: z.string().max(200).optional(),
  limit: z.number().min(1_000).max(4_000_000).optional(),
  keepRecent: z.number().min(1).max(60).optional().default(6),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string().max(500_000) }))
    .min(2)
    .max(1_000),
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
  const { messages, keepRecent } = parsed.data;

  const resolved = parsed.data.limit
    ? { limit: parsed.data.limit }
    : { limit: (await resolveContextLimit(parsed.data.model)).limit };

  // Summary transport: the same provider adapter the worker uses. One
  // non-streaming call with the compactor's prompt.
  const adapter = createProviderAdapter(parsed.data.model);
  const summarize: SummarizeFn = async (prompt: string, maxTokens: number) => {
    const text = await adapter.complete([
      { role: "user", content: prompt },
      {
        role: "user",
        content: `Keep the summary under ${maxTokens} tokens. Output only the summary block.`,
      },
    ]);
    return text ?? "";
  };

  const result = await compactTranscript(
    messages,
    resolved.limit,
    summarize,
    { keepRecent, summaryTokenCap: 700, triggerFraction: 0 },
  ).catch(() => null);

  if (!result) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Nothing to compact yet — the conversation is already within the model's window, or the summarizer is unavailable.",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    success: true,
    evictedCount: result.evictedCount,
    messages: result.messages,
    summary: result.newState.summary,
    limit: resolved.limit,
  });
}
