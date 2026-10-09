import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Strip internal display markers from message content for list previews:
 * [THINKING]…[/THINKING] reasoning blocks, [OK]/[FAIL]/[BLOCKED]/[SUCCESS]
 * status lines, and leftover tool tags. Falls back to the first non-empty
 * line when stripping empties everything (e.g. thinking-only messages).
 */
function cleanSnippet(content: string | null | undefined): string {
  if (!content) return "";
  let text = content
    .replace(/\[THINKING\][\s\S]*?(\[\/THINKING\]|$)/gi, " ")
    .replace(/^\[(?:OK|FAIL|BLOCKED|SUCCESS|ERROR)\][^\n]*$/gim, " ")
    .replace(/<\/?tool_(?:call|result)[^>]*>[\s\S]*?(?:<\/tool_(?:call|result)>|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    text = content.replace(/\[(?:THINKING|\/THINKING)\]/gi, "").replace(/\s+/g, " ").trim();
  }
  return text;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ conversations: [], conversation: null });

    const id = request.nextUrl.searchParams.get("id");

    if (id) {
      // Single conversation: one query
      const conversation = await prisma.conversation.findFirst({
        where: { id, userId: session.user.id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      return NextResponse.json({ conversation });
    }

    // Single efficient query: list conversations with only the latest message snippet.
    // Previously this also fetched the full latest conversation (all messages), which
    // was unused by the UI and caused unnecessary DB load on every page navigation.
    const conversations = await prisma.conversation.findMany({
      where: { userId: session.user.id },
      include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
    });

    // Clean the preview snippet so raw [THINKING]/status markers never leak
    // into the history page or sidebar lists.
    const cleaned = conversations.map((c) => ({
      ...c,
      messages: c.messages?.map((m) => ({ ...m, content: cleanSnippet(m.content) })) ?? [],
    }));

    return NextResponse.json({ conversations: cleaned });
  } catch (error) {
    console.error("[Conversations GET] Error:", error);
    return NextResponse.json({ conversations: [], conversation: null });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const conversationId = typeof (body as { conversationId?: unknown }).conversationId === "string"
      ? (body as { conversationId?: string }).conversationId as string
      : undefined;
    const rawMessages = Array.isArray((body as { messages?: unknown }).messages)
      ? (body as { messages?: unknown }).messages as Array<{ role?: unknown; content?: unknown }>
      : [];

    // Workspace folder the thread belongs to (open folder's NAME). Sanitized:
    // null/undefined/empty → null (Ungrouped), capped length, trimmed.
    const rawWorkspace = typeof (body as { workspaceName?: unknown }).workspaceName === "string"
      ? ((body as { workspaceName?: string }).workspaceName as string).trim()
      : "";
    const workspaceName = rawWorkspace ? rawWorkspace.slice(0, 120) : null;

    if (rawMessages.length === 0) {
      return NextResponse.json({ error: "Messages required" }, { status: 400 });
    }
    if (rawMessages.length > 200) {
      return NextResponse.json({ error: "Too many messages (max 200)" }, { status: 400 });
    }
    // Role allowlist + per-message caps: raw roles/content flow straight
    // into Message rows — unbounded input is DB bloat.
    const messages = rawMessages.map((m) => ({
      role: m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user",
      content: typeof m.content === "string" ? m.content.slice(0, 50_000) : "",
    }));

    // Guard against FK violations from stale JWTs: a session token minted
    // before a DB reset can carry a userId that no longer exists. Upsert the
    // user first so Conversation.userId always has a matching row.
    try {
      await prisma.user.upsert({
        where: { id: session.user.id },
        update: {},
        create: {
          id: session.user.id,
          email: session.user.email || `${session.user.id}@orplex.local`,
          name: session.user.name || "User",
        },
      });
    } catch {
      // If the upsert fails (e.g. email conflict), the create below will
      // surface the real error.
    }

    let conv;
    if (conversationId) {
      // NOTE: where must be unique — (id, userId) is not. Gate ownership
      // first, then update by id (same pattern as PATCH /conversations/[id]).
      const owned = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: session.user.id },
        select: { id: true },
      });
      if (!owned) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
      conv = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          messages: { create: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })) },
          // Keep the workspace tag fresh when provided (a thread opened with
          // no folder later would send null — don't wipe an existing tag then).
          ...(body.workspaceName !== undefined ? { workspaceName } : {}),
          updatedAt: new Date(),
        },
      });
    } else {
      const firstUserMsg = messages.find((m: { role: string }) => m.role === "user");
      const title = firstUserMsg?.content?.slice(0, 60) || "New Chat";
      conv = await prisma.conversation.create({
        data: {
          title,
          userId: session.user.id,
          workspaceName,
          messages: { create: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })) },
        },
      });
    }

    return NextResponse.json({ conversationId: conv.id, success: true });
  } catch (error) {
    console.error("[Conversations POST] Error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
