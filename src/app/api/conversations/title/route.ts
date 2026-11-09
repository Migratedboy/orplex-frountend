// title — POST { message } → { title } | { title: null }
//
// AI conversation title from the FIRST user prompt ("faster AI" lane: the
// same fastCompletion ladder the suggestion chips use). The client already
// saved a first-prompt-derived title synchronously; this refines it in the
// background. `title: null` = keep the existing one (degraded, never error).

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { fastCompletion, rankBySpeed, type FastProviderConfig } from "@/lib/fast-provider";
import { getProviderConfigs } from "@/lib/chat-middleware";

export const dynamic = "force-dynamic";

const MAX_PROMPT_CHARS = 600;
const MAX_TITLE_CHARS = 60;

const SYSTEM_PROMPT = `Name this conversation. Reply ONLY with JSON: {"title":"..."}. The title: 3-6 words, sentence case, describing what the FIRST message is about. A bare greeting becomes a topic title (e.g. "hi" → "Greeting"). No quotes inside the title, no markdown, no trailing period.`;

function parseTitle(raw: string | null): string | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const j = JSON.parse(candidate.slice(start, end + 1)) as { title?: unknown };
    if (typeof j.title !== "string") return null;
    const clean = j.title.replace(/[\s_]+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "").trim().slice(0, MAX_TITLE_CHARS);
    return clean || null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ title: null }, { status: 401 });
    }
    const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, MAX_PROMPT_CHARS) : "";
    if (!message) return Response.json({ title: null });

    let extras: FastProviderConfig[] = [];
    try {
      // Same lane the chat itself uses: re-point providers at the default
      // free model exactly like /api/chat does, instead of whichever
      // fallback model each provider happens to carry — the
      // "separate fast model" guess was why titles silently never landed.
      const configs = await getProviderConfigs(session.user.id, "openrouter/free");
      extras = rankBySpeed(
        configs
          .filter((c) => c.apiKey)
          .slice(0, 3)
          .map((c) => ({
            name: c.name,
            url: c.url,
            apiKey: c.apiKey,
            model: c.model,
            extraHeaders: c.extraHeaders,
            authStyle: c.authStyle,
          }))
      );
    } catch {
      // No DB lanes — fall back to env fast keys only.
    }

    // 256 tokens, not 48: reason-first models spend the budget on thinking
    // before content → empty content → null title. The JSON answer is
    // ~15 tokens; the rest is reasoning headroom.
    const raw = await fastCompletion(
      SYSTEM_PROMPT,
      [{ role: "user", content: message }],
      { maxTokens: 256, timeoutMs: 20_000, temperature: 0.4 },
      extras
    );
    return Response.json({ title: parseTitle(raw) });
  } catch {
    return Response.json({ title: null });
  }
}