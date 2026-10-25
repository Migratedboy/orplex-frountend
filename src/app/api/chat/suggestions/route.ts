// suggestions — POST { messages } → { suggestions: string[] }
//
// Short follow-up chips shown under the prompt bar after an assistant turn.
// The renderer keeps static utility chips whenever this answers !ok or fails
// — a dead provider degrades the feature, never the chat.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { fastCompletion } from "@/lib/fast-provider";

export const dynamic = "force-dynamic";

// Caps so a hostile/oversized payload can never turn into a big prompt spend.
const MAX_MESSAGES = 6;
const MAX_CHARACTERS = 600;
const MAX_SUGGESTIONS = 5;
const MAX_SUGGESTION_LENGTH = 80;

const SYSTEM_PROMPT = `Suggest follow-up prompts the user might send next in this conversation. Reply ONLY with JSON: {"suggestions":["...","...","..."]}. Each suggestion: 3-8 words, concrete, phrased as the user would type it. No numbering, no quotes inside items, no markdown code fences.`;

function parseSuggestions(raw: string | null): string[] {
  if (!raw) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const j = JSON.parse(candidate.slice(start, end + 1)) as { suggestions?: unknown };
    return Array.isArray(j.suggestions) ? j.suggestions : [];
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ success: false, error: { message: "Authentication required" } }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as
      | { messages?: unknown }
      | null;
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const messages = rawMessages
      .filter((m): m is { role: "user" | "assistant"; content: string } => {
        const rec = m as { role?: unknown; content?: unknown };
        return (
          (rec?.role === "user" || rec?.role === "assistant") && typeof rec?.content === "string" && rec.content.trim().length > 0
        );
      })
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARACTERS) }));

    // Nothing to anchor on → nothing to suggest. Empty (not error): the
    // renderer keeps its static chips either way.
    if (messages.length === 0) return Response.json({ suggestions: [] });

    const raw = await fastCompletion(SYSTEM_PROMPT, messages, { maxTokens: 160, temperature: 0.7, timeoutMs: 10_000 });
    const suggestions = parseSuggestions(raw)
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim().slice(0, MAX_SUGGESTION_LENGTH));
    const clean = [...new Map(suggestions.map((s) => [s.toLowerCase(), s])).values()].slice(0, MAX_SUGGESTIONS);

    return Response.json({ suggestions: clean });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("[chat/suggestions] failed:", msg.slice(0, 160));
    return Response.json(
      { success: false, error: { message: msg } },
      { status: 500 }
    );
  }
}
